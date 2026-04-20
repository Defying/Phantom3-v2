import type {
  FillRecordedEvent,
  IntentApprovedEvent,
  LedgerEnvelope,
  OrderUpdatedEvent,
  PositionTransition,
  PositionUpdatedEvent
} from './schemas.js';

export const LEDGER_EPSILON = 1e-9;

export type PositionLot = {
  lotId: string;
  marketId: string;
  tokenId: string;
  sourceFillId: string;
  openedAt: string;
  remainingQuantity: number;
  entryPrice: number;
};

export type ProjectedPosition = {
  positionId: string;
  marketId: string;
  tokenId: string;
  openedAt: string | null;
  updatedAt: string | null;
  status: 'flat' | 'open';
  netQuantity: number;
  averageEntryPrice: number | null;
  realizedPnl: number;
  lots: PositionLot[];
};

export type ProjectedOrder = {
  orderId: string;
  intentId: string;
  sessionId: string;
  marketId: string;
  tokenId: string;
  side: OrderUpdatedEvent['side'];
  limitPrice: number;
  requestedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  status: OrderUpdatedEvent['status'];
  rejectionReason: string | null;
  quoteId: string | null;
  referenceBid: number | null;
  referenceAsk: number | null;
  submittedAt: string;
  updatedAt: string;
};

export type PositionPreview = {
  transition: PositionTransition;
  position: ProjectedPosition;
  quantityDelta: number;
  realizedPnlDelta: number;
  openedLotIds: string[];
  closedLotIds: string[];
};

export type LedgerProjection = {
  latestSequence: number;
  intents: Map<string, IntentApprovedEvent>;
  orders: Map<string, ProjectedOrder>;
  fills: FillRecordedEvent[];
  positions: Map<string, ProjectedPosition>;
  positionEvents: PositionUpdatedEvent[];
  anomalies: string[];
};

function normalizeQuantity(value: number): number {
  return Math.abs(value) <= LEDGER_EPSILON ? 0 : value;
}

function cloneLots(lots: readonly PositionLot[]): PositionLot[] {
  return lots.map((lot) => ({ ...lot }));
}

function emptyPosition(positionId: string, marketId: string, tokenId: string): ProjectedPosition {
  return {
    positionId,
    marketId,
    tokenId,
    openedAt: null,
    updatedAt: null,
    status: 'flat',
    netQuantity: 0,
    averageEntryPrice: null,
    realizedPnl: 0,
    lots: []
  };
}

function computeAverageEntryPrice(lots: readonly PositionLot[]): number | null {
  let totalQuantity = 0;
  let totalCost = 0;

  for (const lot of lots) {
    totalQuantity += lot.remainingQuantity;
    totalCost += lot.entryPrice * lot.remainingQuantity;
  }

  if (normalizeQuantity(totalQuantity) === 0) {
    return null;
  }

  return totalCost / totalQuantity;
}

export function positionKeyFor(marketId: string, tokenId: string): string {
  return `${marketId}:${tokenId}`;
}

