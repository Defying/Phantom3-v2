import {
  RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE,
  type RuntimeExecutionSummary,
  type RuntimeLiveControl,
  type RuntimeMarket,
  type RuntimeState,
  type RuntimeTradeStateCounts,
  type RuntimeTradeSummary
} from '../../../packages/contracts/src/index.js';
import { getOpenOrders, type LedgerProjection } from '../../../packages/ledger/src/index.js';

const MAX_RUNTIME_TRADES = 12;
const EPSILON = 1e-9;

type ExecutionStateBasis = Pick<RuntimeState, 'marketData' | 'markets' | 'mode'>;

type TradeGroup = {
  key: string;
  marketId: string;
  tokenId: string;
};

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sideMidpointReferencePrice(market: RuntimeMarket | null, side: 'yes' | 'no'): number | null {
  if (!market) {
    return null;
  }
  return side === 'yes' ? market.yesPrice : market.noPrice;
}

function marketPriceSource(market: RuntimeMarket | null): RuntimeMarket['priceSource'] {
  return market?.priceSource ?? RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE;
}

function inferOutcomeSide(market: RuntimeMarket | null, tokenId: string): 'yes' | 'no' {
  if (market?.noTokenId && market.noTokenId === tokenId) {
    return 'no';
  }
  if (tokenId.endsWith(':no')) {
    return 'no';
  }
  return 'yes';
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function latestTimestamp(values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.localeCompare(left))[0] ?? new Date().toISOString();
}

