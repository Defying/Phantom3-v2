import type {
  PaperIntentSummary,
  PaperPositionSummary,
  PaperStrategyView,
  RiskDecisionSummary,
  RuntimeMarket,
  RuntimeState,
  StrategyCandidate,
  StrategyRuntimeStatus,
  StrategyRuntimeSummary,
  StrategyStateSnapshot
} from '../../../packages/contracts/src/index.js';
import type { ProjectedPosition } from '../../../packages/ledger/src/index.js';
import type { PaperQuote } from '../../../packages/paper-execution/src/index.js';
import type { PaperRiskDecision, PositionSnapshot, RiskMarketSnapshot } from '../../../packages/risk/src/index.js';
import type { EvaluatedMarketSignal, PaperTradeIntent, StrategySignalReport } from '../../../packages/strategy/src/index.js';

const STRATEGY_ENGINE_ID = 'paper-strategy-runtime';
const STRATEGY_VERSION = 'paper-signal-v1';
const MAX_STRATEGY_CANDIDATES = 6;
export const MAX_STRATEGY_SNAPSHOTS = 12;

export type StrategyEvaluationPayload = {
  report: StrategySignalReport | null;
  intents: PaperIntentSummary[];
  riskDecisions: RiskDecisionSummary[];
  positions: PaperPositionSummary[];
  notes?: string[];
  lastEvaluatedAt?: string | null;
};

type StrategyStateBasis = Pick<RuntimeState, 'mode' | 'paused' | 'marketData' | 'markets'>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compactUsd(value: number): string {
  if (value >= 1_000_000) {
    return `$${round(value / 1_000_000, 2)}m`;
  }
  if (value >= 1_000) {
    return `$${round(value / 1_000, 1)}k`;
  }
  return `$${round(value, 0)}`;
}

function sidePrice(market: RuntimeMarket, side: 'yes' | 'no'): number | null {
  return side === 'yes' ? market.yesPrice : market.noPrice;
}

function sideTokenId(market: RuntimeMarket, side: 'yes' | 'no'): string | null {
  return side === 'yes' ? market.yesTokenId : market.noTokenId;
}

function inferSideFromToken(market: RuntimeMarket, tokenId: string | null | undefined): 'yes' | 'no' {
  if (tokenId && market.noTokenId && tokenId === market.noTokenId) {
    return 'no';
  }
  return 'yes';
}

function deriveStrategyStatus(state: StrategyStateBasis): StrategyRuntimeStatus {
  if (state.paused) {
    return 'paused';
  }
  if (state.marketData.stale) {
    return state.markets.length > 0 ? 'degraded' : 'idle';
  }
  if (state.markets.length === 0) {
    return 'idle';
  }
  return 'observing';
}

function toStrategyCandidate(signal: EvaluatedMarketSignal): StrategyCandidate {
  const rationale = signal.status === 'accepted'
    ? signal.thesis?.summary ?? 'Signal passed conservative paper filters.'
    : signal.rejectReasons.join(', ') || 'Signal is waiting on better data quality.';

  return {
    marketId: signal.market.id,
    slug: signal.market.slug,
    question: signal.market.question,
    yesPrice: signal.market.yesPrice,
    noPrice: signal.market.noPrice,
    spread: signal.market.spread,
    liquidity: signal.market.liquidity,
    volume24hr: signal.market.volume24hr,
    score: round(signal.signalScore),
    status: signal.status === 'accepted' ? 'watch' : 'pending-data',
    rationale
  };
}

function selectCandidates(report: StrategySignalReport | null): StrategyCandidate[] {
  if (!report) {
    return [];
  }

  const accepted = report.accepted.map(toStrategyCandidate);
  const rejected = report.rejected.map(toStrategyCandidate);
  return [...accepted, ...rejected].slice(0, MAX_STRATEGY_CANDIDATES);
}

export function createRuntimeIntentId(intent: PaperTradeIntent): string {
  const at = intent.generatedAt.replace(/[:.]/g, '-');
  return `intent-${intent.marketId}-${intent.side}-${at}`;
}

export function createEntryIntentSummary(
  intent: PaperTradeIntent,
  status: PaperIntentSummary['status'],
  desiredSizeUsd: number,
  options: { id?: string; createdAt?: string } = {}
): PaperIntentSummary {
  return {
    id: options.id ?? createRuntimeIntentId(intent),
    marketId: intent.marketId,
    marketQuestion: intent.question,
    side: intent.side,
    status,
    createdAt: options.createdAt ?? intent.generatedAt,
    thesis: intent.thesis.summary,
    desiredSizeUsd: round(desiredSizeUsd, 2),
    maxEntryPrice: intent.entry.acceptablePriceBand.max
  };
}

