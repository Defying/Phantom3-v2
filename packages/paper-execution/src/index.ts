import { randomUUID } from 'node:crypto';
import {
  LEDGER_EPSILON,
  JsonlLedger,
  approvedTradeIntentSchema,
  applyFillToPosition,
  getOpenOrders,
  paperQuoteSchema,
  positionKeyFor,
  type ApprovedTradeIntent,
  type FillRecordedEvent,
  type LedgerEnvelope,
  type LiquidityRole,
  type OrderStatus,
  type OrderUpdatedEvent,
  type PaperLedgerEvent,
  type PaperQuote,
  type PositionUpdatedEvent,
  type ProjectedOrder
} from '../../ledger/src/index.js';

export type PaperExecutionAdapterOptions = {
  maxQuoteAgeMs?: number;
  feeRateBps?: number;
  allowPartialFills?: boolean;
  liquidityRole?: LiquidityRole;
  clock?: () => Date;
  idFactory?: () => string;
};

export type SubmitApprovedIntentInput = {
  intent: ApprovedTradeIntent;
  quote?: PaperQuote;
};

export type PaperExecutionResult = {
  orderId: string;
  status: OrderStatus;
  filledQuantity: number;
  remainingQuantity: number;
  envelopes: LedgerEnvelope[];
  orderEvent: OrderUpdatedEvent;
  fillEvent?: FillRecordedEvent;
  positionEvent?: PositionUpdatedEvent;
};

export type PaperReconciliationResult = {
  quote: PaperQuote;
  envelopes: LedgerEnvelope[];
  filledOrderIds: string[];
  skippedReason?: string;
};

const DEFAULTS = {
  maxQuoteAgeMs: 15_000,
  feeRateBps: 0,
  allowPartialFills: true,
  liquidityRole: 'taker' as LiquidityRole
};