function latestOpenTimestamp(values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function summarizeExecution(state: ExecutionStateBasis, live: RuntimeLiveControl, counts: RuntimeTradeStateCounts): string {
  const activity = counts.pending + counts.reconcile + counts.open + counts.closed + counts.error;
  const tradeSummary = activity === 0
    ? 'No ledger-backed trades have been recorded yet.'
    : `${counts.pending} pending, ${counts.reconcile} reconcile, ${counts.open} open, ${counts.closed} closed, ${counts.error} error.`;

  const modeSummary = live.configured
    ? live.armed
      ? 'Live control plane is armed, but the live adapter is still unavailable, so venue writes stay blocked.'
      : live.armable
        ? 'Live control plane is configured but disarmed. Paper execution remains the only writer.'
        : 'Live mode was requested, but process-level arming is disabled. Paper execution remains the only writer.'
    : 'Paper execution remains the only writer.';

  const killSwitchSummary = live.killSwitchActive
    ? ` Global kill switch is active${live.killSwitchReason ? ` (${live.killSwitchReason})` : ''}.`
    : '';

  const staleSummary = state.marketData.stale && (counts.pending > 0 || counts.reconcile > 0)
    ? ' Fresh quotes are required before pending or reconciling trades can advance.'
    : '';

  return `${modeSummary} ${tradeSummary}${killSwitchSummary}${staleSummary}`.trim();
}

function collectTradeGroups(projection: LedgerProjection): TradeGroup[] {
  const keys = new Map<string, TradeGroup>();

  for (const order of projection.orders.values()) {
    const key = `${order.marketId}:${order.tokenId}`;
    keys.set(key, { key, marketId: order.marketId, tokenId: order.tokenId });
  }

  for (const position of projection.positions.values()) {
    const hadActivity = position.netQuantity > EPSILON || position.realizedPnl !== 0 || position.updatedAt || position.openedAt;
    if (!hadActivity) {
      continue;
    }
    const key = `${position.marketId}:${position.tokenId}`;
    keys.set(key, { key, marketId: position.marketId, tokenId: position.tokenId });
  }

  for (const fill of projection.fills) {
    const key = `${fill.marketId}:${fill.tokenId}`;
    keys.set(key, { key, marketId: fill.marketId, tokenId: fill.tokenId });
  }

  return [...keys.values()];
}

function createTradeSummary(
  group: TradeGroup,
  state: ExecutionStateBasis,
  projection: LedgerProjection,
  marketMap: Map<string, RuntimeMarket>
): RuntimeTradeSummary {
  const market = marketMap.get(group.marketId) ?? null;
  const side = inferOutcomeSide(market, group.tokenId);
  const position = projection.positions.get(group.key);
  const orders = [...projection.orders.values()].filter((order) => order.marketId === group.marketId && order.tokenId === group.tokenId);
  const openOrders = getOpenOrders(projection, { marketId: group.marketId, tokenId: group.tokenId });
  const fills = projection.fills.filter((fill) => fill.marketId === group.marketId && fill.tokenId === group.tokenId);
  const orderCount = orders.length;
  const openOrderCount = openOrders.length;
  const filledQuantity = round(orders.reduce((sum, order) => sum + order.filledQuantity, 0), 6);
  const remainingQuantity = round(openOrders.reduce((sum, order) => sum + order.remainingQuantity, 0), 6);
  const positionQuantity = round(position?.netQuantity ?? 0, 6);
  const referenceMarkPrice = sideMidpointReferencePrice(market, side);
  const averageEntryPrice = position?.averageEntryPrice == null ? null : round(position.averageEntryPrice);
  const unrealizedPnlUsd = referenceMarkPrice == null || !position || position.netQuantity <= EPSILON || position.averageEntryPrice == null
    ? null
    : round((referenceMarkPrice - position.averageEntryPrice) * position.netQuantity, 2);
  const realizedPnlUsd = position ? round(position.realizedPnl, 2) : fills.length > 0 ? 0 : null;
  const hasProjectionAnomaly = projection.anomalies.some((entry) => entry.includes(group.key) || entry.includes(group.marketId));
  const rejectionReason = orders.find((order) => order.rejectionReason)?.rejectionReason ?? null;

  let status: RuntimeTradeSummary['status'];
  let note: string;

  if (hasProjectionAnomaly || rejectionReason) {
    status = 'error';
    note = rejectionReason ?? 'Ledger projection found an anomaly while reconciling this trade.';
  } else if (openOrderCount > 0) {
    const hasAnyFill = filledQuantity > EPSILON || fills.length > 0 || positionQuantity > EPSILON;
    status = hasAnyFill ? 'reconcile' : 'pending';
    note = hasAnyFill
      ? 'Orders and fills are still reconciling. This trade is not closed until the ledger is flat with no open orders.'
      : 'Order is pending its first reconciled fill.';
  } else if (positionQuantity > EPSILON) {
    status = 'open';
    note = 'Position is open with no unreconciled orders.';
  } else if (fills.length > 0 || orders.some((order) => order.status === 'filled')) {
    status = 'closed';
    note = 'Trade is closed only because reconciled fills flattened the ledger-backed position.';
  } else {
    status = 'pending';
    note = 'Awaiting the first order or fill event.';
  }

  const lastUpdatedAt = latestTimestamp([
    position?.updatedAt,
    ...orders.map((order) => order.updatedAt),
    ...fills.map((fill) => fill.recordedAt)
  ]);
  const openedAt = firstDefined(
    position?.openedAt,
    latestOpenTimestamp(fills.filter((fill) => fill.side === 'buy').map((fill) => fill.recordedAt)),
    latestOpenTimestamp(orders.map((order) => order.submittedAt))
  );
  const closedAt = status === 'closed'
    ? firstDefined(
        position?.updatedAt,
        latestOpenTimestamp(fills.filter((fill) => fill.side === 'sell').map((fill) => fill.recordedAt)),
        lastUpdatedAt
      )
    : null;

  return {
    id: group.key,
    marketId: group.marketId,
    tokenId: group.tokenId,
    marketQuestion: market?.question ?? group.marketId,
    side,
    status,
    note,
    orderCount,
    openOrderCount,
    filledQuantity,
    remainingQuantity,
    positionQuantity,
    averageEntryPrice,
    markPrice: referenceMarkPrice == null ? null : round(referenceMarkPrice),
    markPriceSource: referenceMarkPrice == null ? undefined : marketPriceSource(market),
    realizedPnlUsd,
    unrealizedPnlUsd,
    openedAt,
    closedAt,
    lastUpdatedAt
  };
}

function countTradeStates(trades: RuntimeTradeSummary[]): RuntimeTradeStateCounts {
  return trades.reduce<RuntimeTradeStateCounts>((counts, trade) => {
    counts[trade.status] += 1;
    return counts;
  }, {
    pending: 0,
    reconcile: 0,
    open: 0,
    closed: 0,
    error: 0
  });
}

export function createRuntimeExecutionSummary(
  state: ExecutionStateBasis,
  projection: LedgerProjection,
  live: RuntimeLiveControl
): RuntimeExecutionSummary {
  const marketMap = new Map(state.markets.map((market) => [market.id, market] as const));
  const trades = collectTradeGroups(projection)
    .map((group) => createTradeSummary(group, state, projection, marketMap))
    .sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt))
    .slice(0, MAX_RUNTIME_TRADES);
  const tradeStates = countTradeStates(trades);

  return {
    requestedMode: live.configured ? 'live' : 'paper',
    summary: summarizeExecution(state, live, tradeStates),
    tradeStates,
    trades,
    live: {
      ...live,
      summary: live.summary
    }
  };
}