export function createExitIntentSummary(input: {
  id: string;
  marketId: string;
  marketQuestion: string;
  side: 'yes' | 'no';
  createdAt: string;
  desiredSizeUsd: number;
  maxEntryPrice: number | null;
  thesis: string;
}): PaperIntentSummary {
  return {
    id: input.id,
    marketId: input.marketId,
    marketQuestion: input.marketQuestion,
    side: input.side,
    status: 'submitted',
    createdAt: input.createdAt,
    thesis: input.thesis,
    desiredSizeUsd: round(input.desiredSizeUsd, 2),
    maxEntryPrice: input.maxEntryPrice
  };
}

export function createRiskDecisionSummary(
  decision: PaperRiskDecision,
  marketId: string,
  question: string
): RiskDecisionSummary {
  return {
    id: `${decision.intentId}:${decision.evaluatedAt}`,
    intentId: decision.intentId,
    marketId,
    question,
    decision: decision.decision,
    approvedSizeUsd: round(decision.approvedSizeUsd, 2),
    createdAt: decision.evaluatedAt,
    reasons: decision.reasons.map((reason) => reason.message)
  };
}

export function createPaperPositionSummary(position: ProjectedPosition, market: RuntimeMarket | null): PaperPositionSummary | null {
  if (position.status !== 'open' || position.netQuantity <= 0 || position.averageEntryPrice == null) {
    return null;
  }

  const inferredSide = market ? inferSideFromToken(market, position.tokenId) : 'yes';
  const markPrice = market ? sidePrice(market, inferredSide) : null;
  const unrealizedPnlUsd = markPrice == null
    ? null
    : round((markPrice - position.averageEntryPrice) * position.netQuantity, 2);

  return {
    id: position.positionId,
    marketId: position.marketId,
    tokenId: position.tokenId,
    marketQuestion: market?.question ?? position.marketId,
    side: inferredSide,
    quantity: round(position.netQuantity, 6),
    averageEntryPrice: round(position.averageEntryPrice),
    markPrice: markPrice == null ? null : round(markPrice),
    unrealizedPnlUsd,
    openedAt: position.openedAt ?? position.updatedAt ?? new Date().toISOString(),
    status: 'open'
  };
}

export function createRiskPositionSnapshot(summary: PaperPositionSummary): PositionSnapshot {
  return {
    marketId: summary.marketId,
    side: summary.side,
    exposureUsd: Math.max(0, round(summary.quantity * (summary.markPrice ?? summary.averageEntryPrice), 2)),
    quantity: summary.quantity,
    markPrice: summary.markPrice,
    openedAt: summary.openedAt
  };
}

function marketBookPrices(market: RuntimeMarket, side: 'yes' | 'no'): { midpoint: number | null; bestBid: number | null; bestAsk: number | null } {
  const midpoint = sidePrice(market, side);
  if (midpoint == null) {
    return { midpoint: null, bestBid: null, bestAsk: null };
  }

  const halfSpread = Math.max(0, (market.spread ?? 0) / 2);
  return {
    midpoint,
    bestBid: round(clamp(midpoint - halfSpread, 0.001, 0.999)),
    bestAsk: round(clamp(midpoint + halfSpread, 0.001, 0.999))
  };
}

export function createRiskMarketSnapshot(market: RuntimeMarket, side: 'yes' | 'no', observedAt: string): RiskMarketSnapshot {
  const prices = marketBookPrices(market, side);

  return {
    marketId: market.id,
    tokenId: sideTokenId(market, side) ?? `${market.id}:${side}`,
    bestBid: prices.bestBid,
    bestAsk: prices.bestAsk,
    midpoint: prices.midpoint,
    liquidityUsd: market.liquidity,
    volume24hrUsd: market.volume24hr,
    sourceTimestamp: observedAt,
    observedAt,
    sourceFreshnessMs: 0
  };
}

export function createPaperQuote(market: RuntimeMarket, side: 'yes' | 'no', observedAt: string): PaperQuote | null {
  const prices = marketBookPrices(market, side);
  const tokenId = sideTokenId(market, side) ?? `${market.id}:${side}`;
  if (prices.midpoint == null) {
    return null;
  }

  return {
    quoteId: `quote-${market.id}-${side}-${observedAt.replace(/[:.]/g, '-')}`,
    marketId: market.id,
    tokenId,
    observedAt,
    bestBid: prices.bestBid,
    bestAsk: prices.bestAsk,
    midpoint: prices.midpoint,
    source: 'market-snapshot'
  };
}

