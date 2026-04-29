import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  LEDGER_EPSILON,
  JsonlLedger,
  approvedTradeIntentSchema,
  applyFillToPosition,
  getActiveOrders,
  paperQuoteSchema,
  positionKeyFor,
  type ApprovedTradeIntent,
  type FillRecordedEvent,
  type LedgerEnvelope,
  type LiquidityRole,
  type OrderStatus,
  type OrderUpdatedEvent,
  type OperatorActionEvent,
  type PaperLedgerEvent,
  type PaperQuote,
  type PositionUpdatedEvent,
  type ProjectedOrder
} from '../../ledger/src/index.js';

export const liveExecutionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  venue: z.string().min(1).default('polymarket'),
  maxQuoteAgeMs: z.number().int().nonnegative().default(5_000),
  maxReconcileAgeMs: z.number().int().positive().default(15_000),
  missingOrderGraceMs: z.number().int().positive().default(30_000),
  liquidityRole: z.enum(['maker', 'taker']).default('taker'),
  requireVenueFillIds: z.literal(true).default(true),
  failClosedOnAmbiguousState: z.literal(true).default(true)
});
export type LiveExecutionConfig = z.infer<typeof liveExecutionConfigSchema>;

export type LiveExecutionAdapterOptions = Partial<LiveExecutionConfig> & {
  clock?: () => Date;
  idFactory?: () => string;
};

export const liveVenueOrderStatusSchema = z.enum(['pending', 'open', 'partially-filled', 'filled', 'canceled', 'rejected', 'unknown']);
export type LiveVenueOrderStatus = z.infer<typeof liveVenueOrderStatusSchema>;

const liveVenueOrderSnapshotBaseSchema = z.object({
  observedAt: z.string().min(1),
  venueOrderId: z.string().min(1).nullable().optional(),
  clientOrderId: z.string().min(1).nullable().optional(),
  marketId: z.string().min(1),
  tokenId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  limitPrice: z.number().min(0).max(1).finite(),
  requestedQuantity: z.number().positive().finite(),
  filledQuantity: z.number().nonnegative().finite(),
  remainingQuantity: z.number().nonnegative().finite().optional(),
  status: liveVenueOrderStatusSchema,
  acknowledgedAt: z.string().min(1).nullable().optional(),
  updatedAt: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).nullable().optional(),
  ambiguous: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional()
});

function refineLiveVenueOrderSnapshot(
  value: { requestedQuantity: number; filledQuantity: number; remainingQuantity?: number },
  ctx: z.core.$RefinementCtx<unknown>
): void {
  const remaining = value.remainingQuantity ?? Math.max(0, value.requestedQuantity - value.filledQuantity);
  if (value.filledQuantity > value.requestedQuantity + LEDGER_EPSILON) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'filledQuantity cannot exceed requestedQuantity.'
    });
  }
  if (remaining > value.requestedQuantity + LEDGER_EPSILON) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'remainingQuantity cannot exceed requestedQuantity.'
    });
  }
}

export const liveVenueOrderSnapshotSchema = liveVenueOrderSnapshotBaseSchema.superRefine(refineLiveVenueOrderSnapshot);
export type LiveVenueOrderSnapshot = z.infer<typeof liveVenueOrderSnapshotSchema>;

export const liveVenueFillSchema = z.object({
  venueFillId: z.string().min(1),
  venueOrderId: z.string().min(1).nullable().optional(),
  clientOrderId: z.string().min(1).nullable().optional(),
  marketId: z.string().min(1),
  tokenId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  price: z.number().min(0).max(1).finite(),
  quantity: z.number().positive().finite(),
  fee: z.number().nonnegative().finite().default(0),
  liquidityRole: z.enum(['maker', 'taker']).default('taker'),
  occurredAt: z.string().min(1),
  raw: z.record(z.string(), z.unknown()).optional()
});
export type LiveVenueFill = z.infer<typeof liveVenueFillSchema>;

export const liveVenuePositionSnapshotSchema = z.object({
  observedAt: z.string().min(1).optional(),
  marketId: z.string().min(1),
  tokenId: z.string().min(1),
  quantity: z.number().nonnegative().finite(),
  ambiguous: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional()
});
export type LiveVenuePositionSnapshot = z.infer<typeof liveVenuePositionSnapshotSchema>;

export const liveSubmitResultSchema = z.object({
  transportStatus: z.enum(['acknowledged', 'rejected', 'ambiguous']).default('acknowledged'),
  order: liveVenueOrderSnapshotSchema.optional(),
  fills: z.array(liveVenueFillSchema).optional(),
  reason: z.string().min(1).nullable().optional()
});
export type LiveSubmitResult = z.infer<typeof liveSubmitResultSchema>;

const liveVenueSnapshotOrderInputSchema = liveVenueOrderSnapshotBaseSchema.extend({
  observedAt: z.string().min(1).optional()
}).superRefine(refineLiveVenueOrderSnapshot);

export const liveVenueStateSnapshotSchema = z.object({
  observedAt: z.string().min(1),
  orders: z.array(liveVenueSnapshotOrderInputSchema),
  fills: z.array(liveVenueFillSchema).default([]),
  positions: z.array(liveVenuePositionSnapshotSchema).default([])
});
export type LiveVenueStateSnapshot = z.infer<typeof liveVenueStateSnapshotSchema>;

export type LiveSubmitOrderRequest = {
  clientOrderId: string;
  intent: ApprovedTradeIntent;
  quote: PaperQuote;
};

export type LiveAssetReadinessResult = {
  status: 'ready' | 'blocked';
  checkedAt: string;
  assetType: 'collateral' | 'conditional';
  tokenId: string | null;
  balance: number | null;
  allowance: number | null;
  requiredBalance: number;
  requiredAllowance: number;
  polGasBalance?: number | null;
  requiredPolGas?: number;
  blockingReasons: string[];
  safeToLog: true;
};

export type LiveCollateralReadinessRequest = {
  requiredBalance: number;
  requiredAllowance: number;
  requiredPolGas: number;
};

export type LiveConditionalTokenReadinessRequest = {
  tokenId: string;
  requiredBalance: number;
  requiredAllowance: number;
};

