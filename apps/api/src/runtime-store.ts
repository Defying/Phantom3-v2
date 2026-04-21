import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type {
  PaperIntentSummary,
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
import { strategyRuntimeSummarySchema, strategyStateSnapshotSchema } from '../../../packages/contracts/src/index.js';
import { getOpenOrders, JsonlLedger, positionKeyFor } from '../../../packages/ledger/src/index.js';
import { fetchTopMarkets, type MarketSnapshot } from '../../../packages/market-data/src/index.js';
import { PaperExecutionAdapter, type ApprovedTradeIntent } from '../../../packages/paper-execution/src/index.js';
import { createPaperRiskConfig, evaluatePaperTradeRisk, type PaperRiskDecision } from '../../../packages/risk/src/index.js';
import { buildStrategySignalReport, type PaperTradeIntent } from '../../../packages/strategy/src/index.js';
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

    let reloadedPersistedState = false;

    try {
      const raw = await readFile(this.statePath, 'utf8');
      const existing = JSON.parse(raw) as PersistedRuntimeState;
      this.strategySnapshots = this.hydrateStrategySnapshots(existing.strategySnapshots);
      this.state = this.hydrateState(existing);
      reloadedPersistedState = true;
    } catch {
      this.state = createInitialState(this.config);
    }

    const bootstrapPayload = await this.restoreLedgerTruth(this.currentStrategyPayload());
    this.syncStrategyState('bootstrap', bootstrapPayload, { recordSnapshot: this.strategySnapshots.length === 0 });

    if (reloadedPersistedState) {
      this.pushEvent('info', 'Reloaded persisted bootstrap state.');
    } else {
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
    const { strategySnapshots: _strategySnapshots, strategy, ...rest } = existing;
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

    const persistedStrategy = strategyRuntimeSummarySchema.safeParse(strategy);

    hydratedState.strategy = createStrategyRuntimeSummary(
      hydratedState,
      this.strategySnapshots,
      this.currentStrategyPayload(persistedStrategy.success ? persistedStrategy.data : base.strategy)
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

  private summarizePositions(markets: RuntimeMarket[]): PaperIntentSummary[] {
    void markets;
    return [];
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

  private latestLedgerRecordedAt(projection: Awaited<ReturnType<JsonlLedger['readProjection']>>): string | null {
    const timestamps = [
      ...[...projection.intents.values()].map((intent) => intent.recordedAt),
      ...[...projection.orders.values()].map((order) => order.updatedAt),
      ...projection.fills.map((fill) => fill.recordedAt),
      ...projection.positionEvents.map((event) => event.recordedAt)
    ];

    return timestamps.reduce<string | null>((latest, candidate) => {
      if (!candidate) {
        return latest;
      }
      if (!latest || candidate > latest) {
        return candidate;
      }
      return latest;
    }, null);
  }

  private async restoreLedgerTruth(payload: StrategyEvaluationPayload): Promise<StrategyEvaluationPayload> {
    const projection = await this.ledger.readProjection();
    if (projection.latestSequence === 0) {
      return payload;
    }

    const positions = this.projectionPositionsToSummaries(projection, this.marketMap());
    const restoredNotes = (payload.notes ?? []).filter(
      (note) => !note.startsWith('Recovered ') && !note.startsWith('Ledger projection reported ')
    );

    if (positions.length > 0) {
      restoredNotes.unshift(
        `Recovered ${positions.length} open paper position${positions.length === 1 ? '' : 's'} from append-only ledger truth during bootstrap.`
      );
    }

    if (projection.anomalies.length > 0) {
      restoredNotes.unshift(
        `Ledger projection reported ${projection.anomalies.length} bootstrap anomal${projection.anomalies.length === 1 ? 'y' : 'ies'}: ${projection.anomalies.join('; ')}`
      );
    }

    return {
      ...payload,
      positions,
      notes: restoredNotes,
      lastEvaluatedAt: this.latestLedgerRecordedAt(projection) ?? payload.lastEvaluatedAt ?? null
    };
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
