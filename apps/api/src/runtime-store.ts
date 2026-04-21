import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type {
  LedgerDiagnostics,
  PaperIntentSummary,
  PaperStrategyView,
  PersistenceDiagnostics,
  RejectReasonCount,
  RiskDecisionSummary,
  RuntimeDiagnostics,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeMarket,
  RuntimeMarketData,
  RuntimeModule,
  RuntimeState,
  StrategyEvaluationDiagnostics,
  StrategyRuntimeSummary,
  StrategyStateSnapshot,
  StrategyStateTrigger,
  WatchEntry
} from '../../../packages/contracts/src/index.js';
import { runtimeDiagnosticsSchema, strategyStateSnapshotSchema } from '../../../packages/contracts/src/index.js';
import { getOpenOrders, JsonlLedger, positionKeyFor, type LedgerProjection } from '../../../packages/ledger/src/index.js';
import { fetchTopMarkets, type MarketSnapshot } from '../../../packages/market-data/src/index.js';
import { PaperExecutionAdapter, type ApprovedTradeIntent } from '../../../packages/paper-execution/src/index.js';
import { createPaperRiskConfig, evaluatePaperTradeRisk, type PaperRiskDecision } from '../../../packages/risk/src/index.js';
import { buildStrategySignalReport, type PaperTradeIntent, type StrategySignalReport } from '../../../packages/strategy/src/index.js';
import {
  MAX_STRATEGY_SNAPSHOTS,
  buildPaperStrategyView,
  createEntryIntentSummary,
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

function clampEventLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 40);
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

function ageMs(timestamp: string | null, nowMs = Date.now()): number | null {
  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.round(nowMs - parsed));
}

function durationSince(startedAtMs: number): number {
  return Math.max(0, Math.round(Date.now() - startedAtMs));
}

type DiagnosticCounters = {
  attemptCount: number;
  successCount: number;
  failureCount: number;
};

type MarketSyncMetrics = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastDurationMs: number | null;
  lastSuccessDurationMs: number | null;
  lastFailureDurationMs: number | null;
  consecutiveFailureCount: number;
  lastMarketCount: number;
  counters: DiagnosticCounters;
};

type StrategyMetrics = {
  lastSnapshotTrigger: StrategyStateTrigger | null;
  lastEvaluationTrigger: StrategyStateTrigger | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  latestSubmittedIntentCount: number;
  counters: DiagnosticCounters;
  lastReport: StrategySignalReport | null;
};

type PersistenceMetrics = {
  lastScheduledAt: string | null;
  lastStartedAt: string | null;
  lastPersistedAt: string | null;
  lastDurationMs: number | null;
  inFlight: boolean;
  lastError: string | null;
  counters: DiagnosticCounters;
};

function createCounters(): DiagnosticCounters {
  return {
    attemptCount: 0,
    successCount: 0,
    failureCount: 0
  };
}

function createEmptyLedgerProjection(): LedgerProjection {
  return {
    latestSequence: 0,
    intents: new Map(),
    orders: new Map(),
    fills: [],
    positions: new Map(),
    positionEvents: [],
    anomalies: []
  };
}