export function applyFillToPosition(current: ProjectedPosition | undefined, fill: FillRecordedEvent): PositionPreview {
  const positionId = positionKeyFor(fill.marketId, fill.tokenId);
  const base = current
    ? { ...current, lots: cloneLots(current.lots) }
    : emptyPosition(positionId, fill.marketId, fill.tokenId);

  if (fill.side === 'buy') {
    const unitCost = (fill.notional + fill.fee) / fill.quantity;
    const lotId = `${positionId}:lot:${fill.fillId}`;
    const nextLots = [
      ...base.lots,
      {
        lotId,
        marketId: fill.marketId,
        tokenId: fill.tokenId,
        sourceFillId: fill.fillId,
        openedAt: fill.recordedAt,
        remainingQuantity: fill.quantity,
        entryPrice: unitCost
      }
    ];
    const netQuantity = normalizeQuantity(base.netQuantity + fill.quantity);

    return {
      transition: base.netQuantity > 0 ? 'increased' : 'opened',
      quantityDelta: fill.quantity,
      realizedPnlDelta: 0,
      openedLotIds: [lotId],
      closedLotIds: [],
      position: {
        positionId,
        marketId: fill.marketId,
        tokenId: fill.tokenId,
        openedAt: base.netQuantity > 0 ? base.openedAt : fill.recordedAt,
        updatedAt: fill.recordedAt,
        status: netQuantity > 0 ? 'open' : 'flat',
        netQuantity,
        averageEntryPrice: computeAverageEntryPrice(nextLots),
        realizedPnl: base.realizedPnl,
        lots: nextLots
      }
    };
  }

  if (normalizeQuantity(base.netQuantity) === 0) {
    throw new Error(`Cannot apply sell fill ${fill.fillId} to a flat position ${positionId}.`);
  }

  if (base.netQuantity + LEDGER_EPSILON < fill.quantity) {
    throw new Error(
      `Sell fill ${fill.fillId} for ${fill.quantity} exceeds open quantity ${base.netQuantity} on ${positionId}.`
    );
  }

  let remainingToClose = fill.quantity;
  let realizedBeforeFees = 0;
  const closedLotIds: string[] = [];
  const nextLots = cloneLots(base.lots);

  for (const lot of nextLots) {
    if (remainingToClose <= LEDGER_EPSILON) {
      break;
    }

    const closeQuantity = Math.min(lot.remainingQuantity, remainingToClose);
    if (closeQuantity <= LEDGER_EPSILON) {
      continue;
    }

    lot.remainingQuantity = normalizeQuantity(lot.remainingQuantity - closeQuantity);
    remainingToClose = normalizeQuantity(remainingToClose - closeQuantity);
    realizedBeforeFees += (fill.price - lot.entryPrice) * closeQuantity;

    if (lot.remainingQuantity === 0) {
      closedLotIds.push(lot.lotId);
    }
  }

  if (remainingToClose > LEDGER_EPSILON) {
    throw new Error(`Sell fill ${fill.fillId} left ${remainingToClose} unmatched on ${positionId}.`);
  }

  const remainingLots = nextLots.filter((lot) => lot.remainingQuantity > LEDGER_EPSILON);
  const netQuantity = normalizeQuantity(base.netQuantity - fill.quantity);
  const realizedPnlDelta = realizedBeforeFees - fill.fee;

  return {
    transition: netQuantity > 0 ? 'reduced' : 'closed',
    quantityDelta: -fill.quantity,
    realizedPnlDelta,
    openedLotIds: [],
    closedLotIds,
    position: {
      positionId,
      marketId: fill.marketId,
      tokenId: fill.tokenId,
      openedAt: netQuantity > 0 ? base.openedAt : null,
      updatedAt: fill.recordedAt,
      status: netQuantity > 0 ? 'open' : 'flat',
      netQuantity,
      averageEntryPrice: computeAverageEntryPrice(remainingLots),
      realizedPnl: base.realizedPnl + realizedPnlDelta,
      lots: remainingLots
    }
  };
}

export function getOpenOrders(projection: LedgerProjection, filter?: { marketId?: string; tokenId?: string }): ProjectedOrder[] {
  return [...projection.orders.values()]
    .filter((order) => {
      if (!(order.status === 'open' || order.status === 'partially-filled')) {
        return false;
      }
      if (filter?.marketId && order.marketId !== filter.marketId) {
        return false;
      }
      if (filter?.tokenId && order.tokenId !== filter.tokenId) {
        return false;
      }
      return order.remainingQuantity > LEDGER_EPSILON;
    })
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

export function projectLedgerState(envelopes: readonly LedgerEnvelope[]): LedgerProjection {
  const intents = new Map<string, IntentApprovedEvent>();
  const orders = new Map<string, ProjectedOrder>();
  const fills: FillRecordedEvent[] = [];
  const positions = new Map<string, ProjectedPosition>();
  const positionEvents: PositionUpdatedEvent[] = [];
  const anomalies: string[] = [];
  const sortedEnvelopes = [...envelopes].sort((left, right) => left.sequence - right.sequence);

  for (const envelope of sortedEnvelopes) {
    const { event } = envelope;

    switch (event.kind) {
      case 'intent.approved': {
        intents.set(event.intentId, event);
        break;
      }
      case 'order.updated': {
        const existing = orders.get(event.orderId);
        orders.set(event.orderId, {
          orderId: event.orderId,
          intentId: event.intentId,
          sessionId: event.sessionId,
          marketId: event.marketId,
          tokenId: event.tokenId,
          side: event.side,
          limitPrice: event.limitPrice,
          requestedQuantity: event.requestedQuantity,
          filledQuantity: event.filledQuantity,
          remainingQuantity: event.remainingQuantity,
          status: event.status,
          rejectionReason: event.rejectionReason ?? null,
          quoteId: event.quoteId ?? null,
          referenceBid: event.referenceBid ?? null,
          referenceAsk: event.referenceAsk ?? null,
          submittedAt: existing?.submittedAt ?? event.recordedAt,
          updatedAt: event.recordedAt
        });
        break;
      }
      case 'fill.recorded': {
        fills.push(event);
        try {
          const next = applyFillToPosition(positions.get(positionKeyFor(event.marketId, event.tokenId)), event);
          positions.set(next.position.positionId, next.position);
        } catch (error) {
          anomalies.push(error instanceof Error ? error.message : `Unknown fill projection error for ${event.fillId}.`);
        }
        break;
      }
      case 'position.updated': {
        positionEvents.push(event);
        break;
      }
      default: {
        const exhaustiveCheck: never = event;
        void exhaustiveCheck;
      }
    }
  }

  return {
    latestSequence: sortedEnvelopes.at(-1)?.sequence ?? 0,
    intents,
    orders,
    fills,
    positions,
    positionEvents,
    anomalies
  };
}