export class PaperExecutionAdapter {
  private readonly maxQuoteAgeMs: number;
  private readonly feeRateBps: number;
  private readonly allowPartialFills: boolean;
  private readonly liquidityRole: LiquidityRole;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly ledger: JsonlLedger,
    options: PaperExecutionAdapterOptions = {}
  ) {
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? DEFAULTS.maxQuoteAgeMs;
    this.feeRateBps = options.feeRateBps ?? DEFAULTS.feeRateBps;
    this.allowPartialFills = options.allowPartialFills ?? DEFAULTS.allowPartialFills;
    this.liquidityRole = options.liquidityRole ?? DEFAULTS.liquidityRole;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;

    if (!Number.isFinite(this.maxQuoteAgeMs) || this.maxQuoteAgeMs < 0) {
      throw new Error(`PaperExecutionAdapter maxQuoteAgeMs must be >= 0, received ${this.maxQuoteAgeMs}.`);
    }
    if (!Number.isFinite(this.feeRateBps) || this.feeRateBps < 0) {
      throw new Error(`PaperExecutionAdapter feeRateBps must be >= 0, received ${this.feeRateBps}.`);
    }
  }

  async submitApprovedIntent(input: SubmitApprovedIntentInput): Promise<PaperExecutionResult> {
    const intent = approvedTradeIntentSchema.parse(input.intent);
    const quote = input.quote ? paperQuoteSchema.parse(input.quote) : undefined;
    if (quote) {
      this.assertQuoteMatchesIntent(intent, quote);
    }

    const projection = await this.ledger.readProjection();
    if (projection.intents.has(intent.intentId)) {
      throw new Error(`Intent ${intent.intentId} already exists in the ledger.`);
    }

    const orderId = this.makeId('ord');
    const now = this.nowIso();
    const intentEvent: PaperLedgerEvent = {
      kind: 'intent.approved',
      eventId: this.makeId('evt'),
      recordedAt: intent.approvedAt ?? now,
      sessionId: intent.sessionId,
      executionMode: 'paper',
      marketId: intent.marketId,
      tokenId: intent.tokenId,
      intentId: intent.intentId,
      strategyId: intent.strategyId,
      side: intent.side,
      limitPrice: intent.limitPrice,
      quantity: intent.quantity,
      thesis: intent.thesis,
      confidence: intent.confidence,
      metadata: intent.metadata
    };

    const events: PaperLedgerEvent[] = [intentEvent];

    const reservedSellQuantity = this.getReservedSellQuantity(projection, intent.marketId, intent.tokenId);
    const position = projection.positions.get(positionKeyFor(intent.marketId, intent.tokenId));
    const availableToSell = Math.max(0, (position?.netQuantity ?? 0) - reservedSellQuantity);

    if (intent.side === 'sell' && availableToSell + LEDGER_EPSILON < intent.quantity) {
      const rejection = this.buildOrderEvent({
        intent,
        orderId,
        recordedAt: now,
        status: 'rejected',
        filledQuantity: 0,
        remainingQuantity: intent.quantity,
        rejectionReason: `Insufficient inventory to paper-sell ${intent.quantity}. Available after open-order reservations: ${availableToSell}.`,
        quote
      });
      events.push(rejection);
      const envelopes = await this.ledger.append(events);
      return {
        orderId,
        status: rejection.status,
        filledQuantity: rejection.filledQuantity,
        remainingQuantity: rejection.remainingQuantity,
        envelopes,
        orderEvent: rejection
      };
    }

    const openedOrder = this.buildOrderEvent({
      intent,
      orderId,
      recordedAt: now,
      status: 'open',
      filledQuantity: 0,
      remainingQuantity: intent.quantity,
      quote
    });
    events.push(openedOrder);

    let fillEvent: FillRecordedEvent | undefined;
    let finalOrderEvent = openedOrder;
    let positionEvent: PositionUpdatedEvent | undefined;

    if (quote && this.isQuoteFresh(quote)) {
      const fillPlan = this.planFill({
        order: {
          ...this.toProjectedOrder(openedOrder),
          submittedAt: openedOrder.recordedAt,
          updatedAt: openedOrder.recordedAt
        },
        quote,
        position
      });

      if (fillPlan) {
        fillEvent = this.buildFillEvent({
          intent,
          orderId,
          quote,
          recordedAt: now,
          quantity: fillPlan.quantity,
          price: fillPlan.price
        });
        const preview = applyFillToPosition(position, fillEvent);
        positionEvent = {
          kind: 'position.updated',
          eventId: this.makeId('evt'),
          recordedAt: now,
          sessionId: intent.sessionId,
          executionMode: 'paper',
          marketId: intent.marketId,
          tokenId: intent.tokenId,
          positionId: preview.position.positionId,
          fillId: fillEvent.fillId,
          transition: preview.transition,
          quantityDelta: preview.quantityDelta,
          netQuantity: preview.position.netQuantity,
          averageEntryPrice: preview.position.averageEntryPrice,
          realizedPnlDelta: preview.realizedPnlDelta,
          realizedPnlTotal: preview.position.realizedPnl,
          openedLotIds: preview.openedLotIds,
          closedLotIds: preview.closedLotIds
        };

        finalOrderEvent = this.buildOrderEvent({
          intent,
          orderId,
          recordedAt: now,
          status: fillPlan.quantity + LEDGER_EPSILON < intent.quantity ? 'partially-filled' : 'filled',
          filledQuantity: fillPlan.quantity,
          remainingQuantity: Math.max(0, intent.quantity - fillPlan.quantity),
          quote
        });

        events.push(fillEvent, finalOrderEvent, positionEvent);
      }
    }

    const envelopes = await this.ledger.append(events);
    return {
      orderId,
      status: finalOrderEvent.status,
      filledQuantity: finalOrderEvent.filledQuantity,
      remainingQuantity: finalOrderEvent.remainingQuantity,
      envelopes,
      orderEvent: finalOrderEvent,
      fillEvent,
      positionEvent
    };
  }

  async reconcileQuote(quoteInput: PaperQuote): Promise<PaperReconciliationResult> {
    const quote = paperQuoteSchema.parse(quoteInput);
    if (!this.isQuoteFresh(quote)) {
      return {
        quote,
        envelopes: [],
        filledOrderIds: [],
        skippedReason: `Quote ${quote.quoteId ?? '(unlabeled)'} is older than ${this.maxQuoteAgeMs}ms.`
      };
    }

    const projection = await this.ledger.readProjection();
    const openOrders = getOpenOrders(projection, {
      marketId: quote.marketId,
      tokenId: quote.tokenId
    });

    if (openOrders.length === 0) {
      return {
        quote,
        envelopes: [],
        filledOrderIds: [],
        skippedReason: 'No open paper orders for this market/token.'
      };
    }

    const events: PaperLedgerEvent[] = [];
    const filledOrderIds: string[] = [];
    const positionState = new Map(projection.positions);
    let remainingAskLiquidity = this.normalizeLiquidity(quote.askSize);
    let remainingBidLiquidity = this.normalizeLiquidity(quote.bidSize);

    for (const order of openOrders) {
      const currentPosition = positionState.get(positionKeyFor(order.marketId, order.tokenId));
      const fillPlan = this.planFill({
        order,
        quote,
        position: currentPosition,
        availableLiquidity: order.side === 'buy' ? remainingAskLiquidity : remainingBidLiquidity
      });

      if (!fillPlan) {
        continue;
      }

      const fillEvent = this.buildFillEvent({
        intent: {
          sessionId: order.sessionId,
          intentId: order.intentId,
          strategyId: projection.intents.get(order.intentId)?.strategyId ?? 'paper-reconcile',
          marketId: order.marketId,
          tokenId: order.tokenId,
          side: order.side,
          limitPrice: order.limitPrice,
          quantity: order.requestedQuantity,
          confidence: projection.intents.get(order.intentId)?.confidence,
          thesis: projection.intents.get(order.intentId)?.thesis,
          metadata: projection.intents.get(order.intentId)?.metadata
        },
        orderId: order.orderId,
        quote,
        recordedAt: this.nowIso(),
        quantity: fillPlan.quantity,
        price: fillPlan.price
      });

      const preview = applyFillToPosition(currentPosition, fillEvent);
      positionState.set(preview.position.positionId, preview.position);

      const nextOrder = this.buildOrderEvent({
        intent: {
          sessionId: order.sessionId,
          intentId: order.intentId,
          strategyId: projection.intents.get(order.intentId)?.strategyId ?? 'paper-reconcile',
          marketId: order.marketId,
          tokenId: order.tokenId,
          side: order.side,
          limitPrice: order.limitPrice,
          quantity: order.requestedQuantity,
          confidence: projection.intents.get(order.intentId)?.confidence,
          thesis: projection.intents.get(order.intentId)?.thesis,
          metadata: projection.intents.get(order.intentId)?.metadata
        },
        orderId: order.orderId,
        recordedAt: fillEvent.recordedAt,
        status: order.remainingQuantity - fillPlan.quantity > LEDGER_EPSILON ? 'partially-filled' : 'filled',
        filledQuantity: order.filledQuantity + fillPlan.quantity,
        remainingQuantity: Math.max(0, order.remainingQuantity - fillPlan.quantity),
        quote
      });

      const positionEvent: PositionUpdatedEvent = {
        kind: 'position.updated',
        eventId: this.makeId('evt'),
        recordedAt: fillEvent.recordedAt,
        sessionId: order.sessionId,
        executionMode: 'paper',
        marketId: order.marketId,
        tokenId: order.tokenId,
        positionId: preview.position.positionId,
        fillId: fillEvent.fillId,
        transition: preview.transition,
        quantityDelta: preview.quantityDelta,
        netQuantity: preview.position.netQuantity,
        averageEntryPrice: preview.position.averageEntryPrice,
        realizedPnlDelta: preview.realizedPnlDelta,
        realizedPnlTotal: preview.position.realizedPnl,
        openedLotIds: preview.openedLotIds,
        closedLotIds: preview.closedLotIds
      };

      events.push(fillEvent, nextOrder, positionEvent);
      filledOrderIds.push(order.orderId);

      if (order.side === 'buy' && Number.isFinite(remainingAskLiquidity)) {
        remainingAskLiquidity = Math.max(0, remainingAskLiquidity - fillPlan.quantity);
      }
      if (order.side === 'sell' && Number.isFinite(remainingBidLiquidity)) {
        remainingBidLiquidity = Math.max(0, remainingBidLiquidity - fillPlan.quantity);
      }
    }

    if (events.length === 0) {
      return {
        quote,
        envelopes: [],
        filledOrderIds: [],
        skippedReason: 'Open paper orders did not cross the current quote.'
      };
    }

    const envelopes = await this.ledger.append(events);
    return {
      quote,
      envelopes,
      filledOrderIds
    };
  }

  private planFill(args: {
    order: ProjectedOrder;
    quote: PaperQuote;
    position?: { netQuantity: number };
    availableLiquidity?: number;
  }): { quantity: number; price: number } | null {
    const { order, quote, position } = args;
    const availableLiquidity = args.availableLiquidity ?? (order.side === 'buy' ? this.normalizeLiquidity(quote.askSize) : this.normalizeLiquidity(quote.bidSize));

    if (order.side === 'buy') {
      if (quote.bestAsk == null || quote.bestAsk - order.limitPrice > LEDGER_EPSILON) {
        return null;
      }
      return this.resolveFillQuantity(order.remainingQuantity, availableLiquidity, quote.bestAsk);
    }

    if (quote.bestBid == null || order.limitPrice - quote.bestBid > LEDGER_EPSILON) {
      return null;
    }

    if ((position?.netQuantity ?? 0) <= LEDGER_EPSILON) {
      return null;
    }

    const quantityCap = Math.min(order.remainingQuantity, position?.netQuantity ?? 0);
    return this.resolveFillQuantity(quantityCap, availableLiquidity, quote.bestBid);
  }

  private resolveFillQuantity(requestedQuantity: number, availableLiquidity: number, price: number): { quantity: number; price: number } | null {
    const quantity = Number.isFinite(availableLiquidity)
      ? this.allowPartialFills
        ? Math.min(requestedQuantity, availableLiquidity)
        : availableLiquidity + LEDGER_EPSILON >= requestedQuantity
          ? requestedQuantity
          : 0
      : requestedQuantity;

    if (quantity <= LEDGER_EPSILON) {
      return null;
    }

    return {
      quantity,
      price
    };
  }

  private buildOrderEvent(args: {
    intent: ApprovedTradeIntent;
    orderId: string;
    recordedAt: string;
    status: OrderStatus;
    filledQuantity: number;
    remainingQuantity: number;
    quote?: PaperQuote;
    rejectionReason?: string;
  }): OrderUpdatedEvent {
    return {
      kind: 'order.updated',
      eventId: this.makeId('evt'),
      recordedAt: args.recordedAt,
      sessionId: args.intent.sessionId,
      executionMode: 'paper',
      marketId: args.intent.marketId,
      tokenId: args.intent.tokenId,
      intentId: args.intent.intentId,
      orderId: args.orderId,
      side: args.intent.side,
      limitPrice: args.intent.limitPrice,
      requestedQuantity: args.intent.quantity,
      filledQuantity: args.filledQuantity,
      remainingQuantity: args.remainingQuantity,
      status: args.status,
      rejectionReason: args.rejectionReason ?? null,
      quoteId: args.quote?.quoteId ?? null,
      referenceBid: args.quote?.bestBid ?? null,
      referenceAsk: args.quote?.bestAsk ?? null
    };
  }

  private buildFillEvent(args: {
    intent: ApprovedTradeIntent;
    orderId: string;
    quote: PaperQuote;
    recordedAt: string;
    quantity: number;
    price: number;
  }): FillRecordedEvent {
    const notional = args.quantity * args.price;
    const fee = notional * (this.feeRateBps / 10_000);

    return {
      kind: 'fill.recorded',
      eventId: this.makeId('evt'),
      recordedAt: args.recordedAt,
      sessionId: args.intent.sessionId,
      executionMode: 'paper',
      marketId: args.intent.marketId,
      tokenId: args.intent.tokenId,
      intentId: args.intent.intentId,
      orderId: args.orderId,
      fillId: this.makeId('fill'),
      side: args.intent.side,
      price: args.price,
      quantity: args.quantity,
      fee,
      notional,
      liquidityRole: this.liquidityRole,
      quoteId: args.quote.quoteId ?? null,
      referenceBid: args.quote.bestBid,
      referenceAsk: args.quote.bestAsk
    };
  }

  private toProjectedOrder(order: OrderUpdatedEvent): ProjectedOrder {
    return {
      orderId: order.orderId,
      intentId: order.intentId,
      sessionId: order.sessionId,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side,
      limitPrice: order.limitPrice,
      requestedQuantity: order.requestedQuantity,
      filledQuantity: order.filledQuantity,
      remainingQuantity: order.remainingQuantity,
      status: order.status,
      rejectionReason: order.rejectionReason ?? null,
      quoteId: order.quoteId ?? null,
      referenceBid: order.referenceBid ?? null,
      referenceAsk: order.referenceAsk ?? null,
      submittedAt: order.recordedAt,
      updatedAt: order.recordedAt
    };
  }

  private getReservedSellQuantity(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketId: string,
    tokenId: string
  ): number {
    return getOpenOrders(projection, { marketId, tokenId })
      .filter((order) => order.side === 'sell')
      .reduce((sum, order) => sum + order.remainingQuantity, 0);
  }

  private assertQuoteMatchesIntent(intent: ApprovedTradeIntent, quote: PaperQuote): void {
    if (intent.marketId !== quote.marketId || intent.tokenId !== quote.tokenId) {
      throw new Error(
        `Quote ${quote.quoteId ?? '(unlabeled)'} does not match intent ${intent.intentId} (${intent.marketId}/${intent.tokenId}).`
      );
    }
  }

  private isQuoteFresh(quote: PaperQuote): boolean {
    const observedAt = Date.parse(quote.observedAt);
    if (!Number.isFinite(observedAt)) {
      return false;
    }
    const ageMs = this.clock().getTime() - observedAt;
    return ageMs >= -1_000 && ageMs <= this.maxQuoteAgeMs;
  }

  private normalizeLiquidity(size: number | undefined): number {
    return size == null ? Number.POSITIVE_INFINITY : Math.max(0, size);
  }

  private makeId(prefix: string): string {
    return `${prefix}_${this.idFactory()}`;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

export { JsonlLedger } from '../../ledger/src/index.js';
export type {
  ApprovedTradeIntent,
  FillRecordedEvent,
  LedgerEnvelope,
  LiquidityRole,
  OrderStatus,
  OrderUpdatedEvent,
  PaperQuote,
  PositionUpdatedEvent,
  ProjectedOrder
} from '../../ledger/src/index.js';