function countRejectReasons(report: StrategySignalReport | null): RejectReasonCount[] {
  if (!report) {
    return [];
  }

  const counts = new Map<string, number>();
  for (const candidate of report.rejected) {
    for (const reason of candidate.rejectReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => ({ reason, count }));
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
  private readonly marketSyncMetrics: MarketSyncMetrics = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastDurationMs: null,
    lastSuccessDurationMs: null,
    lastFailureDurationMs: null,
    consecutiveFailureCount: 0,
    lastMarketCount: 0,
    counters: createCounters()
  };
  private readonly strategyMetrics: StrategyMetrics = {
    lastSnapshotTrigger: null,
    lastEvaluationTrigger: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    latestSubmittedIntentCount: 0,
    counters: createCounters(),
    lastReport: null
  };
  private readonly persistenceMetrics: PersistenceMetrics = {
    lastScheduledAt: null,
    lastStartedAt: null,
    lastPersistedAt: null,
    lastDurationMs: null,
    inFlight: false,
    lastError: null,
    counters: createCounters()
  };

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

  getRecentEvents(limit = 10): RuntimeEvent[] {
    return structuredClone(this.state.events.slice(0, clampEventLimit(limit)));
  }

  async getRuntimeDiagnostics(limit = 10): Promise<RuntimeDiagnostics> {
    const [stateStats, ledgerStats, ledgerResult] = await Promise.all([
      this.readFileStats(this.statePath),
      this.readFileStats(this.ledger.filePath),
      this.readLedgerProjectionSafely()
    ]);

    const generatedAt = isoNow();
    const ledger = this.buildLedgerDiagnostics(ledgerResult.projection, ledgerStats.size, ledgerStats.lastModifiedAt);
    if (ledgerResult.error) {
      ledger.anomalies = [ledgerResult.error, ...ledger.anomalies].slice(0, 5);
      ledger.anomalyCount = ledger.anomalies.length;
    }

    const marketSync = this.buildMarketSyncDiagnostics();
    const strategyEvaluation = this.buildStrategyEvaluationDiagnostics();
    const persistence = this.buildPersistenceDiagnostics(stateStats.size, stateStats.lastModifiedAt);
    const runtime = this.buildRuntimeHealth(generatedAt, marketSync, strategyEvaluation, persistence, ledger);

    return runtimeDiagnosticsSchema.parse({
      safeToExpose: true,
      generatedAt,
      runtime,
      marketSync,
      strategyEvaluation,
      persistence,
      ledger,
      recentEvents: this.getRecentEvents(limit)
    });
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
    this.strategyMetrics.lastSnapshotTrigger = trigger;

    if (options.recordSnapshot !== false) {
      this.strategySnapshots = [createStrategyStateSnapshot(this.state, trigger, payload), ...this.strategySnapshots]
        .slice(0, MAX_STRATEGY_SNAPSHOTS);
    }

    this.state.strategy = createStrategyRuntimeSummary(this.state, this.strategySnapshots, payload);
    this.state.modules = buildModules(this.state);
    this.state.watchlist = buildWatchlist(this.state);
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

  private buildRiskDecisionSummary(decision: PaperRiskDecision, intent: PaperTradeIntent): RiskDecisionSummary {
    return {
      id: `risk-${decision.intentId}`,
      intentId: decision.intentId,
      marketId: intent.marketId,
      question: intent.question,
      decision: decision.decision,
      approvedSizeUsd: Math.round(decision.approvedSizeUsd * 100) / 100,
      createdAt: decision.evaluatedAt,
      reasons: decision.reasons.map((reason) => reason.message)
    };
  }

  private projectionPositionsToSummaries(
    projection: Awaited<ReturnType<JsonlLedger['readProjection']>>,
    marketMap: Map<string, RuntimeMarket>
  ) {
    return [...projection.positions.values()]
      .map((position) => createPaperPositionSummary(position, marketMap.get(position.marketId) ?? null))
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

  private async evaluateStrategy(trigger: StrategyStateSnapshot['trigger'], snapshot: MarketSnapshot): Promise<void> {
    const startedAt = isoNow();
    const startedAtMs = Date.now();
    this.strategyMetrics.lastEvaluationTrigger = trigger;
    this.strategyMetrics.lastStartedAt = startedAt;
    this.strategyMetrics.counters.attemptCount += 1;

    try {
      const report = buildStrategySignalReport(snapshot);
      const marketMap = this.marketMap(snapshot.markets);
      let projection = await this.ledger.readProjection();
      let positions = this.projectionPositionsToSummaries(projection, marketMap);
      let riskPositions = positions.map(createRiskPositionSnapshot);

      const riskDecisions: RiskDecisionSummary[] = [];
      const intentSummaries: PaperIntentSummary[] = [];
      const previousIntents = new Map(
        this.currentStrategyPayload().intents.map((summary) => [`${summary.marketId}:${summary.side}`, summary] as const)
      );
      let submittedCount = 0;

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
          config: createPaperRiskConfig({
            maxPositionSizeUsd: 40,
            perMarketExposureCapUsd: 50,
            totalExposureCapUsd: 125,
            maxSimultaneousPositions: 3,
            maxSpreadBps: 600
          }),
          now: snapshot.fetchedAt
        });

        riskDecisions.push(this.buildRiskDecisionSummary(draftDecision, intent));

        const previousSummary = previousIntents.get(`${intent.marketId}:${intent.side}`) ?? null;
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
            submittedCount += 1;
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

      const notes = [
        'Append-only paper ledger is active for paper intents, orders, fills, and positions.',
        submittedCount > 0
          ? `Submitted ${submittedCount} new paper entry intent${submittedCount === 1 ? '' : 's'} on the latest evaluation.`
          : 'No new paper entries were submitted on the latest evaluation.',
        'Auto exits are not wired yet, so open paper positions stay open until a later milestone.'
      ];

      this.syncStrategyState(trigger, {
        report,
        intents: intentSummaries,
        riskDecisions,
        positions,
        notes,
        lastEvaluatedAt: snapshot.fetchedAt
      });

      this.strategyMetrics.lastCompletedAt = isoNow();
      this.strategyMetrics.lastSuccessAt = snapshot.fetchedAt;
      this.strategyMetrics.lastDurationMs = durationSince(startedAtMs);
      this.strategyMetrics.lastError = null;
      this.strategyMetrics.lastReport = report;
      this.strategyMetrics.latestSubmittedIntentCount = submittedCount;
      this.strategyMetrics.counters.successCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown strategy evaluation error';
      this.strategyMetrics.lastCompletedAt = isoNow();
      this.strategyMetrics.lastDurationMs = durationSince(startedAtMs);
      this.strategyMetrics.lastError = message;
      this.strategyMetrics.counters.failureCount += 1;
      throw error;
    }
  }

  private async doRefreshMarketData(): Promise<void> {
    const startedAt = isoNow();
    const startedAtMs = Date.now();
    const wasOk = this.marketSyncState === 'ok';
    this.marketSyncMetrics.lastAttemptAt = startedAt;
    this.marketSyncMetrics.counters.attemptCount += 1;

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

      this.marketSyncMetrics.lastSuccessAt = snapshot.fetchedAt;
      this.marketSyncMetrics.lastDurationMs = durationSince(startedAtMs);
      this.marketSyncMetrics.lastSuccessDurationMs = this.marketSyncMetrics.lastDurationMs;
      this.marketSyncMetrics.lastMarketCount = snapshot.markets.length;
      this.marketSyncMetrics.consecutiveFailureCount = 0;
      this.marketSyncMetrics.counters.successCount += 1;
      this.marketSyncState = 'ok';
      this.lastMarketError = null;

      if (!wasOk) {
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

      this.marketSyncMetrics.lastFailureAt = isoNow();
      this.marketSyncMetrics.lastDurationMs = durationSince(startedAtMs);
      this.marketSyncMetrics.lastFailureDurationMs = this.marketSyncMetrics.lastDurationMs;
      this.marketSyncMetrics.consecutiveFailureCount += 1;
      this.marketSyncMetrics.counters.failureCount += 1;
      this.marketSyncState = 'error';
      this.lastMarketError = message;

      if (shouldRecordSnapshot) {
        this.pushEvent('warning', `Market-data refresh failed: ${message}`);
      }
    }
  }

  private schedulePersist(): void {
    this.persistenceMetrics.lastScheduledAt = isoNow();

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch(() => undefined);
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
    const startedAtMs = Date.now();
    this.persistenceMetrics.lastStartedAt = isoNow();
    this.persistenceMetrics.inFlight = true;
    this.persistenceMetrics.counters.attemptCount += 1;

    try {
      await writeFile(
        this.statePath,
        `${JSON.stringify({ ...this.state, strategySnapshots: this.strategySnapshots }, null, 2)}\n`,
        'utf8'
      );
      this.persistenceMetrics.lastPersistedAt = isoNow();
      this.persistenceMetrics.lastDurationMs = durationSince(startedAtMs);
      this.persistenceMetrics.lastError = null;
      this.persistenceMetrics.counters.successCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown persist error';
      this.persistenceMetrics.lastDurationMs = durationSince(startedAtMs);
      this.persistenceMetrics.lastError = message;
      this.persistenceMetrics.counters.failureCount += 1;
      this.state.events = [event('error', `Runtime state persist failed: ${message}`), ...this.state.events].slice(0, 40);
      this.notify();
      throw error;
    } finally {
      this.persistenceMetrics.inFlight = false;
    }
  }

  private async readFileStats(path: string): Promise<{ size: number; lastModifiedAt: string | null }> {
    try {
      const info = await stat(path);
      return {
        size: Math.max(0, Math.trunc(info.size)),
        lastModifiedAt: info.mtime ? info.mtime.toISOString() : null
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return { size: 0, lastModifiedAt: null };
      }
      throw error;
    }
  }

  private async readLedgerProjectionSafely(): Promise<{ projection: LedgerProjection; error: string | null }> {
    try {
      return {
        projection: await this.ledger.readProjection(),
        error: null
      };
    } catch (error) {
      return {
        projection: createEmptyLedgerProjection(),
        error: error instanceof Error ? error.message : 'Unknown ledger projection error'
      };
    }
  }

  private buildMarketSyncDiagnostics(): RuntimeDiagnostics['marketSync'] {
    return {
      safeToExpose: true,
      state: this.marketSyncState,
      stale: this.state.marketData.stale,
      refreshInFlight: this.marketRefreshInFlight !== null,
      refreshIntervalMs: this.state.marketData.refreshIntervalMs,
      lastAttemptAt: this.marketSyncMetrics.lastAttemptAt,
      lastSuccessAt: this.marketSyncMetrics.lastSuccessAt ?? this.state.marketData.syncedAt,
      lastFailureAt: this.marketSyncMetrics.lastFailureAt,
      lastDurationMs: this.marketSyncMetrics.lastDurationMs,
      lastSuccessDurationMs: this.marketSyncMetrics.lastSuccessDurationMs,
      lastFailureDurationMs: this.marketSyncMetrics.lastFailureDurationMs,
      marketDataAgeMs: ageMs(this.state.marketData.syncedAt),
      marketsInLatestSnapshot: this.marketSyncMetrics.lastMarketCount || this.state.markets.length,
      counters: { ...this.marketSyncMetrics.counters },
      consecutiveFailureCount: this.marketSyncMetrics.consecutiveFailureCount,
      error: this.state.marketData.error ?? this.lastMarketError
    };
  }

  private buildStrategyEvaluationDiagnostics(): RuntimeDiagnostics['strategyEvaluation'] {
    const report = this.strategyMetrics.lastReport;
    return {
      safeToExpose: true,
      engineId: this.state.strategy.engineId,
      strategyVersion: this.state.strategy.strategyVersion,
      status: this.state.strategy.status,
      lastSnapshotTrigger: this.strategyMetrics.lastSnapshotTrigger,
      lastEvaluationTrigger: this.strategyMetrics.lastEvaluationTrigger,
      lastStartedAt: this.strategyMetrics.lastStartedAt,
      lastCompletedAt: this.strategyMetrics.lastCompletedAt,
      lastSuccessAt: this.strategyMetrics.lastSuccessAt,
      lastDurationMs: this.strategyMetrics.lastDurationMs,
      lastEvaluatedAt: this.state.strategy.lastEvaluatedAt,
      lastError: this.strategyMetrics.lastError,
      counters: { ...this.strategyMetrics.counters },
      watchedMarketCount: this.state.strategy.watchedMarketCount,
      candidateCount: this.state.strategy.candidateCount,
      eligibleMarketCount: report?.totals.eligibleMarkets ?? 0,
      rejectedMarketCount: report?.totals.rejectedMarkets ?? 0,
      emittedIntentCount: report?.totals.emittedIntents ?? 0,
      submittedIntentCount: this.strategyMetrics.latestSubmittedIntentCount,
      openIntentCount: this.state.strategy.openIntentCount,
      openPositionCount: this.state.strategy.openPositionCount,
      openExposureUsd: this.state.strategy.openExposureUsd,
      riskDecisionCount: this.state.strategy.riskDecisions.length,
      rejectReasonBreakdown: countRejectReasons(report),
      notes: [...this.state.strategy.notes]
    };
  }

  private buildPersistenceDiagnostics(stateFileBytes: number, fileLastModifiedAt: string | null): RuntimeDiagnostics['persistence'] {
    return {
      safeToExpose: true,
      statePath: this.statePath,
      stateFileBytes,
      pendingWrite: this.persistTimer !== null || this.persistenceMetrics.inFlight,
      lastScheduledAt: this.persistenceMetrics.lastScheduledAt,
      lastStartedAt: this.persistenceMetrics.lastStartedAt,
      lastPersistedAt: this.persistenceMetrics.lastPersistedAt ?? fileLastModifiedAt,
      lastDurationMs: this.persistenceMetrics.lastDurationMs,
      counters: { ...this.persistenceMetrics.counters },
      lastError: this.persistenceMetrics.lastError
    };
  }

  private buildLedgerDiagnostics(projection: LedgerProjection, fileBytes: number, lastAppendedAt: string | null): RuntimeDiagnostics['ledger'] {
    const openPositionCount = [...projection.positions.values()].filter((position) => position.status === 'open' && position.netQuantity > 0).length;
    return {
      safeToExpose: true,
      filePath: this.ledger.filePath,
      fileBytes,
      latestSequence: projection.latestSequence,
      lastAppendedAt,
      intentCount: projection.intents.size,
      orderCount: projection.orders.size,
      openOrderCount: getOpenOrders(projection).length,
      fillCount: projection.fills.length,
      positionCount: projection.positions.size,
      openPositionCount,
      positionEventCount: projection.positionEvents.length,
      anomalyCount: projection.anomalies.length,
      anomalies: projection.anomalies.slice(0, 5)
    };
  }

  private buildRuntimeHealth(
    generatedAt: string,
    marketSync: RuntimeDiagnostics['marketSync'],
    strategyEvaluation: RuntimeDiagnostics['strategyEvaluation'],
    persistence: RuntimeDiagnostics['persistence'],
    ledger: RuntimeDiagnostics['ledger']
  ): RuntimeHealth {
    const warnings: string[] = [];

    if (this.state.paused) {
      warnings.push('Runtime is paused by operator.');
    }
    if (marketSync.state === 'never') {
      warnings.push('Runtime is still waiting for the first successful market sync.');
    }
    if (this.state.marketData.stale) {
      warnings.push(this.state.marketData.error ? `Market data is stale: ${this.state.marketData.error}` : 'Market data is stale.');
    }
    if (marketSync.consecutiveFailureCount > 0) {
      warnings.push(`Market sync has ${marketSync.consecutiveFailureCount} consecutive failure${marketSync.consecutiveFailureCount === 1 ? '' : 's'}.`);
    }
    if (strategyEvaluation.lastError) {
      warnings.push(`Strategy evaluation error: ${strategyEvaluation.lastError}`);
    }
    if (persistence.lastError) {
      warnings.push(`Runtime state persistence error: ${persistence.lastError}`);
    }
    if (ledger.anomalyCount > 0) {
      warnings.push(`Ledger projection reported ${ledger.anomalyCount} anomaly${ledger.anomalyCount === 1 ? '' : 'ies'}.`);
    }

    let status: RuntimeHealth['status'] = 'healthy';
    if (this.state.marketData.stale || strategyEvaluation.lastError || persistence.lastError || ledger.anomalyCount > 0) {
      status = 'degraded';
    } else if (warnings.length > 0) {
      status = 'warning';
    }

    const summary = status === 'healthy'
      ? `Paper runtime healthy, ${this.state.markets.length} markets live, ${this.state.strategy.openPositionCount} open paper position${this.state.strategy.openPositionCount === 1 ? '' : 's'}.`
      : warnings[0] ?? 'Operator attention is required.';

    return {
      safeToExpose: true,
      generatedAt,
      status,
      mode: this.state.mode,
      paused: this.state.paused,
      uptimeMs: ageMs(this.state.startedAt) ?? 0,
      heartbeatAgeMs: ageMs(this.state.lastHeartbeatAt) ?? 0,
      summary,
      warnings
    };
  }
}
