import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type {
  PaperIntentSummary,
  PaperStrategyView,
  RiskDecisionSummary,
  RuntimeEvent,
  RuntimeExecutionSummary,
  RuntimeLiveControl,
  RuntimeMarket,
  RuntimeMarketData,
  RuntimeModule,
  RuntimeState,
  StrategyRuntimeSummary,
  StrategyStateSnapshot,
  WatchEntry
} from '../../../packages/contracts/src/index.js';
import { strategyStateSnapshotSchema } from '../../../packages/contracts/src/index.js';
import { getOpenOrders, JsonlLedger, positionKeyFor, type ProjectedPosition } from '../../../packages/ledger/src/index.js';
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
import { createRuntimeExecutionSummary } from './execution-runtime.js';

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

function inferOutcomeSide(market: RuntimeMarket, tokenId: string): 'yes' | 'no' {
  if (market.noTokenId && tokenId === market.noTokenId) {
    return 'no';
  }
  if (tokenId.endsWith(':no')) {
    return 'no';
  }
  return 'yes';
}

function buildLiveControlSummary(live: RuntimeLiveControl): string {
  if (live.killSwitchActive) {
    return `Kill switch is active${live.killSwitchReason ? ` (${live.killSwitchReason})` : ''}. New entries stay blocked until an operator releases it.`;
  }

  if (!live.configured) {
    return 'Paper-safe default. Live control plane is disabled for this process.';
  }

  if (!live.armable) {
    return 'Live mode was requested in config, but process-level arming is disabled. No live adapter is installed, so venue writes stay blocked.';
  }

  if (live.armed) {
    return 'Live control plane is armed at the operator layer, but no live adapter is installed yet, so venue writes remain blocked.';
  }

  return 'Live control plane is configured but disarmed. Paper execution remains authoritative until a live adapter exists.';
}

function createInitialLiveControl(config: AppConfig): RuntimeLiveControl {
  const live = {
    configured: config.liveModeEnabled,
    armable: config.liveArmingEnabled,
    armed: false,
    liveAdapterReady: false,
    killSwitchActive: false,
    killSwitchReason: null,
    flattenSupported: true,
    lastOperatorAction: null,
    lastOperatorActionAt: null,
    summary: ''
  } satisfies RuntimeLiveControl;

  live.summary = buildLiveControlSummary(live);
  return live;
}

function executionModuleStatus(state: RuntimeState): RuntimeModule['status'] {
  if (state.execution.tradeStates.error > 0) {
    return 'blocked';
  }
  if (state.execution.live.killSwitchActive || state.execution.tradeStates.reconcile > 0 || state.execution.live.armed) {
    return 'warning';
  }
  if (state.execution.tradeStates.open > 0 || state.execution.tradeStates.pending > 0 || state.execution.live.configured) {
    return 'healthy';
  }
  return 'blocked';
}

function buildModules(state: RuntimeState): RuntimeModule[] {
  return [
    { id: 'config', name: 'Config Gate', status: 'healthy', summary: 'Environment parsed, remote controls token-gated.' },
    { id: 'dashboard', name: 'Dashboard', status: 'healthy', summary: 'Mobile dashboard served from Fastify static host over live WebSocket updates.' },
    {
      id: 'ledger',
      name: 'Paper Ledger',
      status: state.execution.trades.length > 0 ? 'healthy' : 'warning',
      summary: state.execution.trades.length > 0
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
      status: executionModuleStatus(state),
      summary: state.execution.trades.length > 0 || state.execution.live.configured || state.execution.live.killSwitchActive
        ? state.execution.summary
        : 'Live execution intentionally not implemented in milestone 1.'
    }
  ];
}

