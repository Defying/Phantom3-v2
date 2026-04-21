import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type {
  PaperExitTrigger,
  PaperIntentSummary,
  PaperPositionSummary,
  PaperStrategyView,
  RiskDecisionSummary,
  RuntimeEvent,
  RuntimeMarket,
  RuntimeMarketData,
  RuntimeModule,
  RuntimeState,
  StrategyRuntimeSummary,
  StrategyStateSnapshot,
  WatchEntry
} from '../../../packages/contracts/src/index.js';
import { strategyStateSnapshotSchema } from '../../../packages/contracts/src/index.js';
import { getOpenOrders, JsonlLedger, positionKeyFor, type IntentApprovedEvent, type LedgerProjection, type ProjectedOrder, type ProjectedPosition } from '../../../packages/ledger/src/index.js';
import { fetchTopMarkets, type MarketSnapshot } from '../../../packages/market-data/src/index.js';
import { PaperExecutionAdapter, type ApprovedTradeIntent } from '../../../packages/paper-execution/src/index.js';
import { createPaperRiskConfig, evaluatePaperTradeRisk, type PaperRiskDecision } from '../../../packages/risk/src/index.js';
import { buildStrategySignalReport, type BinarySide, type PaperTradeIntent, type StrategyExitConstraints } from '../../../packages/strategy/src/index.js';
import {
  MAX_STRATEGY_SNAPSHOTS,
  buildPaperStrategyView,
  createEntryIntentSummary,
  createExitIntentSummary,
  createPaperPositionSummary,
  createPaperQuote,
  createRiskMarketSnapshot,
  createRiskPositionSnapshot,
  createRuntimeIntentId,
  createStrategyRuntimeSummary,
  createStrategyStateSnapshot,
  type StrategyEvaluationPayload
} from './strategy-runtime.js';

function isoNow(): string {
  return new Date().toISOString();
}

function event(level: RuntimeEvent['level'], message: string): RuntimeEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: isoNow(),
    level,
    message
  };
}

function clampSnapshotLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_STRATEGY_SNAPSHOTS);
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatProbability(value: number | null): string {
  return value == null ? 'n/a' : round(value, 4).toFixed(4);
}

function formatExitTrigger(trigger: PaperExitTrigger): string {
  switch (trigger) {
    case 'take-profit-hit':
      return 'take profit hit';
    case 'stop-loss-hit':
      return 'stop loss hit';
    case 'latest-exit-reached':
      return 'latest exit reached';
    case 'spread-invalidated':
      return 'spread invalidated the setup';
    case 'complement-invalidated':
      return 'complement drift invalidated the setup';
    case 'expiry-window':
      return 'expiry window reached';
    default: {
      const exhaustiveCheck: never = trigger;
      return exhaustiveCheck;
    }
  }
}