export type LiveExchangeGateway = {
  submitOrder(request: LiveSubmitOrderRequest): Promise<LiveSubmitResult | z.input<typeof liveSubmitResultSchema>>;
  getCollateralReadiness?(request: LiveCollateralReadinessRequest): Promise<LiveAssetReadinessResult>;
  getConditionalTokenReadiness?(request: LiveConditionalTokenReadinessRequest): Promise<LiveAssetReadinessResult>;
};

export type LiveExecutionResult = {
  orderId: string;
  venueOrderId: string | null;
  status: OrderStatus;
  envelopes: LedgerEnvelope[];
  orderEvent: OrderUpdatedEvent;
  fillEvents: FillRecordedEvent[];
  positionEvents: PositionUpdatedEvent[];
};

export type LiveReconciliationResult = {
  observedAt: string;
  envelopes: LedgerEnvelope[];
  reconciledOrderIds: string[];
  filledOrderIds: string[];
  reconcileRequiredOrderIds: string[];
  unmatchedVenueOrderIds: string[];
  unmatchedVenueFillIds: string[];
  skippedReason?: string;
};

export type LiveStartupReconciliationResult = LiveReconciliationResult & {
  clean: boolean;
  reasons: string[];
  trackedLiveOrderIds: string[];
  trackedLivePositionKeys: string[];
  positionMismatchKeys: string[];
  unmatchedVenuePositionKeys: string[];
};

const DEFAULTS = liveExecutionConfigSchema.parse({});