function buildWatchlist(state: RuntimeState): WatchEntry[] {
  const totalTrackedTrades = state.execution.tradeStates.pending + state.execution.tradeStates.reconcile + state.execution.tradeStates.open;

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
      note: state.execution.live.configured
        ? `Paper execution is still authoritative while the live control plane is ${state.execution.live.armed ? 'armed' : 'disarmed'}.`
        : 'Live trading remains disarmed by design.'
    },
    {
      id: 'live-control-plane',
      label: 'Live control plane',
      status: state.execution.live.killSwitchActive ? 'disabled' : state.execution.live.configured ? 'active' : 'planned',
      note: state.execution.live.summary
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
      note: totalTrackedTrades > 0
        ? `Ledger tracks ${state.execution.tradeStates.pending} pending, ${state.execution.tradeStates.reconcile} reconcile, and ${state.execution.tradeStates.open} open trade state${totalTrackedTrades === 1 ? '' : 's'}.`
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
    execution: {
      requestedMode: config.liveModeEnabled ? 'live' : 'paper',
      summary: config.liveModeEnabled
        ? 'Live control plane is configured, but paper execution remains authoritative until a live adapter exists.'
        : 'Paper execution remains the only writer. No ledger-backed trades have been recorded yet.',
      tradeStates: {
        pending: 0,
        reconcile: 0,
        open: 0,
        closed: 0,
        error: 0
      },
      trades: [],
      live: createInitialLiveControl(config)
    } satisfies RuntimeExecutionSummary,
    modules: [] as RuntimeModule[],
    watchlist: [] as WatchEntry[],
    events: [
      event('info', 'Phantom3 v2 bootstrap initialized.'),
      event('info', `Remote dashboard ${config.remoteDashboardEnabled ? 'enabled' : 'disabled'} at ${config.publicBaseUrl}`),
      ...(config.liveModeEnabled
        ? [event('warning', 'Live control plane is configured, but no live adapter is installed. Paper execution remains authoritative.')]
        : []),
      event('warning', 'Execution remains disarmed while milestone 1 builds out read-only truth first.')
    ]
  } satisfies RuntimeState;

  state.modules = buildModules(state);
  state.watchlist = buildWatchlist(state);
  return state;
}