function buildSummaryText(
  state: StrategyStateBasis,
  payload: StrategyEvaluationPayload,
  exposureUsd: number
): string {
  const label = state.mode === 'simulation' ? 'Simulation' : 'Paper';
  if (state.mode !== 'paper' && state.mode !== 'simulation') {
    return 'Strategy runtime stays sanitized until the process is explicitly armed for paper mode.';
  }
  if (state.paused) {
    return `${label} strategy runtime is paused. Existing ${label.toLowerCase()} state is preserved and no new evaluations are emitted.`;
  }
  if (state.marketData.stale) {
    return state.marketData.error
      ? `${label} strategy runtime is waiting on fresh market data: ${state.marketData.error}`
      : `${label} strategy runtime is waiting on fresh market data before evaluation.`;
  }
  if (state.markets.length === 0) {
    return `${label} strategy runtime is booted with no markets to observe yet.`;
  }
  const openIntentCount = payload.intents.filter((intent) => intent.status === 'submitted' || intent.status === 'watching').length;
  return `${label} strategy is watching ${state.markets.length} markets, carrying ${openIntentCount} open ${label.toLowerCase()} intents, ${payload.positions.length} open ${label.toLowerCase()} positions, and ${compactUsd(exposureUsd)} open exposure.`;
}

function buildNotes(state: StrategyStateBasis, payload: StrategyEvaluationPayload): string[] {
  const notes = [
    state.mode === 'simulation' ? 'Simulation runtime. No wallet or exchange writes are performed.' : 'Paper-only runtime. No real exchange writes are performed.',
    'Strategy signals are conservative heuristics, not proof of edge.'
  ];

  if (payload.positions.length === 0) {
    notes.push(state.mode === 'simulation' ? 'No simulated positions are open yet.' : 'No paper positions are open yet.');
  }

  if (state.marketData.syncedAt) {
    notes.push(`Latest market sync: ${state.marketData.syncedAt}`);
  }

  if (payload.notes?.length) {
    notes.push(...payload.notes);
  }

  return notes.slice(0, 8);
}

function createSnapshotId(createdAt: string, trigger: StrategyStateSnapshot['trigger']): string {
  return `strategy-${trigger}-${createdAt}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

export function createStrategyRuntimeSummary(
  state: StrategyStateBasis,
  snapshots: StrategyStateSnapshot[],
  payload: StrategyEvaluationPayload
): StrategyRuntimeSummary {
  const latestSnapshot = snapshots[0] ?? null;
  const candidates = payload.report ? selectCandidates(payload.report) : latestSnapshot?.candidates ?? [];
  const openExposureUsd = payload.positions.reduce(
    (sum, position) => sum + position.quantity * (position.markPrice ?? position.averageEntryPrice),
    0
  );

  return {
    engineId: STRATEGY_ENGINE_ID,
    strategyVersion: payload.report?.engine.strategyVersion ?? STRATEGY_VERSION,
    mode: state.mode,
    status: deriveStrategyStatus(state),
    safeToExpose: true,
    lastEvaluatedAt: payload.lastEvaluatedAt ?? state.marketData.syncedAt ?? latestSnapshot?.createdAt ?? null,
    lastSnapshotAt: latestSnapshot?.createdAt ?? null,
    watchedMarketCount: state.markets.length,
    candidateCount: candidates.length,
    openIntentCount: payload.intents.filter((intent) => intent.status === 'submitted' || intent.status === 'watching').length,
    openPositionCount: payload.positions.length,
    openExposureUsd: round(openExposureUsd, 2),
    summary: buildSummaryText(state, payload, openExposureUsd),
    candidates,
    intents: payload.intents,
    riskDecisions: payload.riskDecisions,
    positions: payload.positions,
    notes: buildNotes(state, payload)
  };
}

export function createStrategyStateSnapshot(
  state: StrategyStateBasis,
  trigger: StrategyStateSnapshot['trigger'],
  payload: StrategyEvaluationPayload
): StrategyStateSnapshot {
  const createdAt = payload.lastEvaluatedAt ?? new Date().toISOString();
  const summary = createStrategyRuntimeSummary(state, [], payload);

  return {
    id: createSnapshotId(createdAt, trigger),
    createdAt,
    trigger,
    mode: state.mode,
    status: summary.status,
    summary: summary.summary,
    watchedMarketCount: state.markets.length,
    candidates: summary.candidates,
    intents: payload.intents,
    riskDecisions: payload.riskDecisions,
    positions: payload.positions,
    notes: summary.notes
  };
}

export function buildPaperStrategyView(
  state: RuntimeState,
  snapshots: StrategyStateSnapshot[],
  limit = 6
): PaperStrategyView | null {
  if (state.mode !== 'paper' && state.mode !== 'simulation') {
    return null;
  }

  const boundedLimit = clamp(Math.trunc(limit), 1, MAX_STRATEGY_SNAPSHOTS);
  const limitedSnapshots = snapshots.slice(0, boundedLimit);

  return {
    mode: state.mode,
    safeToExpose: true,
    summary: state.strategy,
    latestSnapshot: limitedSnapshots[0] ?? null,
    snapshots: limitedSnapshots
  };
}