export class LiveExecutionAdapter {
  private readonly enabled: boolean;
  private readonly venue: string;
  private readonly maxQuoteAgeMs: number;
  private readonly maxReconcileAgeMs: number;
  private readonly missingOrderGraceMs: number;
  private readonly liquidityRole: LiquidityRole;
  private readonly requireVenueFillIds: true;
  private readonly failClosedOnAmbiguousState: true;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly ledger: JsonlLedger,
    private readonly exchange: LiveExchangeGateway,
    options: LiveExecutionAdapterOptions = {}
  ) {
    const parsed = liveExecutionConfigSchema.parse({
      enabled: options.enabled ?? DEFAULTS.enabled,
      venue: options.venue ?? DEFAULTS.venue,
      maxQuoteAgeMs: options.maxQuoteAgeMs ?? DEFAULTS.maxQuoteAgeMs,
      maxReconcileAgeMs: options.maxReconcileAgeMs ?? DEFAULTS.maxReconcileAgeMs,
      missingOrderGraceMs: options.missingOrderGraceMs ?? DEFAULTS.missingOrderGraceMs,
      liquidityRole: options.liquidityRole ?? DEFAULTS.liquidityRole,
      requireVenueFillIds: options.requireVenueFillIds ?? DEFAULTS.requireVenueFillIds,
      failClosedOnAmbiguousState: options.failClosedOnAmbiguousState ?? DEFAULTS.failClosedOnAmbiguousState
    });

    this.enabled = parsed.enabled;
    this.venue = parsed.venue;
    this.maxQuoteAgeMs = parsed.maxQuoteAgeMs;
    this.maxReconcileAgeMs = parsed.maxReconcileAgeMs;
    this.missingOrderGraceMs = parsed.missingOrderGraceMs;
    this.liquidityRole = parsed.liquidityRole;
    this.requireVenueFillIds = parsed.requireVenueFillIds;
    this.failClosedOnAmbiguousState = parsed.failClosedOnAmbiguousState;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async submitApprovedIntent(input: { intent: ApprovedTradeIntent; quote: PaperQuote }): Promise<LiveExecutionResult> {
    this.assertLiveEnabled();

    const intent = approvedTradeIntentSchema.parse(input.intent);
    const quote = paperQuoteSchema.parse(input.quote);
    const now = this.nowIso();

    this.assertQuoteMatchesIntent(intent, quote);
    this.assertQuoteFresh(quote);

    const projection = await this.ledger.readProjection();
    if (projection.intents.has(intent.intentId)) {
      throw new Error(`Intent ${intent.intentId} already exists in the ledger.`);
    }

    const orderId = this.makeId('ord');
    const intentEvent = this.buildIntentEvent(intent, now);
    const preflightRejection = this.getPreflightRejectionReason(projection, intent);

    if (preflightRejection) {
      const rejectedOrder = this.buildIntentOrderEvent({
        intent,
        orderId,
        recordedAt: now,
        status: 'rejected',
        filledQuantity: 0,
        remainingQuantity: intent.quantity,
        quote,
        rejectionReason: preflightRejection,
        statusReason: preflightRejection
      });
      const envelopes = await this.ledger.append([intentEvent, rejectedOrder]);
      return {
        orderId,
        venueOrderId: null,
        status: rejectedOrder.status,
        envelopes,
        orderEvent: rejectedOrder,
        fillEvents: [],
        positionEvents: []
      };
    }

    const pendingSubmit = this.buildIntentOrderEvent({
      intent,
      orderId,
      recordedAt: now,
      status: 'pending-submit',
      filledQuantity: 0,
      remainingQuantity: intent.quantity,
      quote,
      statusReason: 'Awaiting venue submission result.'
    });

    const initialEnvelopes = await this.ledger.append([intentEvent, pendingSubmit]);

    try {
      const submitResult = liveSubmitResultSchema.parse(
        await this.exchange.submitOrder({
          clientOrderId: orderId,
          intent,
          quote
        })
      );

      const reconciliation = await this.handleSubmitResult({
        orderId,
        submitResult
      });

      return {
        orderId,
        venueOrderId: reconciliation.orderEvent.venueOrderId ?? null,
        status: reconciliation.orderEvent.status,
        envelopes: [...initialEnvelopes, ...reconciliation.envelopes],
        orderEvent: reconciliation.orderEvent,
        fillEvents: reconciliation.fillEvents,
        positionEvents: reconciliation.positionEvents
      };
    } catch (error) {
      const reconcileOrder = await this.markOrderForReconcile(orderId, `Submit path requires manual reconciliation: ${this.describeError(error)}`);
      return {
        orderId,
        venueOrderId: reconcileOrder.orderEvent.venueOrderId ?? null,
        status: reconcileOrder.orderEvent.status,
        envelopes: [...initialEnvelopes, ...reconcileOrder.envelopes],
        orderEvent: reconcileOrder.orderEvent,
        fillEvents: reconcileOrder.fillEvents,
        positionEvents: reconcileOrder.positionEvents
      };
    }
  }

  async reconcileVenueSnapshot(input: LiveVenueStateSnapshot): Promise<LiveReconciliationResult> {
    const snapshot = liveVenueStateSnapshotSchema.parse(input);
    if (!this.isTimestampFresh(snapshot.observedAt, this.maxReconcileAgeMs)) {
      return {
        observedAt: snapshot.observedAt,
        envelopes: [],
        reconciledOrderIds: [],
        filledOrderIds: [],
        reconcileRequiredOrderIds: [],
        unmatchedVenueOrderIds: [],
        unmatchedVenueFillIds: [],
        skippedReason: `Venue snapshot ${snapshot.observedAt} is older than ${this.maxReconcileAgeMs}ms.`
      };
    }

    const orders = snapshot.orders.map((order) => liveVenueOrderSnapshotSchema.parse({
      ...order,
      observedAt: order.observedAt ?? snapshot.observedAt
    }));
    const fills = snapshot.fills.map((fill) => liveVenueFillSchema.parse(fill));
    const projection = await this.ledger.readProjection();
    const activeOrders = getActiveOrders(projection, { executionMode: 'live' });
    const envelopes: LedgerEnvelope[] = [];
    const reconciledOrderIds: string[] = [];
    const filledOrderIds: string[] = [];
    const reconcileRequiredOrderIds: string[] = [];
    const matchedOrderKeys = new Set<string>();
    const matchedVenueFillIds = new Set<string>();

    for (const activeOrder of activeOrders) {
      const matches = orders.filter((candidate) => this.matchesTrackedOrder(activeOrder, candidate));

      if (matches.length > 1) {
        const duplicateResult = await this.markOrderForReconcile(
          activeOrder.orderId,
          `Venue snapshot contains multiple candidate orders for tracked order ${activeOrder.orderId}.`
        );
        envelopes.push(...duplicateResult.envelopes);
        reconciledOrderIds.push(activeOrder.orderId);
        reconcileRequiredOrderIds.push(activeOrder.orderId);
        continue;
      }

      if (matches.length === 0) {
        if (this.shouldAllowMissingOrder(activeOrder, snapshot.observedAt)) {
          continue;
        }

        const missingResult = await this.markOrderForReconcile(
          activeOrder.orderId,
          `Tracked order ${activeOrder.orderId} is missing from venue snapshot ${snapshot.observedAt}.`
        );
        envelopes.push(...missingResult.envelopes);
        reconciledOrderIds.push(activeOrder.orderId);
        reconcileRequiredOrderIds.push(activeOrder.orderId);
        continue;
      }

      const matchedOrder = matches[0]!;
      matchedOrderKeys.add(this.snapshotOrderKey(matchedOrder));
      const matchedFills = fills.filter((fill) => this.matchesTrackedFill(activeOrder, matchedOrder, fill));
      for (const fill of matchedFills) {
        matchedVenueFillIds.add(fill.venueFillId);
      }
      const result = await this.reconcileTrackedOrder({
        orderId: activeOrder.orderId,
        venueOrder: matchedOrder,
        venueFills: matchedFills
      });

      envelopes.push(...result.envelopes);
      reconciledOrderIds.push(activeOrder.orderId);
      if (result.fillEvents.length > 0) {
        filledOrderIds.push(activeOrder.orderId);
      }
      if (result.orderEvent.status === 'reconcile') {
        reconcileRequiredOrderIds.push(activeOrder.orderId);
      }
    }

    const unmatchedVenueOrderIds = orders
      .filter((order) => !matchedOrderKeys.has(this.snapshotOrderKey(order)))
      .map((order) => order.venueOrderId ?? order.clientOrderId ?? '(unknown-order)');
    const unmatchedVenueFillIds = fills
      .filter((fill) => !matchedVenueFillIds.has(fill.venueFillId))
      .map((fill) => fill.venueFillId);

    return {
      observedAt: snapshot.observedAt,
      envelopes,
      reconciledOrderIds,
      filledOrderIds,
      reconcileRequiredOrderIds,
      unmatchedVenueOrderIds,
      unmatchedVenueFillIds
    };
  }

  async reconcileStartupState(input: LiveVenueStateSnapshot): Promise<LiveStartupReconciliationResult> {
    const snapshot = liveVenueStateSnapshotSchema.parse(input);
    const positions = snapshot.positions.map((position) => liveVenuePositionSnapshotSchema.parse({
      ...position,
      observedAt: position.observedAt ?? snapshot.observedAt
    }));
    const startupReasons = new Set<string>();
    const venuePositions = new Map<string, LiveVenuePositionSnapshot>();

    for (const position of positions) {
      const key = positionKeyFor(position.marketId, position.tokenId);
      const observedAt = position.observedAt ?? snapshot.observedAt;

      if (venuePositions.has(key)) {
        startupReasons.add(`Venue position snapshot contains multiple entries for ${key}.`);
        continue;
      }
      if (!this.isTimestampFresh(observedAt, this.maxReconcileAgeMs)) {
        startupReasons.add(`Venue position snapshot for ${key} is older than ${this.maxReconcileAgeMs}ms.`);
      }
      if (position.ambiguous && this.failClosedOnAmbiguousState) {
        startupReasons.add(`Venue position ${key} was flagged ambiguous by the exchange adapter.`);
      }
      venuePositions.set(key, position);
    }

    const reconciliation = await this.reconcileVenueSnapshot(snapshot);
    if (reconciliation.skippedReason) {
      startupReasons.add(reconciliation.skippedReason);
    }
    if (reconciliation.reconcileRequiredOrderIds.length > 0) {
      startupReasons.add(`Live order reconciliation is still required for ${reconciliation.reconcileRequiredOrderIds.join(', ')}.`);
    }
    if (reconciliation.unmatchedVenueOrderIds.length > 0) {
      startupReasons.add(`Venue snapshot exposed unmatched live orders: ${reconciliation.unmatchedVenueOrderIds.join(', ')}.`);
    }
    if (reconciliation.unmatchedVenueFillIds.length > 0) {
      startupReasons.add(`Venue snapshot exposed unmatched live fills: ${reconciliation.unmatchedVenueFillIds.join(', ')}.`);
    }

    const projection = await this.ledger.readProjection();
    const trackedLiveOrders = getActiveOrders(projection, { executionMode: 'live' });
    if (projection.anomalies.length > 0) {
      for (const anomaly of projection.anomalies) {
        startupReasons.add(anomaly);
      }
    }
    const trackedLivePositions = [...projection.positions.values()]
      .filter((position) => position.executionMode === 'live' && position.netQuantity > LEDGER_EPSILON);
    const positionMismatchKeys: string[] = [];
    const unmatchedVenuePositionKeys: string[] = [];
    const matchedPositionKeys = new Set<string>();

    for (const position of trackedLivePositions) {
      const key = position.positionId;
      const venuePosition = venuePositions.get(key);
      if (!venuePosition) {
        positionMismatchKeys.push(key);
        startupReasons.add(`Tracked live position ${key} is missing from the venue position snapshot.`);
        continue;
      }

      matchedPositionKeys.add(key);
      if (Math.abs(position.netQuantity - venuePosition.quantity) > LEDGER_EPSILON) {
        positionMismatchKeys.push(key);
        startupReasons.add(
          `Venue position ${key} reports ${venuePosition.quantity}, but the ledger projects ${position.netQuantity}.`
        );
      }
    }

    for (const [key, venuePosition] of venuePositions.entries()) {
      if (matchedPositionKeys.has(key)) {
        continue;
      }
      if (venuePosition.quantity <= LEDGER_EPSILON) {
        continue;
      }
      unmatchedVenuePositionKeys.push(key);
      startupReasons.add(`Venue position ${key} still holds ${venuePosition.quantity}, but the ledger is flat.`);
    }

    return {
      ...reconciliation,
      clean: startupReasons.size === 0,
      reasons: [...startupReasons],
      trackedLiveOrderIds: trackedLiveOrders.map((order) => order.orderId),
      trackedLivePositionKeys: trackedLivePositions.map((position) => position.positionId),
      positionMismatchKeys,
      unmatchedVenuePositionKeys
    };
  }

  async engageKillSwitch(input: {
    sessionId: string;
    note?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LedgerEnvelope[]> {
    return this.ledger.append(
      this.buildOperatorActionEvent({
        sessionId: input.sessionId,
        action: 'kill-switch-engaged',
        note: input.note,
        metadata: input.metadata
      })
    );
  }

  async releaseKillSwitch(input: {
    sessionId: string;
    note?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LedgerEnvelope[]> {
    return this.ledger.append(
      this.buildOperatorActionEvent({
        sessionId: input.sessionId,
        action: 'kill-switch-released',
        note: input.note,
        metadata: input.metadata
      })
    );
  }

  async requestFlatten(input: {
    sessionId: string;
    marketId: string;
    tokenId: string;
    quote: PaperQuote;
    strategyId?: string;
    note?: string;
    limitPrice?: number;
  }): Promise<LiveExecutionResult> {
    this.assertLiveEnabled();

    const quote = paperQuoteSchema.parse(input.quote);
    const projection = await this.ledger.readProjection();
    const workingBuyOrders = getActiveOrders(projection, { executionMode: 'live', marketId: input.marketId, tokenId: input.tokenId })
      .filter((order) => order.side === 'buy');
    if (workingBuyOrders.length > 0) {
      throw new Error(
        `Cannot flatten while ${workingBuyOrders.length} working buy order${workingBuyOrders.length === 1 ? ' still needs' : 's still need'} reconciliation for ${input.marketId}/${input.tokenId}. Cancel or reconcile entry orders first.`
      );
    }

    const position = this.projectedLivePosition(projection, input.marketId, input.tokenId);
    const reservedSellQuantity = this.getReservedSellQuantity(projection, input.marketId, input.tokenId);
    const quantity = Math.max(0, (position?.netQuantity ?? 0) - reservedSellQuantity);

    if (quantity <= LEDGER_EPSILON) {
      throw new Error(`No reconciled inventory is available to flatten for ${input.marketId}/${input.tokenId}.`);
    }

    const limitPrice = input.limitPrice ?? quote.bestBid;
    if (limitPrice == null) {
      throw new Error('Cannot flatten without an explicit limitPrice or a bestBid quote.');
    }

    await this.ledger.append(
      this.buildOperatorActionEvent({
        sessionId: input.sessionId,
        action: 'flatten-requested',
        marketId: input.marketId,
        tokenId: input.tokenId,
        targetPositionId: position?.positionId ?? positionKeyFor(input.marketId, input.tokenId),
        note: input.note,
        metadata: {
          quantity,
          reservedSellQuantity
        }
      })
    );

    return this.submitApprovedIntent({
      intent: {
        sessionId: input.sessionId,
        intentId: this.makeId('intent'),
        strategyId: input.strategyId ?? 'operator-flatten',
        marketId: input.marketId,
        tokenId: input.tokenId,
        side: 'sell',
        limitPrice,
        quantity,
        reduceOnly: true,
        thesis: input.note ?? 'Operator flatten request.',
        confidence: null,
        metadata: {
          operatorAction: 'flatten'
        }
      },
      quote
    });
  }

  private async handleSubmitResult(args: {
    orderId: string;
    submitResult: LiveSubmitResult;
  }): Promise<Pick<LiveExecutionResult, 'envelopes' | 'orderEvent' | 'fillEvents' | 'positionEvents'>> {
    if (args.submitResult.transportStatus === 'rejected') {
      const projection = await this.ledger.readProjection();
      const order = projection.orders.get(args.orderId);
      if (!order) {
        throw new Error(`Tracked order ${args.orderId} disappeared before rejection could be recorded.`);
      }

      const orderEvent = this.buildProjectedOrderEvent({
        order,
        recordedAt: this.nowIso(),
        status: 'rejected',
        filledQuantity: 0,
        remainingQuantity: order.requestedQuantity,
        rejectionReason: args.submitResult.reason ?? 'Venue rejected the order before acknowledgment.',
        statusReason: args.submitResult.reason ?? 'Venue rejected the order before acknowledgment.',
        lastReconciledAt: this.nowIso(),
        venueStatus: args.submitResult.order?.status ?? 'rejected',
        venueOrderId: args.submitResult.order?.venueOrderId ?? null,
        acknowledgedAt: args.submitResult.order?.acknowledgedAt ?? null,
        metadata: args.submitResult.order?.raw
          ? {
              venue: this.venue,
              raw: args.submitResult.order.raw
            }
          : {
              venue: this.venue
            }
      });

      const envelopes = await this.ledger.append(orderEvent);
      return {
        envelopes,
        orderEvent,
        fillEvents: [],
        positionEvents: []
      };
    }

    if (!args.submitResult.order) {
      return this.markOrderForReconcile(
        args.orderId,
        args.submitResult.reason ?? 'Venue submit response was ambiguous and did not contain an order snapshot.'
      );
    }

    return this.reconcileTrackedOrder({
      orderId: args.orderId,
      venueOrder: args.submitResult.order,
      venueFills: args.submitResult.fills ?? [],
      forcedReconcileReason:
        args.submitResult.transportStatus === 'ambiguous'
          ? args.submitResult.reason ?? 'Submit response was marked ambiguous by the exchange adapter.'
          : undefined
    });
  }

  private async reconcileTrackedOrder(args: {
    orderId: string;
    venueOrder: LiveVenueOrderSnapshot | z.input<typeof liveVenueOrderSnapshotSchema>;
    venueFills?: readonly LiveVenueFill[] | readonly z.input<typeof liveVenueFillSchema>[];
    forcedReconcileReason?: string;
  }): Promise<Pick<LiveExecutionResult, 'envelopes' | 'orderEvent' | 'fillEvents' | 'positionEvents'>> {
    const projection = await this.ledger.readProjection();
    const localOrder = projection.orders.get(args.orderId);
    if (!localOrder) {
      throw new Error(`Tracked order ${args.orderId} was not found in the ledger projection.`);
    }

    const venueOrder = liveVenueOrderSnapshotSchema.parse(args.venueOrder);
    const venueFills = (args.venueFills ?? []).map((fill) => liveVenueFillSchema.parse(fill)).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const reasons = new Set<string>();

    if (args.forcedReconcileReason) {
      reasons.add(args.forcedReconcileReason);
    }
    if (!this.isTimestampFresh(venueOrder.observedAt, this.maxReconcileAgeMs)) {
      reasons.add(`Venue order snapshot ${venueOrder.observedAt} is older than ${this.maxReconcileAgeMs}ms.`);
    }
    if (venueOrder.ambiguous && this.failClosedOnAmbiguousState) {
      reasons.add(`Venue order ${venueOrder.venueOrderId ?? localOrder.orderId} was flagged ambiguous by the exchange adapter.`);
    }
    if (!this.matchesTrackedOrder(localOrder, venueOrder)) {
      reasons.add(`Venue order snapshot does not match tracked order ${localOrder.orderId}.`);
    }
    if (Math.abs(venueOrder.requestedQuantity - localOrder.requestedQuantity) > LEDGER_EPSILON) {
      reasons.add(`Venue requested quantity ${venueOrder.requestedQuantity} does not match tracked quantity ${localOrder.requestedQuantity}.`);
    }
    if (Math.abs(venueOrder.limitPrice - localOrder.limitPrice) > LEDGER_EPSILON) {
      reasons.add(`Venue limit price ${venueOrder.limitPrice} does not match tracked limit ${localOrder.limitPrice}.`);
    }

    const recordedFills = projection.fills.filter((fill) => fill.orderId === localOrder.orderId);
    const recordedVenueFillIds = new Set(
      recordedFills.map((fill) => fill.venueFillId).filter((value): value is string => Boolean(value))
    );
    const seenIncomingFillIds = new Set<string>();

    for (const fill of venueFills) {
      if (seenIncomingFillIds.has(fill.venueFillId)) {
        reasons.add(`Venue snapshot repeated fill ${fill.venueFillId} for order ${localOrder.orderId}.`);
        continue;
      }
      seenIncomingFillIds.add(fill.venueFillId);

      if (fill.marketId !== localOrder.marketId || fill.tokenId !== localOrder.tokenId || fill.side !== localOrder.side) {
        reasons.add(`Venue fill ${fill.venueFillId} does not match tracked market/token/side for ${localOrder.orderId}.`);
      }
      if (this.requireVenueFillIds && !fill.venueFillId) {
        reasons.add(`Venue fill evidence for ${localOrder.orderId} is missing a stable venueFillId.`);
      }
    }

    const evidenceFilledBefore = this.sumFillQuantity(recordedFills);
    const newVenueFills = venueFills.filter((fill) => !recordedVenueFillIds.has(fill.venueFillId));
    const newEvidenceQuantity = this.sumVenueFillQuantity(newVenueFills);
    const evidenceFilledAfter = evidenceFilledBefore + newEvidenceQuantity;
    const venueRemaining = this.normalizeQuantity(
      venueOrder.remainingQuantity ?? Math.max(0, venueOrder.requestedQuantity - venueOrder.filledQuantity)
    );

    if (venueOrder.filledQuantity + LEDGER_EPSILON < evidenceFilledBefore) {
      reasons.add(
        `Venue filled quantity ${venueOrder.filledQuantity} is below already-recorded fill evidence ${evidenceFilledBefore} for ${localOrder.orderId}.`
      );
    }
    if (evidenceFilledAfter > localOrder.requestedQuantity + LEDGER_EPSILON) {
      reasons.add(`Fill evidence ${evidenceFilledAfter} exceeds requested quantity ${localOrder.requestedQuantity} for ${localOrder.orderId}.`);
    }
    if (venueOrder.filledQuantity > evidenceFilledAfter + LEDGER_EPSILON) {
      reasons.add(
        `Venue order ${localOrder.orderId} reports ${venueOrder.filledQuantity} filled, but only ${evidenceFilledAfter} has explicit fill evidence.`
      );
    }
    if (Math.abs((venueOrder.requestedQuantity - venueOrder.filledQuantity) - venueRemaining) > LEDGER_EPSILON) {
      reasons.add(`Venue remaining quantity is internally inconsistent for ${localOrder.orderId}.`);
    }

    switch (venueOrder.status) {
      case 'filled': {
        if (localOrder.requestedQuantity - evidenceFilledAfter > LEDGER_EPSILON) {
          reasons.add(`Venue marked ${localOrder.orderId} filled without full fill evidence.`);
        }
        break;
      }
      case 'canceled': {
        if (venueRemaining <= LEDGER_EPSILON && localOrder.requestedQuantity - evidenceFilledAfter > LEDGER_EPSILON) {
          reasons.add(`Venue marked ${localOrder.orderId} canceled with zero remaining quantity but incomplete fill evidence.`);
        }
        break;
      }
      case 'rejected': {
        if (evidenceFilledAfter > LEDGER_EPSILON) {
          reasons.add(`Venue marked ${localOrder.orderId} rejected even though fill evidence exists.`);
        }
        break;
      }
      case 'partially-filled': {
        if (evidenceFilledAfter <= LEDGER_EPSILON || localOrder.requestedQuantity - evidenceFilledAfter <= LEDGER_EPSILON) {
          reasons.add(`Venue marked ${localOrder.orderId} partially-filled with inconsistent fill evidence.`);
        }
        break;
      }
      case 'pending': {
        if (this.orderAgeMs(localOrder) > this.missingOrderGraceMs) {
          reasons.add(`Order ${localOrder.orderId} remained pending beyond the ${this.missingOrderGraceMs}ms grace interval.`);
        }
        break;
      }
      default:
        break;
    }

    const fillEvents: FillRecordedEvent[] = [];
    const positionEvents: PositionUpdatedEvent[] = [];
    const ledgerEvents: PaperLedgerEvent[] = [];
    let currentPosition = this.projectedLivePosition(projection, localOrder.marketId, localOrder.tokenId);

    for (const fill of newVenueFills) {
      const fillEvent = this.buildLiveFillEvent({
        order: localOrder,
        fill
      });
      fillEvents.push(fillEvent);
      ledgerEvents.push(fillEvent);

      try {
        const preview = applyFillToPosition(currentPosition, fillEvent);
        const positionEvent = this.buildPositionEvent({
          order: localOrder,
          fillEvent,
          preview
        });
        positionEvents.push(positionEvent);
        ledgerEvents.push(positionEvent);
        currentPosition = preview.position;
      } catch (error) {
        reasons.add(`Fill ${fill.venueFillId} could not reconcile into position state: ${this.describeError(error)}`);
      }
    }

    const evidenceRemaining = this.normalizeQuantity(Math.max(0, localOrder.requestedQuantity - evidenceFilledAfter));
    const status = reasons.size > 0
      ? 'reconcile'
      : this.mapVenueStatus(venueOrder.status, evidenceFilledAfter, evidenceRemaining);

    const orderEvent = this.buildProjectedOrderEvent({
      order: localOrder,
      recordedAt: this.nowIso(),
      status,
      filledQuantity: evidenceFilledAfter,
      remainingQuantity: status === 'filled' ? 0 : evidenceRemaining,
      rejectionReason: status === 'rejected' ? venueOrder.reason ?? null : null,
      venueOrderId: venueOrder.venueOrderId ?? localOrder.venueOrderId ?? null,
      venueStatus: venueOrder.status,
      acknowledgedAt: venueOrder.acknowledgedAt ?? localOrder.acknowledgedAt ?? venueOrder.observedAt,
      lastReconciledAt: venueOrder.observedAt,
      statusReason: reasons.size > 0 ? [...reasons].join(' | ') : venueOrder.reason ?? null,
      metadata: venueOrder.raw
        ? {
            venue: this.venue,
            venueObservedAt: venueOrder.observedAt,
            raw: venueOrder.raw
          }
        : {
            venue: this.venue,
            venueObservedAt: venueOrder.observedAt
          }
    });

    ledgerEvents.push(orderEvent);
    const envelopes = await this.ledger.append(ledgerEvents);
    return {
      envelopes,
      orderEvent,
      fillEvents,
      positionEvents
    };
  }

  private async markOrderForReconcile(
    orderId: string,
    reason: string
  ): Promise<Pick<LiveExecutionResult, 'envelopes' | 'orderEvent' | 'fillEvents' | 'positionEvents'>> {
    const projection = await this.ledger.readProjection();
    const order = projection.orders.get(orderId);
    if (!order) {
      throw new Error(`Tracked order ${orderId} is missing from the ledger projection.`);
    }

    const filledQuantity = this.sumFillQuantity(projection.fills.filter((fill) => fill.orderId === order.orderId));
    const remainingQuantity = this.normalizeQuantity(Math.max(0, order.requestedQuantity - filledQuantity));
    const orderEvent = this.buildProjectedOrderEvent({
      order,
      recordedAt: this.nowIso(),
      status: 'reconcile',
      filledQuantity,
      remainingQuantity,
      venueOrderId: order.venueOrderId,
      venueStatus: order.venueStatus,
      acknowledgedAt: order.acknowledgedAt,
      lastReconciledAt: this.nowIso(),
      statusReason: reason,
      metadata: order.metadata
    });

    const envelopes = await this.ledger.append(orderEvent);
    return {
      envelopes,
      orderEvent,
      fillEvents: [],
      positionEvents: []
    };
  }

  private getPreflightRejectionReason(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    intent: ApprovedTradeIntent
  ): string | null {
    if (projection.killSwitch.active && !intent.reduceOnly) {
      return `Live kill switch is active${projection.killSwitch.reason ? `: ${projection.killSwitch.reason}` : '.'}`;
    }

    if (intent.reduceOnly && intent.side !== 'sell') {
      return 'reduceOnly live intents must be sell orders in the current long-only position model.';
    }

    if (intent.side !== 'sell') {
      return null;
    }

    const reservedSellQuantity = this.getReservedSellQuantity(projection, intent.marketId, intent.tokenId);
    const position = this.projectedLivePosition(projection, intent.marketId, intent.tokenId);
    const availableToSell = Math.max(0, (position?.netQuantity ?? 0) - reservedSellQuantity);

    if (availableToSell + LEDGER_EPSILON < intent.quantity) {
      return `Insufficient reconciled inventory to live-sell ${intent.quantity}. Available after active sell reservations: ${availableToSell}.`;
    }

    return null;
  }

  private getReservedSellQuantity(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketId: string,
    tokenId: string
  ): number {
    return getActiveOrders(projection, { executionMode: 'live', marketId, tokenId })
      .filter((order) => order.side === 'sell')
      .reduce((sum, order) => sum + order.remainingQuantity, 0);
  }

  private buildIntentEvent(intent: ApprovedTradeIntent, recordedAt: string): PaperLedgerEvent {
    return {
      kind: 'intent.approved',
      eventId: this.makeId('evt'),
      recordedAt,
      sessionId: intent.sessionId,
      executionMode: 'live',
      marketId: intent.marketId,
      tokenId: intent.tokenId,
      intentId: intent.intentId,
      strategyId: intent.strategyId,
      side: intent.side,
      limitPrice: intent.limitPrice,
      quantity: intent.quantity,
      reduceOnly: intent.reduceOnly,
      thesis: intent.thesis,
      confidence: intent.confidence,
      metadata: intent.metadata
    };
  }

  private buildIntentOrderEvent(args: {
    intent: ApprovedTradeIntent;
    orderId: string;
    recordedAt: string;
    status: OrderStatus;
    filledQuantity: number;
    remainingQuantity: number;
    quote?: PaperQuote;
    rejectionReason?: string | null;
    venueOrderId?: string | null;
    venueStatus?: string | null;
    acknowledgedAt?: string | null;
    lastReconciledAt?: string | null;
    statusReason?: string | null;
    metadata?: Record<string, unknown>;
  }): OrderUpdatedEvent {
    return {
      kind: 'order.updated',
      eventId: this.makeId('evt'),
      recordedAt: args.recordedAt,
      sessionId: args.intent.sessionId,
      executionMode: 'live',
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
      venueOrderId: args.venueOrderId ?? null,
      venueStatus: args.venueStatus ?? null,
      acknowledgedAt: args.acknowledgedAt ?? null,
      lastReconciledAt: args.lastReconciledAt,
      statusReason: args.statusReason ?? null,
      quoteId: args.quote?.quoteId ?? null,
      referenceBid: args.quote?.bestBid ?? null,
      referenceAsk: args.quote?.bestAsk ?? null,
      metadata: args.metadata
    };
  }

  private buildProjectedOrderEvent(args: {
    order: ProjectedOrder;
    recordedAt: string;
    status: OrderStatus;
    filledQuantity: number;
    remainingQuantity: number;
    rejectionReason?: string | null;
    venueOrderId?: string | null;
    venueStatus?: string | null;
    acknowledgedAt?: string | null;
    lastReconciledAt?: string | null;
    statusReason?: string | null;
    metadata?: Record<string, unknown>;
  }): OrderUpdatedEvent {
    return {
      kind: 'order.updated',
      eventId: this.makeId('evt'),
      recordedAt: args.recordedAt,
      sessionId: args.order.sessionId,
      executionMode: 'live',
      marketId: args.order.marketId,
      tokenId: args.order.tokenId,
      intentId: args.order.intentId,
      orderId: args.order.orderId,
      side: args.order.side,
      limitPrice: args.order.limitPrice,
      requestedQuantity: args.order.requestedQuantity,
      filledQuantity: args.filledQuantity,
      remainingQuantity: args.remainingQuantity,
      status: args.status,
      rejectionReason: args.rejectionReason ?? null,
      venueOrderId: args.venueOrderId === undefined ? args.order.venueOrderId : args.venueOrderId,
      venueStatus: args.venueStatus === undefined ? args.order.venueStatus : args.venueStatus,
      acknowledgedAt: args.acknowledgedAt === undefined ? args.order.acknowledgedAt : args.acknowledgedAt,
      lastReconciledAt: args.lastReconciledAt ?? null,
      statusReason: args.statusReason ?? null,
      quoteId: args.order.quoteId,
      referenceBid: args.order.referenceBid,
      referenceAsk: args.order.referenceAsk,
      metadata: args.metadata
    };
  }

  private buildLiveFillEvent(args: { order: ProjectedOrder; fill: LiveVenueFill }): FillRecordedEvent {
    const notional = args.fill.quantity * args.fill.price;
    return {
      kind: 'fill.recorded',
      eventId: this.makeId('evt'),
      recordedAt: args.fill.occurredAt,
      sessionId: args.order.sessionId,
      executionMode: 'live',
      marketId: args.order.marketId,
      tokenId: args.order.tokenId,
      intentId: args.order.intentId,
      orderId: args.order.orderId,
      fillId: this.makeId('fill'),
      side: args.fill.side,
      price: args.fill.price,
      quantity: args.fill.quantity,
      fee: args.fill.fee,
      notional,
      liquidityRole: args.fill.liquidityRole ?? this.liquidityRole,
      venueFillId: args.fill.venueFillId,
      exchangeTimestamp: args.fill.occurredAt,
      quoteId: args.order.quoteId,
      referenceBid: args.order.referenceBid,
      referenceAsk: args.order.referenceAsk,
      metadata: args.fill.raw
        ? {
            venue: this.venue,
            raw: args.fill.raw
          }
        : {
            venue: this.venue
          }
    };
  }

  private buildPositionEvent(args: {
    order: ProjectedOrder;
    fillEvent: FillRecordedEvent;
    preview: ReturnType<typeof applyFillToPosition>;
  }): PositionUpdatedEvent {
    return {
      kind: 'position.updated',
      eventId: this.makeId('evt'),
      recordedAt: args.fillEvent.recordedAt,
      sessionId: args.order.sessionId,
      executionMode: 'live',
      marketId: args.order.marketId,
      tokenId: args.order.tokenId,
      positionId: args.preview.position.positionId,
      fillId: args.fillEvent.fillId,
      transition: args.preview.transition,
      quantityDelta: args.preview.quantityDelta,
      netQuantity: args.preview.position.netQuantity,
      averageEntryPrice: args.preview.position.averageEntryPrice,
      realizedPnlDelta: args.preview.realizedPnlDelta,
      realizedPnlTotal: args.preview.position.realizedPnl,
      openedLotIds: args.preview.openedLotIds,
      closedLotIds: args.preview.closedLotIds
    };
  }

  private buildOperatorActionEvent(args: {
    sessionId: string;
    action: OperatorActionEvent['action'];
    marketId?: string;
    tokenId?: string;
    targetOrderId?: string;
    targetPositionId?: string;
    note?: string;
    metadata?: Record<string, unknown>;
  }): OperatorActionEvent {
    return {
      kind: 'operator.action',
      eventId: this.makeId('evt'),
      recordedAt: this.nowIso(),
      sessionId: args.sessionId,
      executionMode: 'live',
      marketId: args.marketId ?? null,
      tokenId: args.tokenId ?? null,
      action: args.action,
      targetOrderId: args.targetOrderId ?? null,
      targetPositionId: args.targetPositionId ?? null,
      note: args.note ?? null,
      metadata: args.metadata
    };
  }

  private mapVenueStatus(status: LiveVenueOrderStatus, filledQuantity: number, remainingQuantity: number): OrderStatus {
    switch (status) {
      case 'pending':
        return 'pending-ack';
      case 'open':
        return filledQuantity > LEDGER_EPSILON ? 'partially-filled' : 'open';
      case 'partially-filled':
        return filledQuantity > LEDGER_EPSILON && remainingQuantity > LEDGER_EPSILON ? 'partially-filled' : 'reconcile';
      case 'filled':
        return remainingQuantity <= LEDGER_EPSILON ? 'filled' : 'reconcile';
      case 'canceled':
        return 'canceled';
      case 'rejected':
        return 'rejected';
      case 'unknown':
      default:
        return 'reconcile';
    }
  }

  private matchesTrackedOrder(order: ProjectedOrder, candidate: LiveVenueOrderSnapshot): boolean {
    if (order.venueOrderId && candidate.venueOrderId) {
      return order.venueOrderId === candidate.venueOrderId;
    }
    if (candidate.clientOrderId) {
      return candidate.clientOrderId === order.orderId;
    }
    return false;
  }

  private matchesTrackedFill(order: ProjectedOrder, venueOrder: LiveVenueOrderSnapshot, fill: LiveVenueFill): boolean {
    if (order.venueOrderId && fill.venueOrderId) {
      return order.venueOrderId === fill.venueOrderId;
    }
    if (venueOrder.venueOrderId && fill.venueOrderId) {
      return venueOrder.venueOrderId === fill.venueOrderId;
    }
    if (fill.clientOrderId) {
      return fill.clientOrderId === order.orderId;
    }
    return false;
  }

  private projectedLivePosition(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketId: string,
    tokenId: string
  ) {
    const position = projection.positions.get(positionKeyFor(marketId, tokenId));
    return position?.executionMode === 'live' ? position : undefined;
  }

  private shouldAllowMissingOrder(order: ProjectedOrder, observedAt: string): boolean {
    if (!this.isTimestampFresh(observedAt, this.maxReconcileAgeMs)) {
      return false;
    }
    return this.orderAgeMs(order) <= this.missingOrderGraceMs && (order.status === 'pending-submit' || order.status === 'pending-ack');
  }

  private snapshotOrderKey(order: LiveVenueOrderSnapshot): string {
    return order.venueOrderId ?? order.clientOrderId ?? `${order.marketId}:${order.tokenId}:${order.side}:${order.limitPrice}:${order.requestedQuantity}`;
  }

  private sumFillQuantity(fills: readonly FillRecordedEvent[]): number {
    return fills.reduce((sum, fill) => sum + fill.quantity, 0);
  }

  private sumVenueFillQuantity(fills: readonly LiveVenueFill[]): number {
    return fills.reduce((sum, fill) => sum + fill.quantity, 0);
  }

  private orderAgeMs(order: ProjectedOrder): number {
    return this.clock().getTime() - this.parseTime(order.updatedAt ?? order.submittedAt);
  }

  private parseTime(value: string): number {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return Number.NaN;
    }
    return parsed;
  }

  private isTimestampFresh(value: string, maxAgeMs: number): boolean {
    const parsed = this.parseTime(value);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    const ageMs = this.clock().getTime() - parsed;
    return ageMs >= -1_000 && ageMs <= maxAgeMs;
  }

  private assertLiveEnabled(): void {
    if (!this.enabled) {
      throw new Error('Live execution is disabled. Keep paper mode armed until live execution is explicitly enabled.');
    }
  }

  private assertQuoteMatchesIntent(intent: ApprovedTradeIntent, quote: PaperQuote): void {
    if (intent.marketId !== quote.marketId || intent.tokenId !== quote.tokenId) {
      throw new Error(
        `Quote ${quote.quoteId ?? '(unlabeled)'} does not match intent ${intent.intentId} (${intent.marketId}/${intent.tokenId}).`
      );
    }
  }

  private assertQuoteFresh(quote: PaperQuote): void {
    if (!this.isTimestampFresh(quote.observedAt, this.maxQuoteAgeMs)) {
      throw new Error(`Quote ${quote.quoteId ?? '(unlabeled)'} is older than ${this.maxQuoteAgeMs}ms.`);
    }
  }

  private normalizeQuantity(value: number): number {
    return Math.abs(value) <= LEDGER_EPSILON ? 0 : value;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
  OperatorActionEvent,
  PaperQuote,
  PositionUpdatedEvent,
  ProjectedOrder
} from '../../ledger/src/index.js';