type RuntimeListener = (state: RuntimeState) => void;
type PersistedRuntimeState = Partial<RuntimeState> & { strategySnapshots?: unknown } & Record<string, unknown>;
type RuntimeProjection = Awaited<ReturnType<JsonlLedger['readProjection']>>;

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
      await this.refreshExecutionState();
      this.pushEvent('info', 'Reloaded persisted bootstrap state.');
    } catch {
      this.syncStrategyState('bootstrap', this.currentStrategyPayload());
      await this.refreshExecutionState();
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

  async armLive(): Promise<{ ok: true; armed: boolean; changed: boolean }> {
    const live = this.state.execution.live;
    if (!live.configured) {
      throw new Error('Live mode is not enabled for this process.');
    }
    if (!live.armable) {
      throw new Error('Live mode was requested, but arming is disabled for this process.');
    }
    if (live.killSwitchActive) {
      throw new Error('Cannot arm the live control plane while the kill switch is active.');
    }
    if (live.armed) {
      return { ok: true, armed: true, changed: false };
    }

    this.replaceLiveControl({
      ...live,
      armed: true,
      lastOperatorAction: 'arm-live',
      lastOperatorActionAt: isoNow(),
      summary: ''
    });
    await this.refreshExecutionState();
    this.pushEvent('warning', 'Operator armed the live control plane. No live adapter is installed, so venue writes remain blocked.');
    return { ok: true, armed: true, changed: true };
  }

  async disarmLive(): Promise<{ ok: true; armed: boolean; changed: boolean }> {
    const live = this.state.execution.live;
    if (!live.armed) {
      return { ok: true, armed: false, changed: false };
    }

    this.replaceLiveControl({
      ...live,
      armed: false,
      lastOperatorAction: 'disarm-live',
      lastOperatorActionAt: isoNow(),
      summary: ''
    });
    await this.refreshExecutionState();
    this.pushEvent('info', 'Operator disarmed the live control plane.');
    return { ok: true, armed: false, changed: true };
  }

  async engageKillSwitch(reason = 'operator-requested'): Promise<{ ok: true; active: boolean; changed: boolean }> {
    const live = this.state.execution.live;
    if (live.killSwitchActive && live.killSwitchReason === reason) {
      return { ok: true, active: true, changed: false };
    }

    this.replaceLiveControl({
      ...live,
      armed: false,
      killSwitchActive: true,
      killSwitchReason: reason,
      lastOperatorAction: 'engage-kill-switch',
      lastOperatorActionAt: isoNow(),
      summary: ''
    });
    await this.refreshExecutionState();
    this.pushEvent('warning', `Operator engaged the global kill switch${reason ? ` (${reason})` : ''}. New entries are now blocked.`);
    return { ok: true, active: true, changed: true };
  }

  async releaseKillSwitch(): Promise<{ ok: true; active: boolean; changed: boolean }> {
    const live = this.state.execution.live;
    if (!live.killSwitchActive) {
      return { ok: true, active: false, changed: false };
    }

    this.replaceLiveControl({
      ...live,
      killSwitchActive: false,
      killSwitchReason: null,
      lastOperatorAction: 'release-kill-switch',
      lastOperatorActionAt: isoNow(),
      summary: ''
    });
    await this.refreshExecutionState();
    this.pushEvent('info', 'Operator released the global kill switch.');
    return { ok: true, active: false, changed: true };
  }

  async flattenOpenPositions(): Promise<{ ok: true; submitted: number; reconciling: number; skipped: number; errors: string[] }> {
    if (this.state.marketData.stale || !this.state.marketData.syncedAt) {
      throw new Error('Cannot flatten positions without a fresh market snapshot.');
    }

    let projection = await this.ledger.readProjection();
    const openPositions = [...projection.positions.values()].filter((position) => position.status === 'open' && position.netQuantity > 0);
    if (openPositions.length === 0) {
      await this.refreshExecutionState(projection);
      this.pushEvent('info', 'Operator requested flatten, but no open paper positions were available.');
      return { ok: true, submitted: 0, reconciling: 0, skipped: 0, errors: [] };
    }

    const marketMap = this.marketMap();
    const observedAt = this.state.marketData.syncedAt;
    const errors: string[] = [];
    let submitted = 0;
    let reconciling = 0;
    let skipped = 0;

    for (const position of openPositions) {
      const market = marketMap.get(position.marketId);
      if (!market) {
        skipped += 1;
        errors.push(`Cannot flatten ${position.positionId}: current market snapshot is unavailable.`);
        continue;
      }

      const openOrders = getOpenOrders(projection, { marketId: position.marketId, tokenId: position.tokenId });
      if (openOrders.length > 0) {
        skipped += 1;
        errors.push(`Cannot flatten ${position.positionId} while ${openOrders.length} open order${openOrders.length === 1 ? '' : 's'} still need reconciliation.`);
        continue;
      }

      const outcomeSide = inferOutcomeSide(market, position.tokenId);
      const quote = createPaperQuote(market, outcomeSide, observedAt);
      if (!quote || quote.bestBid == null) {
        skipped += 1;
        errors.push(`Cannot flatten ${position.positionId}: best bid is unavailable for ${market.question}.`);
        continue;
      }

      const intent = this.createFlattenIntent(position, quote.bestBid, observedAt);
      if (!intent) {
        skipped += 1;
        errors.push(`Cannot flatten ${position.positionId}: invalid quantity or price.`);
        continue;
      }

      try {
        const result = await this.paperExecution.submitApprovedIntent({ intent, quote });
        projection = await this.ledger.readProjection();
        submitted += 1;
        if (result.status === 'open' || result.status === 'partially-filled') {
          reconciling += 1;
        }
      } catch (error) {
        skipped += 1;
        errors.push(error instanceof Error ? error.message : `Unknown flatten error for ${position.positionId}.`);
      }
    }

    await this.refreshExecutionState(projection);

    if (submitted === 0 && errors.length > 0) {
      this.pushEvent('warning', `Flatten request could not submit any orders. ${errors[0]}`);
    } else if (submitted > 0) {
      this.pushEvent(
        errors.length > 0 || reconciling > 0 ? 'warning' : 'info',
        `Operator submitted ${submitted} flatten order${submitted === 1 ? '' : 's'}${reconciling > 0 ? `; ${reconciling} still need reconciliation` : ''}${errors.length > 0 ? `; ${errors.length} position${errors.length === 1 ? '' : 's'} were skipped` : ''}.`
      );
    }

    return { ok: true, submitted, reconciling, skipped, errors };
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
    const { strategySnapshots: _strategySnapshots, strategy: _strategy, execution: _execution, ...rest } = existing;
    const marketData = {
      ...base.marketData,
      ...(typeof existing.marketData === 'object' && existing.marketData ? existing.marketData : {}),
      refreshIntervalMs: this.config.marketRefreshMs
    } as RuntimeMarketData;

    const markets = Array.isArray(existing.markets) ? existing.markets : base.markets;
    const events = Array.isArray(existing.events) ? existing.events : base.events;
    const live = this.hydrateLiveControl(existing, base);

    const hydratedState = {
      ...base,
      ...rest,
      lastHeartbeatAt: isoNow(),
      publicBaseUrl: this.config.publicBaseUrl,
      remoteDashboardEnabled: this.config.remoteDashboardEnabled,
      marketData,
      markets,
      events,
      execution: {
        ...base.execution,
        requestedMode: live.configured ? 'live' : 'paper',
        live,
        tradeStates: base.execution.tradeStates,
        trades: [],
        summary: base.execution.summary
      }
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

  private hydrateLiveControl(existing: PersistedRuntimeState, base: RuntimeState): RuntimeLiveControl {
    const persistedExecution = typeof existing.execution === 'object' && existing.execution ? existing.execution : null;
    const persistedLive = persistedExecution && typeof persistedExecution === 'object' && 'live' in persistedExecution
      ? persistedExecution.live
      : null;

    const live = {
      ...base.execution.live,
      armed: false,
      killSwitchActive: persistedLive && typeof persistedLive === 'object' && 'killSwitchActive' in persistedLive && typeof persistedLive.killSwitchActive === 'boolean'
        ? persistedLive.killSwitchActive
        : base.execution.live.killSwitchActive,
      killSwitchReason: persistedLive && typeof persistedLive === 'object' && 'killSwitchReason' in persistedLive
        ? typeof persistedLive.killSwitchReason === 'string' || persistedLive.killSwitchReason === null
          ? persistedLive.killSwitchReason
          : base.execution.live.killSwitchReason
        : base.execution.live.killSwitchReason,
      lastOperatorAction: persistedLive && typeof persistedLive === 'object' && 'lastOperatorAction' in persistedLive && typeof persistedLive.lastOperatorAction === 'string'
        ? persistedLive.lastOperatorAction
        : base.execution.live.lastOperatorAction,
      lastOperatorActionAt: persistedLive && typeof persistedLive === 'object' && 'lastOperatorActionAt' in persistedLive && typeof persistedLive.lastOperatorActionAt === 'string'
        ? persistedLive.lastOperatorActionAt
        : base.execution.live.lastOperatorActionAt,
      summary: ''
    } satisfies RuntimeLiveControl;

    live.summary = buildLiveControlSummary(live);
    return live;
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

  private async refreshExecutionState(projection?: RuntimeProjection): Promise<void> {
    const nextProjection = projection ?? await this.ledger.readProjection();
    const live = {
      ...this.state.execution.live,
      summary: buildLiveControlSummary(this.state.execution.live)
    } satisfies RuntimeLiveControl;

    this.state.execution = createRuntimeExecutionSummary(this.state, nextProjection, live);
    this.state.modules = buildModules(this.state);
    this.state.watchlist = buildWatchlist(this.state);
  }

  private replaceLiveControl(next: RuntimeLiveControl): void {
    const normalized = {
      ...next,
      armed: next.killSwitchActive ? false : next.armed,
      liveAdapterReady: false,
      flattenSupported: true,
      summary: ''
    } satisfies RuntimeLiveControl;

    normalized.summary = buildLiveControlSummary(normalized);
    this.state.execution = {
      ...this.state.execution,
      requestedMode: normalized.configured ? 'live' : 'paper',
      live: normalized
    };
  }

  private marketMap(markets = this.state.markets): Map<string, RuntimeMarket> {
    return new Map(markets.map((market) => [market.id, market]));
  }

  private recentIntentExists(projection: RuntimeProjection, marketId: string, tokenId: string, now: string): boolean {
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
    projection: RuntimeProjection,
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

  private currentRiskHooks() {
    if (!this.state.execution.live.killSwitchActive) {
      return undefined;
    }

    return {
      killSwitch: {
        global: {
          active: true,
          reason: this.state.execution.live.killSwitchReason ?? 'operator-requested',
          triggeredAt: this.state.execution.live.lastOperatorActionAt ?? isoNow()
        }
      }
    };
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
    projection: RuntimeProjection,
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

  private createFlattenIntent(position: ProjectedPosition, bestBid: number, observedAt: string): ApprovedTradeIntent | null {
    const quantity = Math.round(position.netQuantity * 1_000_000) / 1_000_000;
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(bestBid) || bestBid <= 0) {
      return null;
    }

    return {
      sessionId: 'phantom3-v2-operator-control',
      intentId: `flatten-${position.positionId}-${observedAt.replace(/[:.]/g, '-')}`,
      strategyId: 'operator-flatten',
      marketId: position.marketId,
      tokenId: position.tokenId,
      side: 'sell',
      limitPrice: bestBid,
      quantity,
      approvedAt: observedAt,
      thesis: 'Operator-requested flatten.',
      confidence: null,
      metadata: {
        kind: 'flatten',
        source: 'control-api'
      }
    };
  }

  private async reconcileOpenPaperOrders(snapshot: MarketSnapshot): Promise<number> {
    let filledOrderCount = 0;

    for (const market of snapshot.markets) {
      for (const side of ['yes', 'no'] as const) {
        const quote = createPaperQuote(market, side, snapshot.fetchedAt);
        if (!quote) {
          continue;
        }
        const result = await this.paperExecution.reconcileQuote(quote);
        filledOrderCount += result.filledOrderIds.length;
      }
    }

    return filledOrderCount;
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
        hooks: this.currentRiskHooks(),
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
      this.state.execution.live.killSwitchActive
        ? 'Kill switch is active, so new entry intents stay blocked until an operator releases it.'
        : 'Kill switch is inactive.',
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
    await this.refreshExecutionState(projection);
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

      const reconciledOrders = await this.reconcileOpenPaperOrders(snapshot);
      await this.evaluateStrategy('market-refresh', snapshot);
      this.schedulePersist();
      this.notify();

      if (reconciledOrders > 0) {
        this.pushEvent('info', `Reconciled ${reconciledOrders} open paper order${reconciledOrders === 1 ? '' : 's'} against the latest quote.`);
      }

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
      await this.refreshExecutionState();
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
