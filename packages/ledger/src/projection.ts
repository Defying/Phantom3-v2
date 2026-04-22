import type {
  FillRecordedEvent,
  IntentApprovedEvent,
  LedgerEnvelope,
  OperatorActionEvent,
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
  venueOrderId: string | null;
  venueStatus: string | null;
  acknowledgedAt: string | null;
  lastReconciledAt: string | null;
  statusReason: string | null;
  quoteId: string | null;
  referenceBid: number | null;
  referenceAsk: number | null;
  metadata: Record<string, unknown> | undefined;
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

export type KillSwitchState = {
  active: boolean;
  triggeredAt: string | null;
  releasedAt: string | null;
  reason: string | null;
};

export type LedgerProjection = {
  latestSequence: number;
  intents: Map<string, IntentApprovedEvent>;
  orders: Map<string, ProjectedOrder>;
  fills: FillRecordedEvent[];
  positions: Map<string, ProjectedPosition>;
  positionEvents: PositionUpdatedEvent[];
  operatorActions: OperatorActionEvent[];
  killSwitch: KillSwitchState;
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

export function isActiveOrderStatus(status: OrderUpdatedEvent['status']): boolean {
  return ['pending-submit', 'pending-ack', 'open', 'partially-filled', 'cancel-pending', 'reconcile'].includes(status);
}

export function getActiveOrders(projection: LedgerProjection, filter?: { marketId?: string; tokenId?: string }): ProjectedOrder[] {
  return [...projection.orders.values()]
    .filter((order) => {
      if (!isActiveOrderStatus(order.status)) {
        return false;
      }
      if (filter?.marketId && order.marketId !== filter.marketId) {
        return false;
      }
      if (filter?.tokenId && order.tokenId !== filter.tokenId) {
        return false;
      }
      return order.remainingQuantity > LEDGER_EPSILON || order.status === 'reconcile';
    })
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

export function getOpenOrders(projection: LedgerProjection, filter?: { marketId?: string; tokenId?: string }): ProjectedOrder[] {
  return getActiveOrders(projection, filter).filter((order) => order.status === 'open' || order.status === 'partially-filled');
}

export function projectLedgerState(envelopes: readonly LedgerEnvelope[]): LedgerProjection {
  const intents = new Map<string, IntentApprovedEvent>();
  const orders = new Map<string, ProjectedOrder>();
  const fills: FillRecordedEvent[] = [];
  const positions = new Map<string, ProjectedPosition>();
  const positionEvents: PositionUpdatedEvent[] = [];
  const operatorActions: OperatorActionEvent[] = [];
  let killSwitch: KillSwitchState = {
    active: false,
    triggeredAt: null,
    releasedAt: null,
    reason: null
  };
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
          venueOrderId: event.venueOrderId === undefined ? existing?.venueOrderId ?? null : event.venueOrderId,
          venueStatus: event.venueStatus === undefined ? existing?.venueStatus ?? null : event.venueStatus,
          acknowledgedAt: event.acknowledgedAt === undefined ? existing?.acknowledgedAt ?? null : event.acknowledgedAt,
          lastReconciledAt:
            event.lastReconciledAt === undefined ? existing?.lastReconciledAt ?? null : event.lastReconciledAt,
          statusReason: event.statusReason === undefined ? existing?.statusReason ?? null : event.statusReason,
          quoteId: event.quoteId === undefined ? existing?.quoteId ?? null : event.quoteId,
          referenceBid: event.referenceBid === undefined ? existing?.referenceBid ?? null : event.referenceBid,
          referenceAsk: event.referenceAsk === undefined ? existing?.referenceAsk ?? null : event.referenceAsk,
          metadata: event.metadata === undefined ? existing?.metadata : event.metadata,
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
      case 'operator.action': {
        operatorActions.push(event);
        if (event.action === 'kill-switch-engaged') {
          killSwitch = {
            active: true,
            triggeredAt: event.recordedAt,
            releasedAt: null,
            reason: event.note ?? null
          };
        }
        if (event.action === 'kill-switch-released') {
          killSwitch = {
            active: false,
            triggeredAt: killSwitch.triggeredAt,
            releasedAt: event.recordedAt,
            reason: event.note ?? killSwitch.reason
          };
        }
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
    operatorActions,
    killSwitch,
    anomalies
  };
}