function uniqueTriggers(triggers: PaperExitTrigger[]): PaperExitTrigger[] {
  return [...new Set(triggers)];
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (value == null || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursToExpiry(endDate: string | null, observedAt: string): number | null {
  const endMs = parseTimestamp(endDate);
  const observedAtMs = parseTimestamp(observedAt);
  if (endMs == null || observedAtMs == null) {
    return null;
  }
  return (endMs - observedAtMs) / 3_600_000;
}

function complementDrift(market: RuntimeMarket): number | null {
  if (market.yesPrice == null || market.noPrice == null) {
    return null;
  }
  return Math.abs(1 - (market.yesPrice + market.noPrice));
}

function strategyModuleStatus(strategy: StrategyRuntimeSummary): RuntimeModule['status'] {
  if (strategy.status === 'observing') {
    return 'healthy';
  }
  if (strategy.status === 'paused' || strategy.status === 'degraded') {
    return 'warning';
  }
  return 'idle';
}

function buildModules(state: RuntimeState): RuntimeModule[] {
  return [
    { id: 'config', name: 'Config Gate', status: 'healthy', summary: 'Environment parsed, remote controls token-gated.' },
    { id: 'dashboard', name: 'Dashboard', status: 'healthy', summary: 'Mobile dashboard served from Fastify static host over live WebSocket updates.' },
    {
      id: 'ledger',
      name: 'Paper Ledger',
      status: state.strategy.positions.length > 0 || state.strategy.intents.some((intent) => intent.status === 'submitted') ? 'healthy' : 'warning',
      summary: state.strategy.positions.length > 0 || state.strategy.intents.some((intent) => intent.status === 'submitted')
        ? 'Append-only JSONL paper ledger is recording intents, orders, fills, and position updates.'
        : 'Append-only paper ledger is wired, but no paper orders have been recorded yet.'
    },
    {
      id: 'market-data',
      name: 'Market Data Adapter',
      status: state.marketData.stale ? 'warning' : 'healthy',
      summary: state.marketData.stale
        ? state.marketData.error ?? 'Waiting for a live Polymarket snapshot.'
        : `Tracking ${state.markets.length} active markets from Polymarket Gamma + CLOB.`
    },
    {
      id: 'strategy',
      name: 'Strategy Engine',
      status: strategyModuleStatus(state.strategy),
      summary: state.strategy.summary
    },
    {
      id: 'execution',
      name: 'Execution Gateway',
      status: state.strategy.positions.length > 0 || state.strategy.intents.some((intent) => intent.status === 'submitted') ? 'warning' : 'blocked',
      summary: state.strategy.positions.length > 0 || state.strategy.intents.some((intent) => intent.status === 'submitted')
        ? 'Paper execution is active against the append-only ledger. Live execution remains blocked.'
        : 'Live execution intentionally not implemented in milestone 1.'
    }
  ];
}

function buildWatchlist(state: RuntimeState): WatchEntry[] {
  return [
    {
      id: 'market-snapshot',
      label: 'Read-only market snapshot',
      status: state.marketData.stale ? 'disabled' : 'active',
      note: state.marketData.stale
        ? state.marketData.error ?? 'Waiting on first Gamma + CLOB sync.'
        : `Tracking ${state.markets.length} live markets on a ${Math.round(state.marketData.refreshIntervalMs / 1000)}s cadence.`
    },
    {
      id: 'paper-mode',
      label: 'Paper mode only',
      status: 'active',
      note: 'Live trading remains disarmed by design.'
    },
    {
      id: 'strategy-runtime',
      label: 'Strategy runtime',
      status: state.strategy.status === 'degraded' ? 'disabled' : 'active',
      note: state.strategy.summary
    },
    {
      id: 'paper-ledger',
      label: 'Paper ledger truth',
      status: 'active',
      note: state.strategy.positions.length > 0
        ? `Append-only paper ledger currently tracks ${state.strategy.positions.length} open paper position${state.strategy.positions.length === 1 ? '' : 's'}.`
        : 'Append-only paper ledger is armed and ready for paper-only execution.'
    }
  ];
}

function createInitialState(config: AppConfig): RuntimeState {
  const now = isoNow();
  const marketData: RuntimeMarketData = {
    source: 'Polymarket Gamma + CLOB',
    syncedAt: null,
    stale: true,
    refreshIntervalMs: config.marketRefreshMs,
    error: 'No live market snapshot yet.'
  };

  const state = {
    appName: 'Phantom3 v2',
    version: '0.1.0',
    mode: 'paper',
    startedAt: now,
    lastHeartbeatAt: now,
    paused: false,
    remoteDashboardEnabled: config.remoteDashboardEnabled,
    publicBaseUrl: config.publicBaseUrl,
    marketData,
    markets: [],
    strategy: {
      engineId: 'paper-strategy-runtime',
      strategyVersion: 'paper-signal-v1',
      mode: 'paper',
      status: 'idle',
      safeToExpose: true,
      lastEvaluatedAt: null,
      lastSnapshotAt: null,
      watchedMarketCount: 0,
      candidateCount: 0,
      openIntentCount: 0,
      openPositionCount: 0,
      openExposureUsd: 0,
      summary: 'Paper strategy runtime is waiting on fresh market data before evaluation.',
      candidates: [],
      intents: [],
      riskDecisions: [],
      positions: [],
      notes: ['Paper-only runtime. No real exchange writes are performed.']
    },
    modules: [] as RuntimeModule[],
    watchlist: [] as WatchEntry[],
    events: [
      event('info', 'Phantom3 v2 bootstrap initialized.'),
      event('info', `Remote dashboard ${config.remoteDashboardEnabled ? 'enabled' : 'disabled'} at ${config.publicBaseUrl}`),
      event('warning', 'Execution remains disarmed while milestone 1 builds out read-only truth first.')
    ]
  } satisfies RuntimeState;

  state.modules = buildModules(state);
  state.watchlist = buildWatchlist(state);
  return state;
}

type RuntimeListener = (state: RuntimeState) => void;
type PersistedRuntimeState = Partial<RuntimeState> & { strategySnapshots?: unknown } & Record<string, unknown>;

export class RuntimeStore {
  private readonly statePath: string;
  private readonly ledger: JsonlLedger;
  private readonly paperExecution: PaperExecutionAdapter;
  private state: RuntimeState;
  private strategySnapshots: StrategyStateSnapshot[] = [];
  private persistTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<RuntimeListener>();
  private marketRefreshInFlight: Promise<void> | null = null;
  private marketSyncState: 'never' | 'ok' | 'error' = 'never';
  private lastMarketError: string | null = null;

  constructor(private readonly config: AppConfig) {
    this.statePath = join(config.dataDir, 'runtime-state.json');
    this.ledger = new JsonlLedger({ directory: config.dataDir });
    this.paperExecution = new PaperExecutionAdapter(this.ledger);
    this.state = createInitialState(config);
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await mkdir(this.config.logDir, { recursive: true });
    await this.ledger.init();

    try {
      const raw = await readFile(this.statePath, 'utf8');
      const existing = JSON.parse(raw) as PersistedRuntimeState;
      this.strategySnapshots = this.hydrateStrategySnapshots(existing.strategySnapshots);
      this.state = this.hydrateState(existing);
      this.syncStrategyState('bootstrap', this.currentStrategyPayload(), { recordSnapshot: this.strategySnapshots.length === 0 });
      this.pushEvent('info', 'Reloaded persisted bootstrap state.');
    } catch {
      this.syncStrategyState('bootstrap', this.currentStrategyPayload());
      await this.persist();
    }

    await this.refreshMarketData();
  }

  getState(): RuntimeState {
    return structuredClone(this.state);
  }

  getStrategySummary(): StrategyRuntimeSummary {
    return structuredClone(this.state.strategy);
  }

  getStrategySnapshots(limit = 6): StrategyStateSnapshot[] {
    return structuredClone(this.strategySnapshots.slice(0, clampSnapshotLimit(limit)));
  }

  getPaperStrategyView(limit = 6): PaperStrategyView | null {
    const view = buildPaperStrategyView(this.state, this.strategySnapshots, clampSnapshotLimit(limit));
    return view ? structuredClone(view) : null;
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  pushEvent(level: RuntimeEvent['level'], message: string): void {
    this.state.events = [event(level, message), ...this.state.events].slice(0, 40);
    this.schedulePersist();
    this.notify();
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
    this.state.lastHeartbeatAt = isoNow();
    this.syncStrategyState(paused ? 'pause' : 'resume', this.currentStrategyPayload());
    this.pushEvent('info', paused ? 'Operator paused the runtime.' : 'Operator resumed the runtime.');
  }

  heartbeat(): void {
    this.state.lastHeartbeatAt = isoNow();
    this.schedulePersist();
    this.notify();
  }

  async refreshMarketData(): Promise<void> {
    if (this.marketRefreshInFlight) {
      return this.marketRefreshInFlight;
    }

    this.marketRefreshInFlight = this.doRefreshMarketData().finally(() => {
      this.marketRefreshInFlight = null;
    });

    return this.marketRefreshInFlight;
  }

  private hydrateState(existing: PersistedRuntimeState): RuntimeState {
    const base = createInitialState(this.config);
    const { strategySnapshots: _strategySnapshots, strategy: _strategy, ...rest } = existing;
    const marketData = {
      ...base.marketData,
      ...(typeof existing.marketData === 'object' && existing.marketData ? existing.marketData : {}),
      refreshIntervalMs: this.config.marketRefreshMs
    } as RuntimeMarketData;

    const markets = Array.isArray(existing.markets) ? existing.markets : base.markets;
    const events = Array.isArray(existing.events) ? existing.events : base.events;

    const hydratedState = {
      ...base,
      ...rest,
      lastHeartbeatAt: isoNow(),
      publicBaseUrl: this.config.publicBaseUrl,
      remoteDashboardEnabled: this.config.remoteDashboardEnabled,
      marketData,
      markets,
      events
    } satisfies RuntimeState;

    hydratedState.strategy = createStrategyRuntimeSummary(
      hydratedState,
      this.strategySnapshots,
      this.currentStrategyPayload(base.strategy)
    );
    hydratedState.modules = buildModules(hydratedState);
    hydratedState.watchlist = buildWatchlist(hydratedState);

    return hydratedState;
  }

  private hydrateStrategySnapshots(raw: unknown): StrategyStateSnapshot[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .flatMap((entry) => {
        const parsed = strategyStateSnapshotSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
      .slice(0, MAX_STRATEGY_SNAPSHOTS);
  }

  private currentStrategyPayload(strategy = this.state.strategy): StrategyEvaluationPayload {
    return {
      report: null,
      intents: strategy?.intents ?? [],
      riskDecisions: strategy?.riskDecisions ?? [],
      positions: strategy?.positions ?? [],
      notes: strategy?.notes ?? [],
      lastEvaluatedAt: strategy?.lastEvaluatedAt ?? this.state.marketData.syncedAt ?? null
    };
  }

  private syncStrategyState(
    trigger: StrategyStateSnapshot['trigger'],
    payload: StrategyEvaluationPayload,
    options: { recordSnapshot?: boolean } = {}
  ): void {
    if (options.recordSnapshot !== false) {
      this.strategySnapshots = [createStrategyStateSnapshot(this.state, trigger, payload), ...this.strategySnapshots]
        .slice(0, MAX_STRATEGY_SNAPSHOTS);
    }

    this.state.strategy = createStrategyRuntimeSummary(this.state, this.strategySnapshots, payload);
    this.state.modules = buildModules(this.state);
    this.state.watchlist = buildWatchlist(this.state);
  }

  private inferSideFromToken(market: RuntimeMarket | null, tokenId: string | null | undefined, fallback: BinarySide = 'yes'): BinarySide {
    if (market?.noTokenId && tokenId && tokenId === market.noTokenId) {
      return 'no';
    }
    if (market?.yesTokenId && tokenId && tokenId === market.yesTokenId) {
      return 'yes';
    }
    return fallback;
  }

  private summarizePositions(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketMap: Map<string, RuntimeMarket>,
    observedAt: string
  ): Map<string, NonNullable<PaperPositionSummary['exit']>> {
    const exits = new Map<string, NonNullable<PaperPositionSummary['exit']>>();
    for (const position of projection.positions.values()) {
      if (position.status !== 'open' || position.netQuantity <= 0) {
        continue;
      }
      const exit = this.buildPositionExitState({
        projection,
        position,
        market: marketMap.get(position.marketId) ?? null,
        observedAt
      });
      if (exit) {
        exits.set(position.positionId, exit);
      }
    }
    return exits;
  }

  private parseEntryIntentMetadata(intent: IntentApprovedEvent): {
    strategyId: string;
    question: string;
    side: BinarySide;
    exit: StrategyExitConstraints;
  } | null {
    const metadata = intent.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const record = metadata as Record<string, unknown>;
    const exit = record.exit;
    if (record.kind !== 'entry' || typeof record.question !== 'string' || (record.side !== 'yes' && record.side !== 'no')) {
      return null;
    }
    if (!exit || typeof exit !== 'object' || Array.isArray(exit)) {
      return null;
    }

    const parsedExit = exit as Record<string, unknown>;
    if (
      typeof parsedExit.takeProfitPrice !== 'number' || !Number.isFinite(parsedExit.takeProfitPrice) ||
      typeof parsedExit.stopLossPrice !== 'number' || !Number.isFinite(parsedExit.stopLossPrice) ||
      typeof parsedExit.latestExitAt !== 'string' ||
      typeof parsedExit.invalidateIfSpreadAbove !== 'number' || !Number.isFinite(parsedExit.invalidateIfSpreadAbove) ||
      typeof parsedExit.invalidateIfComplementDriftAbove !== 'number' || !Number.isFinite(parsedExit.invalidateIfComplementDriftAbove) ||
      typeof parsedExit.invalidateIfHoursToExpiryBelow !== 'number' || !Number.isFinite(parsedExit.invalidateIfHoursToExpiryBelow)
    ) {
      return null;
    }

    return {
      strategyId: intent.strategyId,
      question: record.question,
      side: record.side,
      exit: {
        takeProfitPrice: parsedExit.takeProfitPrice,
        stopLossPrice: parsedExit.stopLossPrice,
        latestExitAt: parsedExit.latestExitAt,
        invalidateIfSpreadAbove: parsedExit.invalidateIfSpreadAbove,
        invalidateIfComplementDriftAbove: parsedExit.invalidateIfComplementDriftAbove,
        invalidateIfHoursToExpiryBelow: parsedExit.invalidateIfHoursToExpiryBelow
      }
    };
  }

  private resolvePositionExitPlan(
    projection: LedgerProjection,
    position: ProjectedPosition,
    market: RuntimeMarket | null
  ): {
    strategyId: string;
    question: string;
    side: BinarySide;
    exit: StrategyExitConstraints;
  } | null {
    const fillsById = new Map(projection.fills.map((fill) => [fill.fillId, fill] as const));
    const plans = position.lots.flatMap((lot) => {
      const fill = fillsById.get(lot.sourceFillId);
      if (!fill) {
        return [];
      }
      const intent = projection.intents.get(fill.intentId);
      if (!intent) {
        return [];
      }
      const metadata = this.parseEntryIntentMetadata(intent);
      return metadata ? [metadata] : [];
    });

    if (plans.length === 0) {
      return null;
    }

    const latestExitAtMs = Math.min(...plans.map((plan) => parseTimestamp(plan.exit.latestExitAt) ?? Number.POSITIVE_INFINITY));
    if (!Number.isFinite(latestExitAtMs)) {
      return null;
    }

    return {
      strategyId: plans[0].strategyId,
      question: plans[0].question,
      side: this.inferSideFromToken(market, position.tokenId, plans[0].side),
      exit: {
        takeProfitPrice: Math.min(...plans.map((plan) => plan.exit.takeProfitPrice)),
        stopLossPrice: Math.max(...plans.map((plan) => plan.exit.stopLossPrice)),
        latestExitAt: new Date(latestExitAtMs).toISOString(),
        invalidateIfSpreadAbove: Math.min(...plans.map((plan) => plan.exit.invalidateIfSpreadAbove)),
        invalidateIfComplementDriftAbove: Math.min(...plans.map((plan) => plan.exit.invalidateIfComplementDriftAbove)),
        invalidateIfHoursToExpiryBelow: Math.max(...plans.map((plan) => plan.exit.invalidateIfHoursToExpiryBelow))
      }
    };
  }

  private evaluateExitTriggers(
    market: RuntimeMarket | null,
    side: BinarySide,
    exit: StrategyExitConstraints,
    observedAt: string
  ): PaperExitTrigger[] {
    const triggers: PaperExitTrigger[] = [];
    const markPrice = market == null ? null : side === 'yes' ? market.yesPrice : market.noPrice;
    const observedAtMs = parseTimestamp(observedAt);
    const latestExitAtMs = parseTimestamp(exit.latestExitAt);
    const spread = market?.spread ?? null;
    const drift = market == null ? null : complementDrift(market);
    const remainingHours = market == null ? null : hoursToExpiry(market.endDate, observedAt);

    if (markPrice != null && markPrice <= exit.stopLossPrice) {
      triggers.push('stop-loss-hit');
    }
    if (observedAtMs != null && latestExitAtMs != null && observedAtMs >= latestExitAtMs) {
      triggers.push('latest-exit-reached');
    }
    if (spread != null && spread > exit.invalidateIfSpreadAbove) {
      triggers.push('spread-invalidated');
    }
    if (drift != null && drift > exit.invalidateIfComplementDriftAbove) {
      triggers.push('complement-invalidated');
    }
    if (remainingHours != null && remainingHours < exit.invalidateIfHoursToExpiryBelow) {
      triggers.push('expiry-window');
    }
    if (markPrice != null && markPrice >= exit.takeProfitPrice) {
      triggers.push('take-profit-hit');
    }

    return uniqueTriggers(triggers);
  }

  private findOpenSellOrder(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketId: string,
    tokenId: string
  ): ProjectedOrder | null {
    return getOpenOrders(projection, { marketId, tokenId }).find((order) => order.side === 'sell') ?? null;
  }

  private buildPositionExitState(input: {
    projection: LedgerProjection;
    position: ProjectedPosition;
    market: RuntimeMarket | null;
    observedAt: string;
  }): NonNullable<PaperPositionSummary['exit']> | null {
    const exitPlan = this.resolvePositionExitPlan(input.projection, input.position, input.market);
    if (!exitPlan) {
      return null;
    }

    const openSellOrder = this.findOpenSellOrder(input.projection, input.position.marketId, input.position.tokenId);
    const triggers = this.evaluateExitTriggers(input.market, exitPlan.side, exitPlan.exit, input.observedAt);
    const quote = input.market ? createPaperQuote(input.market, exitPlan.side, input.observedAt) : null;
    const recommendedLimitPrice = openSellOrder?.limitPrice ?? (triggers.length > 0 ? quote?.bestBid ?? null : null);
    const referencePrice = recommendedLimitPrice
      ?? (input.market == null ? null : exitPlan.side === 'yes' ? input.market.yesPrice : input.market.noPrice)
      ?? input.position.averageEntryPrice
      ?? 0;
    const recommendedQuantity = round(
      Math.max(0, openSellOrder?.remainingQuantity ?? (triggers.length > 0 ? input.position.netQuantity : 0)),
      6
    );
    const recommendedSizeUsd = round(Math.max(0, recommendedQuantity * referencePrice), 2);
    const status: NonNullable<PaperPositionSummary['exit']>['status'] = openSellOrder
      ? 'submitted'
      : triggers.length > 0
        ? 'triggered'
        : 'armed';

    let summary = `Paper exit armed at TP ${formatProbability(exitPlan.exit.takeProfitPrice)}, stop ${formatProbability(exitPlan.exit.stopLossPrice)}, latest exit ${exitPlan.exit.latestExitAt}.`;
    if (openSellOrder) {
      summary = `Reduce-only exit order is working at ${formatProbability(openSellOrder.limitPrice)} for ${round(openSellOrder.remainingQuantity, 6)} contracts.`;
    } else if (triggers.length > 0) {
      summary = `Reduce-only exit recommended because ${triggers.map(formatExitTrigger).join(', ')}.`;
    }

    return {
      status,
      triggers,
      evaluatedAt: input.observedAt,
      summary,
      takeProfitPrice: round(exitPlan.exit.takeProfitPrice),
      stopLossPrice: round(exitPlan.exit.stopLossPrice),
      latestExitAt: exitPlan.exit.latestExitAt,
      invalidateIfSpreadAbove: round(exitPlan.exit.invalidateIfSpreadAbove),
      invalidateIfComplementDriftAbove: round(exitPlan.exit.invalidateIfComplementDriftAbove),
      invalidateIfHoursToExpiryBelow: round(exitPlan.exit.invalidateIfHoursToExpiryBelow, 2),
      recommendedQuantity,
      recommendedSizeUsd,
      recommendedLimitPrice: recommendedLimitPrice == null ? null : round(recommendedLimitPrice),
      submittedIntentId: openSellOrder?.intentId ?? null
    };
  }

  private marketMap(markets = this.state.markets): Map<string, RuntimeMarket> {
    return new Map(markets.map((market) => [market.id, market]));
  }

  private recentIntentExists(projection: Awaited<ReturnType<JsonlLedger['readProjection']>>, marketId: string, tokenId: string, now: string): boolean {
    const nowMs = Date.parse(now);
    return [...projection.intents.values()].some((intent) => {
      const recordedAt = Date.parse(intent.recordedAt);
      if (intent.marketId !== marketId || intent.tokenId !== tokenId) {
        return false;
      }
      if (!Number.isFinite(recordedAt) || !Number.isFinite(nowMs)) {
        return true;
      }
      return nowMs - recordedAt < 6 * 60 * 60 * 1000;
    });
  }

  private shouldSubmitEntry(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketId: string,
    tokenId: string,
    now: string
  ): boolean {
    if (getOpenOrders(projection, { marketId, tokenId }).length > 0) {
      return false;
    }

    const existingPosition = projection.positions.get(positionKeyFor(marketId, tokenId));
    if (existingPosition && existingPosition.status === 'open' && existingPosition.netQuantity > 0) {
      return false;
    }

    return !this.recentIntentExists(projection, marketId, tokenId, now);
  }

  private shouldSubmitExit(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketId: string,
    tokenId: string
  ): boolean {
    return this.findOpenSellOrder(projection, marketId, tokenId) == null;
  }

  private buildRiskDecisionSummary(
    decision: PaperRiskDecision,
    input: {
      marketId: string;
      question: string;
      kind?: RiskDecisionSummary['kind'];
      reduceOnly?: boolean;
    }
  ): RiskDecisionSummary {
    return {
      id: `risk-${decision.intentId}`,
      intentId: decision.intentId,
      marketId: input.marketId,
      question: input.question,
      kind: input.kind ?? 'entry',
      reduceOnly: input.reduceOnly ?? false,
      decision: decision.decision,
      approvedSizeUsd: Math.round(decision.approvedSizeUsd * 100) / 100,
      createdAt: decision.evaluatedAt,
      reasons: decision.reasons.map((reason) => reason.message)
    };
  }

  private projectionPositionsToSummaries(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketMap: Map<string, RuntimeMarket>,
    exits: Map<string, NonNullable<PaperPositionSummary['exit']>> = new Map()
  ) {
    return [...projection.positions.values()]
      .map((position) => createPaperPositionSummary(position, marketMap.get(position.marketId) ?? null, { exit: exits.get(position.positionId) ?? null }))
      .filter((position): position is NonNullable<typeof position> => Boolean(position));
  }

  private createApprovedEntryIntent(input: {
    intent: PaperTradeIntent;
    approvedSizeUsd: number;
    limitPrice: number;
    tokenId: string;
    observedAt: string;
  }): ApprovedTradeIntent | null {
    const quantity = input.approvedSizeUsd / input.limitPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return null;
    }

    return {
      sessionId: 'phantom3-v2-paper-runtime',
      intentId: createRuntimeIntentId(input.intent),
      strategyId: input.intent.strategyId,
      marketId: input.intent.marketId,
      tokenId: input.tokenId,
      side: 'buy',
      limitPrice: input.limitPrice,
      quantity: Math.round(quantity * 1_000_000) / 1_000_000,
      approvedAt: input.observedAt,
      thesis: input.intent.thesis.summary,
      confidence: input.intent.confidence,
      metadata: {
        kind: 'entry',
        question: input.intent.question,
        generatedAt: input.intent.generatedAt,
        signalScore: input.intent.signalScore,
        desiredSizeUsd: input.approvedSizeUsd,
        exit: input.intent.exit,
        side: input.intent.side
      }
    };
  }

  private createRuntimeExitIntentId(positionId: string, observedAt: string): string {
    return `exit-${positionId}-${observedAt}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }

  private createApprovedExitIntent(input: {
    strategyId: string;
    position: ProjectedPosition;
    question: string;
    side: BinarySide;
    trigger: PaperExitTrigger | null;
    triggers: PaperExitTrigger[];
    approvedSizeUsd: number;
    limitPrice: number;
    observedAt: string;
  }): ApprovedTradeIntent | null {
    const quantity = Math.min(input.position.netQuantity, input.approvedSizeUsd / input.limitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return null;
    }

    const thesis = `Paper-only reduce-only exit for "${input.question}" because ${input.triggers.length > 0 ? input.triggers.map(formatExitTrigger).join(', ') : 'the paper exit plan triggered'}.`;

    return {
      sessionId: 'phantom3-v2-paper-runtime',
      intentId: this.createRuntimeExitIntentId(input.position.positionId, input.observedAt),
      strategyId: input.strategyId,
      marketId: input.position.marketId,
      tokenId: input.position.tokenId,
      side: 'sell',
      limitPrice: input.limitPrice,
      quantity: Math.round(quantity * 1_000_000) / 1_000_000,
      approvedAt: input.observedAt,
      thesis,
      metadata: {
        kind: 'exit',
        question: input.question,
        generatedAt: input.observedAt,
        reduceOnly: true,
        positionId: input.position.positionId,
        trigger: input.trigger,
        triggers: input.triggers,
        desiredSizeUsd: input.approvedSizeUsd,
        side: input.side
      }
    };
  }

  private async reconcileOpenOrders(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketMap: Map<string, RuntimeMarket>,
    observedAt: string
  ): Promise<boolean> {
    let changed = false;
    const seen = new Set<string>();

    for (const order of getOpenOrders(projection)) {
      const key = positionKeyFor(order.marketId, order.tokenId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const market = marketMap.get(order.marketId);
      if (!market) {
        continue;
      }

      const quote = createPaperQuote(market, this.inferSideFromToken(market, order.tokenId), observedAt);
      if (!quote) {
        continue;
      }

      const result = await this.paperExecution.reconcileQuote(quote);
      if (result.envelopes.length > 0) {
        changed = true;
      }
    }

    return changed;
  }

  private async evaluateStrategy(trigger: StrategyStateSnapshot['trigger'], snapshot: MarketSnapshot): Promise<void> {
    const report = buildStrategySignalReport(snapshot);
    const marketMap = this.marketMap(snapshot.markets);
    const riskConfig = createPaperRiskConfig({
      maxPositionSizeUsd: 40,
      perMarketExposureCapUsd: 50,
      totalExposureCapUsd: 125,
      maxSimultaneousPositions: 3,
      maxSpreadBps: 600
    });

    let projection = await this.ledger.readProjection();
    if (await this.reconcileOpenOrders(projection, marketMap, snapshot.fetchedAt)) {
      projection = await this.ledger.readProjection();
    }

    let positions = this.projectionPositionsToSummaries(projection, marketMap);
    let riskPositions = positions.map(createRiskPositionSnapshot);

    const riskDecisions: RiskDecisionSummary[] = [];
    const intentSummaries: PaperIntentSummary[] = [];
    const previousIntents = new Map(
      this.currentStrategyPayload().intents
        .filter((summary) => summary.kind === 'entry')
        .map((summary) => [`${summary.kind}:${summary.marketId}:${summary.side}`, summary] as const)
    );
    let submittedEntryCount = 0;
    let submittedExitCount = 0;

    for (const position of projection.positions.values()) {
      if (position.status !== 'open' || position.netQuantity <= 0) {
        continue;
      }

      const market = marketMap.get(position.marketId) ?? null;
      const exitPlan = this.resolvePositionExitPlan(projection, position, market);
      const exitState = this.buildPositionExitState({
        projection,
        position,
        market,
        observedAt: snapshot.fetchedAt
      });

      if (!exitPlan || !exitState || exitState.status === 'armed' || !market) {
        continue;
      }
      if (!this.shouldSubmitExit(projection, position.marketId, position.tokenId)) {
        continue;
      }

      const quote = createPaperQuote(market, exitPlan.side, snapshot.fetchedAt);
      const riskMarket = createRiskMarketSnapshot(market, exitPlan.side, snapshot.fetchedAt);
      const referencePrice = quote?.bestBid
        ?? (exitPlan.side === 'yes' ? market.yesPrice : market.noPrice)
        ?? position.averageEntryPrice
        ?? 0;
      const desiredSizeUsd = round(Math.max(0, position.netQuantity * referencePrice), 2);
      if (desiredSizeUsd <= 0) {
        continue;
      }

      const riskDecision = evaluatePaperTradeRisk({
        intent: {
          intentId: this.createRuntimeExitIntentId(position.positionId, snapshot.fetchedAt),
          strategyVersion: report.engine.strategyVersion,
          marketId: position.marketId,
          tokenId: position.tokenId,
          side: exitPlan.side,
          desiredSizeUsd,
          maxEntryPrice: null,
          reduceOnly: true
        },
        market: riskMarket,
        positions: riskPositions,
        config: riskConfig,
        now: snapshot.fetchedAt
      });

      riskDecisions.push(this.buildRiskDecisionSummary(riskDecision, {
        marketId: position.marketId,
        question: exitPlan.question,
        kind: 'exit',
        reduceOnly: true
      }));

      if (!quote || quote.bestBid == null || (riskDecision.decision !== 'approve' && riskDecision.decision !== 'resize')) {
        continue;
      }

      const approvedIntent = this.createApprovedExitIntent({
        strategyId: exitPlan.strategyId,
        position,
        question: exitPlan.question,
        side: exitPlan.side,
        trigger: exitState.triggers[0] ?? null,
        triggers: exitState.triggers,
        approvedSizeUsd: riskDecision.approvedSizeUsd,
        limitPrice: quote.bestBid,
        observedAt: snapshot.fetchedAt
      });

      if (!approvedIntent) {
        continue;
      }

      await this.paperExecution.submitApprovedIntent({ intent: approvedIntent, quote });
      intentSummaries.push(createExitIntentSummary({
        id: approvedIntent.intentId,
        marketId: approvedIntent.marketId,
        marketQuestion: exitPlan.question,
        side: exitPlan.side,
        createdAt: approvedIntent.approvedAt ?? snapshot.fetchedAt,
        desiredSizeUsd: round(approvedIntent.quantity * approvedIntent.limitPrice, 2),
        positionId: position.positionId,
        trigger: exitState.triggers[0] ?? null,
        limitPrice: approvedIntent.limitPrice,
        thesis: approvedIntent.thesis ?? `Paper-only reduce-only exit for "${exitPlan.question}".`
      }));
      submittedExitCount += 1;

      projection = await this.ledger.readProjection();
      positions = this.projectionPositionsToSummaries(projection, marketMap);
      riskPositions = positions.map(createRiskPositionSnapshot);
    }

    for (const intent of report.intents) {
      const market = marketMap.get(intent.marketId);
      if (!market) {
        continue;
      }

      const riskMarket = createRiskMarketSnapshot(market, intent.side, snapshot.fetchedAt);
      const quote = createPaperQuote(market, intent.side, snapshot.fetchedAt);
      const tokenId = riskMarket.tokenId ?? `${market.id}:${intent.side}`;
      const draftDecision = evaluatePaperTradeRisk({
        intent: {
          intentId: createRuntimeIntentId(intent),
          strategyVersion: intent.strategyVersion,
          marketId: intent.marketId,
          tokenId,
          side: intent.side,
          desiredSizeUsd: intent.suggestedNotionalUsd,
          maxEntryPrice: intent.entry.acceptablePriceBand.max,
          reduceOnly: false
        },
        market: riskMarket,
        positions: riskPositions,
        config: riskConfig,
        now: snapshot.fetchedAt
      });

      riskDecisions.push(this.buildRiskDecisionSummary(draftDecision, {
        marketId: intent.marketId,
        question: intent.question,
        kind: 'entry',
        reduceOnly: false
      }));

      const previousSummary = previousIntents.get(`entry:${intent.marketId}:${intent.side}`) ?? null;
      let status: PaperIntentSummary['status'] = draftDecision.decision === 'approve' || draftDecision.decision === 'resize'
        ? 'watching'
        : 'draft';
      let summaryId = previousSummary?.id;
      let summaryCreatedAt = previousSummary?.createdAt;

      if (quote && (draftDecision.decision === 'approve' || draftDecision.decision === 'resize') && this.shouldSubmitEntry(projection, market.id, tokenId, snapshot.fetchedAt)) {
        const approvedIntent = this.createApprovedEntryIntent({
          intent,
          approvedSizeUsd: draftDecision.approvedSizeUsd,
          limitPrice: intent.entry.acceptablePriceBand.max,
          tokenId,
          observedAt: snapshot.fetchedAt
        });

        if (approvedIntent) {
          await this.paperExecution.submitApprovedIntent({ intent: approvedIntent, quote });
          projection = await this.ledger.readProjection();
          positions = this.projectionPositionsToSummaries(projection, marketMap);
          riskPositions = positions.map(createRiskPositionSnapshot);
          status = 'submitted';
          summaryId = approvedIntent.intentId;
          summaryCreatedAt = approvedIntent.approvedAt;
          submittedEntryCount += 1;
        }
      }

      intentSummaries.push(
        createEntryIntentSummary(
          intent,
          status,
          draftDecision.approvedSizeUsd > 0 ? draftDecision.approvedSizeUsd : intent.suggestedNotionalUsd,
          {
            id: summaryId,
            createdAt: summaryCreatedAt
          }
        )
      );
    }

    const positionExits = this.summarizePositions(projection, marketMap, snapshot.fetchedAt);
    positions = this.projectionPositionsToSummaries(projection, marketMap, positionExits);
    const armedExitCount = positions.filter((position) => position.exit?.status === 'armed').length;
    const triggeredExitCount = positions.filter((position) => position.exit?.status === 'triggered').length;
    const workingExitCount = positions.filter((position) => position.exit?.status === 'submitted').length;

    const notes = [
      'Append-only paper ledger is active for paper intents, orders, fills, and positions.',
      submittedEntryCount > 0
        ? `Submitted ${submittedEntryCount} new paper entry intent${submittedEntryCount === 1 ? '' : 's'} on the latest evaluation.`
        : 'No new paper entries were submitted on the latest evaluation.',
      submittedExitCount > 0
        ? `Submitted ${submittedExitCount} reduce-only paper exit intent${submittedExitCount === 1 ? '' : 's'} on the latest evaluation.`
        : triggeredExitCount > 0
          ? `Flagged ${triggeredExitCount} open paper position${triggeredExitCount === 1 ? '' : 's'} for reduce-only exit review.`
          : armedExitCount > 0
            ? `Tracked ${armedExitCount} armed paper exit plan${armedExitCount === 1 ? '' : 's'} across open positions.`
            : 'No paper exits are armed because no paper positions are open.',
      workingExitCount > 0
        ? `There ${workingExitCount === 1 ? 'is' : 'are'} ${workingExitCount} reduce-only paper exit order${workingExitCount === 1 ? '' : 's'} still working in the ledger.`
        : 'Open positions now expose typed paper exit state, and the runtime only submits reduce-only paper exits.'
    ];

    this.syncStrategyState(trigger, {
      report,
      intents: intentSummaries,
      riskDecisions,
      positions,
      notes,
      lastEvaluatedAt: snapshot.fetchedAt
    });
  }

  private async doRefreshMarketData(): Promise<void> {
    try {
      const snapshot = await fetchTopMarkets({
        limit: this.config.marketLimit,
        timeoutMs: Math.min(Math.max(this.config.marketRefreshMs - 1000, 4000), 15000)
      });

      this.state.markets = snapshot.markets;
      this.state.marketData = {
        source: 'Polymarket Gamma + CLOB',
        syncedAt: snapshot.fetchedAt,
        stale: false,
        refreshIntervalMs: this.config.marketRefreshMs,
        error: null
      };
      await this.evaluateStrategy('market-refresh', snapshot);
      this.schedulePersist();
      this.notify();

      if (this.marketSyncState !== 'ok') {
        this.marketSyncState = 'ok';
        this.lastMarketError = null;
        this.pushEvent('info', `Read-only market snapshot is live for ${snapshot.markets.length} active markets.`);
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown market-data refresh error';
      const shouldRecordSnapshot = this.marketSyncState !== 'error' || this.lastMarketError !== message;

      this.state.marketData = {
        ...this.state.marketData,
        stale: true,
        error: message
      };
      this.syncStrategyState('market-refresh-error', {
        ...this.currentStrategyPayload(),
        notes: [...this.currentStrategyPayload().notes ?? [], `Latest market refresh failed: ${message}`],
        lastEvaluatedAt: this.state.marketData.syncedAt ?? isoNow()
      }, { recordSnapshot: shouldRecordSnapshot });
      this.schedulePersist();
      this.notify();

      if (shouldRecordSnapshot) {
        this.marketSyncState = 'error';
        this.lastMarketError = message;
        this.pushEvent('warning', `Market-data refresh failed: ${message}`);
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      void this.persist();
      this.persistTimer = null;
    }, 50);
    this.persistTimer.unref();
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.statePath,
      `${JSON.stringify({ ...this.state, strategySnapshots: this.strategySnapshots }, null, 2)}\n`,
      'utf8'
    );
  }
}
