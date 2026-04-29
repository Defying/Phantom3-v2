import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type {
  PaperIntentSummary,
  PaperStrategyView,
  RiskDecisionSummary,
  RuntimeEvent,
  RuntimeExecutionSummary,
  RuntimeLiveCollateralReadiness,
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
import {
  getActiveOrders,
  getOpenOrders,
  JsonlLedger,
  positionKeyFor,
  type ApprovedTradeIntent,
  type ProjectedOrder,
  type ProjectedPosition
} from '../../../packages/ledger/src/index.js';
import {
  LiveExecutionAdapter,
  type LiveAssetReadinessResult,
  type LiveExchangeGateway,
  type LiveExecutionResult,
  type LiveStartupReconciliationResult,
  type LiveVenueStateSnapshot
} from '../../../packages/live-execution/src/index.js';
import { fetchTopMarkets, type MarketSnapshot } from '../../../packages/market-data/src/index.js';
import { PaperExecutionAdapter } from '../../../packages/paper-execution/src/index.js';
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

type FlattenResult = { ok: true; submitted: number; reconciling: number; skipped: number; errors: string[] };

export type RuntimeStoreOptions = {
  liveExchange?: LiveExchangeGateway | null;
  liveVenueSnapshot?: (() => Promise<LiveVenueStateSnapshot>) | null;
  liveSetupError?: string | null;
  marketFetcher?: typeof fetchTopMarkets;
};

type PositionExecutionPath = 'simulation' | 'paper' | 'live' | 'mixed' | 'unknown';

type LiveProjectionState = {
  activeOrderCount: number;
  reconcileOrderCount: number;
  openPositionCount: number;
  mixedPositionCount: number;
  blockingReason: string | null;
};

function createCollateralReadiness(
  config: AppConfig,
  overrides: Partial<RuntimeLiveCollateralReadiness> = {}
): RuntimeLiveCollateralReadiness {
  const required = config.liveModeEnabled && config.liveArmingEnabled;
  return {
    status: required ? 'unknown' : 'not-required',
    checkedAt: null,
    stale: required,
    pUsdBalance: null,
    pUsdAllowance: null,
    requiredPUsdBalance: config.liveExecution.minPusdBalance,
    requiredPUsdAllowance: config.liveExecution.minPusdAllowance,
    polGasBalance: null,
    requiredPolGas: config.liveExecution.minPolGas,
    blockingReasons: required ? ['pUSD collateral readiness has not been checked yet.'] : [],
    safeToLog: true,
    ...overrides
  } satisfies RuntimeLiveCollateralReadiness;
}

function mapCollateralReadiness(config: AppConfig, result: LiveAssetReadinessResult): RuntimeLiveCollateralReadiness {
  const checkedAt = result.checkedAt;
  const checkedAtMs = Date.parse(checkedAt);
  const ageMs = Number.isFinite(checkedAtMs) ? Date.now() - checkedAtMs : Number.POSITIVE_INFINITY;
  const stale = !Number.isFinite(ageMs) || ageMs > config.liveExecution.readinessMaxAgeMs;
  const blockingReasons = [...result.blockingReasons];

  if (stale) {
    blockingReasons.push(`pUSD readiness check is stale; max age is ${config.liveExecution.readinessMaxAgeMs}ms.`);
  }

  return createCollateralReadiness(config, {
    status: blockingReasons.length > 0 ? 'blocked' : 'ready',
    checkedAt,
    stale,
    pUsdBalance: result.balance,
    pUsdAllowance: result.allowance,
    requiredPUsdBalance: result.requiredBalance,
    requiredPUsdAllowance: result.requiredAllowance,
    polGasBalance: result.polGasBalance ?? null,
    requiredPolGas: result.requiredPolGas ?? config.liveExecution.minPolGas,
    blockingReasons
  });
}

function collateralBlockingReason(readiness: RuntimeLiveCollateralReadiness): string | null {
  if (readiness.status === 'not-required' || readiness.status === 'ready') {
    return null;
  }
  return readiness.blockingReasons[0] ?? 'pUSD collateral readiness is not proven.';
}

function buildLiveControlSummary(live: RuntimeLiveControl, mode: RuntimeState['mode'] = 'paper'): string {
  const killSwitchSummary = live.killSwitchActive
    ? ` Kill switch is active${live.killSwitchReason ? ` (${live.killSwitchReason})` : ''}. New automated entries stay blocked until an operator clears it.`
    : '';
  const collateralReason = collateralBlockingReason(live.collateralReadiness);
  const collateralSummary = collateralReason
    ? ` Collateral readiness blocked: ${collateralReason}`
    : live.collateralReadiness.status === 'ready'
      ? ' pUSD collateral readiness is fresh.'
      : '';

  switch (live.status) {
    case 'paper-only':
      return 'Paper-safe default. Live control plane is disabled for this process.';
    case 'scaffold':
      return `${live.blockingReason ?? 'Live control plane is configured, but the live adapter path is still scaffold-only.'} Flatten remains paper-only until a real live adapter is wired.${collateralSummary}${killSwitchSummary}`.trim();
    case 'blocked-by-reconcile': {
      const readinessSummary = live.liveAdapterReady
        ? 'Live adapter path is present, but operator actions are blocked until reconciliation is clean.'
        : 'Live control plane is configured, but operator actions remain blocked until startup reconciliation is clean.';
      const flattenSummary = live.flattenPath === 'paper'
        ? ' Paper flatten remains available for paper inventory while live controls stay blocked.'
        : ' Flatten is blocked until live orders reconcile cleanly.';
      return `${readinessSummary} ${live.blockingReason ?? 'Live state still needs reconciliation before arming or flattening.'}${flattenSummary}${collateralSummary}${killSwitchSummary}`.trim();
    }
    case 'adapter-ready': {
      const armSummary = live.armed
        ? 'Live adapter path is armed for operator controls.'
        : live.canArm
          ? 'Live adapter path is ready and can be armed for operator controls.'
          : 'Live adapter path is present, but arming is currently blocked.';
      const flattenSummary = live.flattenPath === 'live'
        ? 'Reduce-only live flatten is available when reconciled venue inventory is present.'
        : live.flattenPath === 'paper'
          ? 'Flatten remains paper-only until live inventory appears.'
          : 'Flatten is blocked until live orders reconcile cleanly.';
      const blockingReason = live.blockingReason ? ` ${live.blockingReason}` : '';
      return `${armSummary} ${flattenSummary} Automated strategy entries remain paper-only until live routing is implemented.${collateralSummary}${killSwitchSummary}${blockingReason}`.trim();
    }
  }
}

function createInitialLiveControl(config: AppConfig): RuntimeLiveControl {
  const live = {
    configured: config.liveModeEnabled,
    armable: config.liveArmingEnabled,
    armed: false,
    status: config.liveModeEnabled ? 'scaffold' : 'paper-only',
    liveAdapterReady: false,
    canArm: false,
    blockingReason: config.liveModeEnabled
      ? 'Live control plane is configured, but the operator live adapter path is not installed yet.'
      : null,
    killSwitchActive: false,
    killSwitchReason: null,
    flattenSupported: true,
    flattenPath: 'paper',
    collateralReadiness: createCollateralReadiness(config),
    lastOperatorAction: null,
    lastOperatorActionAt: null,
    summary: ''
  } satisfies RuntimeLiveControl;

  live.summary = buildLiveControlSummary(live, config.runtimeMode);
  return live;
}

function executionModuleStatus(state: RuntimeState): RuntimeModule['status'] {
  if (state.execution.tradeStates.error > 0) {
    return 'blocked';
  }
  if (state.execution.live.status === 'blocked-by-reconcile') {
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
        ? `${state.mode === 'simulation' ? 'Simulation' : 'Paper'} execution is still authoritative while the live control plane is ${state.execution.live.armed ? 'armed' : 'disarmed'} and ${state.execution.live.status}.`
        : state.mode === 'simulation' ? 'Simulation mode is active. No wallet or exchange writes are installed.' : 'Live trading remains disarmed by design.'
    },
    {
      id: 'live-control-plane',
      label: 'Live control plane',
      status: state.execution.live.status === 'paper-only'
        ? 'planned'
        : state.execution.live.status === 'blocked-by-reconcile' || state.execution.live.killSwitchActive
          ? 'disabled'
          : 'active',
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
      label: state.mode === 'simulation' ? 'Simulation ledger truth' : 'Paper ledger truth',
      status: 'active',
      note: totalTrackedTrades > 0
        ? `Ledger tracks ${state.execution.tradeStates.pending} pending, ${state.execution.tradeStates.reconcile} reconcile, and ${state.execution.tradeStates.open} open trade state${totalTrackedTrades === 1 ? '' : 's'}.`
        : state.mode === 'simulation' ? 'Append-only simulation ledger is armed and cannot place external orders.' : 'Append-only paper ledger is armed and ready for paper-only execution.'
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
    appName: 'Wraith',
    version: '0.1.0',
    mode: config.runtimeMode,
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
      mode: config.runtimeMode,
      status: 'idle',
      safeToExpose: true,
      lastEvaluatedAt: null,
      lastSnapshotAt: null,
      watchedMarketCount: 0,
      candidateCount: 0,
      openIntentCount: 0,
      openPositionCount: 0,
      openExposureUsd: 0,
      summary: config.runtimeMode === 'simulation' ? 'Simulation strategy runtime is waiting on fresh market data before evaluation.' : 'Paper strategy runtime is waiting on fresh market data before evaluation.',
      candidates: [],
      intents: [],
      riskDecisions: [],
      positions: [],
      notes: [config.runtimeMode === 'simulation' ? 'Simulation runtime. No wallet or exchange writes are performed.' : 'Paper-only runtime. No real exchange writes are performed.']
    },
    execution: {
      requestedMode: config.runtimeMode === 'simulation' ? 'simulation' : config.liveModeEnabled ? 'live' : 'paper',
      summary: config.runtimeMode === 'simulation'
        ? 'Simulation execution remains the only writer. No wallet or exchange writes are possible.'
        : config.liveModeEnabled
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
      event('info', 'Wraith bootstrap initialized.'),
      event('info', `Remote dashboard ${config.remoteDashboardEnabled ? 'enabled' : 'disabled'} at ${config.publicBaseUrl}`),
      ...(config.runtimeMode === 'simulation'
        ? [event('info', 'Simulation mode active. Wallet/live gateway construction is disabled.')]
        : config.liveModeEnabled
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
  private readonly liveExchange: LiveExchangeGateway | null;
  private readonly liveExecution: LiveExecutionAdapter | null;
  private readonly liveVenueSnapshot: (() => Promise<LiveVenueStateSnapshot>) | null;
  private readonly liveSetupError: string | null;
  private readonly marketFetcher: typeof fetchTopMarkets;
  private state: RuntimeState;
  private strategySnapshots: StrategyStateSnapshot[] = [];
  private startupReconciliationAttempted = false;
  private startupReconciliationResult: LiveStartupReconciliationResult | null = null;
  private startupReconciliationError: string | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<RuntimeListener>();
  private marketRefreshInFlight: Promise<void> | null = null;
  private marketSyncState: 'never' | 'ok' | 'error' = 'never';
  private lastMarketError: string | null = null;

  constructor(private readonly config: AppConfig, options: RuntimeStoreOptions = {}) {
    this.statePath = join(config.dataDir, 'runtime-state.json');
    if (config.runtimeMode === 'simulation' && (options.liveExchange || options.liveVenueSnapshot)) {
      throw new Error('Simulation mode must not receive live exchange or venue snapshot dependencies.');
    }
    this.ledger = new JsonlLedger({ directory: config.dataDir });
    this.paperExecution = new PaperExecutionAdapter(this.ledger, { executionMode: config.runtimeMode === 'simulation' ? 'simulation' : 'paper' });
    this.liveExchange = options.liveExchange ?? null;
    this.liveVenueSnapshot = options.liveVenueSnapshot ?? null;
    this.liveSetupError = options.liveSetupError ?? null;
    this.marketFetcher = options.marketFetcher ?? fetchTopMarkets;
    this.liveExecution = config.liveModeEnabled && config.liveExecution.enabled && this.liveExchange
      ? new LiveExecutionAdapter(this.ledger, this.liveExchange, config.liveExecution)
      : null;
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
      await this.refreshLiveCollateralReadiness();
      await this.refreshExecutionState();
      await this.reconcileLiveStartupState('startup');
      this.pushEvent('info', 'Reloaded persisted bootstrap state.');
    } catch {
      this.syncStrategyState('bootstrap', this.currentStrategyPayload());
      await this.refreshLiveCollateralReadiness();
      await this.refreshExecutionState();
      await this.reconcileLiveStartupState('startup');
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
    await this.refreshLiveCollateralReadiness();
    await this.refreshExecutionState();
    const live = this.state.execution.live;
    if (!live.configured) {
      throw new Error('Live mode is not enabled for this process.');
    }
    if (!live.canArm) {
      throw new Error(live.blockingReason ?? 'Live adapter controls are not ready to arm yet.');
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
    this.pushEvent('info', 'Operator armed the live control plane for live adapter controls. Automated strategy entries remain paper-only.');
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

    let projection: RuntimeProjection | undefined;
    if (this.liveExecution) {
      await this.liveExecution.engageKillSwitch({
        sessionId: 'wraith-operator-control',
        note: reason,
        metadata: { source: 'control-api' }
      });
      projection = await this.ledger.readProjection();
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
    await this.refreshExecutionState(projection);
    this.pushEvent('warning', `Operator engaged the global kill switch${reason ? ` (${reason})` : ''}. New entries are now blocked.`);
    return { ok: true, active: true, changed: true };
  }

  async releaseKillSwitch(): Promise<{ ok: true; active: boolean; changed: boolean }> {
    const live = this.state.execution.live;
    if (!live.killSwitchActive) {
      return { ok: true, active: false, changed: false };
    }

    let projection: RuntimeProjection | undefined;
    if (this.liveExecution) {
      projection = await this.ledger.readProjection();
      const startupBlockingReason = this.liveStartupBlockingReason();
      if (startupBlockingReason) {
        throw new Error(startupBlockingReason);
      }
      const liveProjection = this.describeLiveProjection(projection);
      if (liveProjection.reconcileOrderCount > 0 || liveProjection.activeOrderCount > 0 || liveProjection.openPositionCount > 0 || liveProjection.mixedPositionCount > 0) {
        throw new Error(liveProjection.blockingReason ?? 'Cannot release the kill switch while live state still needs reconciliation.');
      }

      await this.liveExecution.releaseKillSwitch({
        sessionId: 'wraith-operator-control',
        note: 'operator-cleared',
        metadata: { source: 'control-api' }
      });
      projection = await this.ledger.readProjection();
    }

    this.replaceLiveControl({
      ...live,
      killSwitchActive: false,
      killSwitchReason: null,
      lastOperatorAction: 'release-kill-switch',
      lastOperatorActionAt: isoNow(),
      summary: ''
    });
    await this.refreshExecutionState(projection);
    this.pushEvent('info', 'Operator released the global kill switch.');
    return { ok: true, active: false, changed: true };
  }

  async flattenOpenPositions(): Promise<FlattenResult> {
    if (this.state.marketData.stale || !this.state.marketData.syncedAt) {
      throw new Error('Cannot flatten positions without a fresh market snapshot.');
    }

    let projection = await this.ledger.readProjection();
    const openPositions = [...projection.positions.values()].filter((position) => position.status === 'open' && position.netQuantity > 0);
    if (openPositions.length === 0) {
      await this.refreshExecutionState(projection);
      this.pushEvent('info', 'Operator requested flatten, but no open positions were available.');
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

      try {
        const executionPath = this.positionExecutionPath(projection, position);
        if (executionPath === 'mixed' || executionPath === 'unknown') {
          throw new Error(`Cannot flatten ${position.positionId}: execution provenance is ${executionPath}, so the runtime cannot prove which adapter should own the exit.`);
        }

        if (this.config.runtimeMode === 'simulation' && executionPath !== 'simulation') {
          throw new Error(`Cannot flatten ${position.positionId}: simulation mode refuses to mutate ${executionPath} provenance.`);
        }

        const result = executionPath === 'live'
          ? await this.submitLiveFlatten(position, quote, projection)
          : await this.submitPaperFlatten(position, quote, observedAt);

        projection = await this.ledger.readProjection();
        submitted += 1;
        if (result.status === 'open' || result.status === 'partially-filled' || result.status === 'reconcile') {
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
      mode: this.config.runtimeMode,
      marketData,
      markets,
      events,
      execution: {
        ...base.execution,
        requestedMode: this.config.runtimeMode === 'simulation' ? 'simulation' : live.configured ? 'live' : 'paper',
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

    live.summary = buildLiveControlSummary(live, this.config.runtimeMode);
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

  private async refreshLiveCollateralReadiness(): Promise<void> {
    if (!this.config.liveModeEnabled || !this.config.liveArmingEnabled) {
      this.replaceLiveControl({
        ...this.state.execution.live,
        collateralReadiness: createCollateralReadiness(this.config)
      });
      return;
    }

    if (!this.liveExchange?.getCollateralReadiness || !this.config.liveExecution.enabled || !this.liveExecution) {
      this.replaceLiveControl({
        ...this.state.execution.live,
        collateralReadiness: createCollateralReadiness(this.config, {
          status: 'unknown',
          stale: true,
          blockingReasons: ['pUSD collateral readiness is unsupported until the live gateway exposes balance/allowance checks.']
        })
      });
      return;
    }

    try {
      const readiness = await this.liveExchange.getCollateralReadiness({
        requiredBalance: this.config.liveExecution.minPusdBalance,
        requiredAllowance: this.config.liveExecution.minPusdAllowance,
        requiredPolGas: this.config.liveExecution.minPolGas
      });
      this.replaceLiveControl({
        ...this.state.execution.live,
        collateralReadiness: mapCollateralReadiness(this.config, readiness)
      });
    } catch (error) {
      this.replaceLiveControl({
        ...this.state.execution.live,
        collateralReadiness: createCollateralReadiness(this.config, {
          status: 'blocked',
          checkedAt: isoNow(),
          stale: false,
          blockingReasons: [`pUSD collateral readiness check failed: ${error instanceof Error ? error.message : 'Unknown readiness error'}`]
        })
      });
    }
  }

  private async refreshExecutionState(projection?: RuntimeProjection): Promise<void> {
    const nextProjection = projection ?? await this.ledger.readProjection();
    const live = this.buildLiveControlState(nextProjection);

    this.state.execution = createRuntimeExecutionSummary(this.state, nextProjection, live);
    this.state.modules = buildModules(this.state);
    this.state.watchlist = buildWatchlist(this.state);
  }

  private async reconcileLiveStartupState(source: 'startup' | 'manual'): Promise<void> {
    this.startupReconciliationAttempted = false;
    this.startupReconciliationResult = null;
    this.startupReconciliationError = null;

    if (!this.state.execution.live.configured || !this.state.execution.live.armable) {
      await this.refreshExecutionState();
      return;
    }
    if (!this.config.liveExecution.enabled || !this.liveExecution || !this.liveVenueSnapshot) {
      await this.refreshExecutionState();
      return;
    }

    try {
      const snapshot = await this.liveVenueSnapshot();
      const result = await this.liveExecution.reconcileStartupState(snapshot);
      this.startupReconciliationAttempted = true;
      this.startupReconciliationResult = result;

      let projection = await this.ledger.readProjection();
      if (!result.clean) {
        if (!projection.killSwitch.active) {
          await this.liveExecution.engageKillSwitch({
            sessionId: 'wraith-startup-recovery',
            note: 'startup-reconcile-required',
            metadata: {
              source,
              observedAt: result.observedAt,
              reasons: result.reasons
            }
          });
          projection = await this.ledger.readProjection();
        }
        await this.refreshExecutionState(projection);
        this.pushEvent('warning', `Live startup reconciliation blocked arming: ${this.summarizeStartupReconciliation(result)}`);
        return;
      }

      await this.refreshExecutionState(projection);
      const exposureSummary = result.trackedLiveOrderIds.length > 0 || result.trackedLivePositionKeys.length > 0
        ? ` (${result.trackedLiveOrderIds.length} tracked live order${result.trackedLiveOrderIds.length === 1 ? '' : 's'}, ${result.trackedLivePositionKeys.length} tracked live position${result.trackedLivePositionKeys.length === 1 ? '' : 's'})`
        : '';
      this.pushEvent('info', `Live startup reconciliation restored venue truth${exposureSummary}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown startup reconciliation error';
      this.startupReconciliationAttempted = true;
      this.startupReconciliationError = `Startup venue reconciliation failed: ${message}`;

      let projection = await this.ledger.readProjection();
      if (!projection.killSwitch.active) {
        await this.liveExecution.engageKillSwitch({
          sessionId: 'wraith-startup-recovery',
          note: 'startup-reconcile-failed',
          metadata: {
            source,
            error: message
          }
        });
        projection = await this.ledger.readProjection();
      }

      await this.refreshExecutionState(projection);
      this.pushEvent('warning', this.startupReconciliationError);
    }
  }

  private replaceLiveControl(next: RuntimeLiveControl): void {
    const normalized = {
      ...next,
      armed: next.killSwitchActive ? false : next.armed,
      summary: ''
    } satisfies RuntimeLiveControl;

    normalized.summary = buildLiveControlSummary(normalized, this.config.runtimeMode);
    this.state.execution = {
      ...this.state.execution,
      requestedMode: this.config.runtimeMode === 'simulation' ? 'simulation' : normalized.configured ? 'live' : 'paper',
      live: normalized
    };
  }

  private liveAdapterInstalled(): boolean {
    return Boolean(this.liveExecution);
  }

  private liveRecoveryInstalled(): boolean {
    return this.liveAdapterInstalled() && Boolean(this.liveVenueSnapshot);
  }

  private summarizeStartupReconciliation(result: LiveStartupReconciliationResult): string {
    const [firstReason, ...rest] = result.reasons;
    if (!firstReason) {
      return 'Startup venue reconciliation still needs manual review.';
    }
    return rest.length > 0 ? `${firstReason} (+${rest.length} more)` : firstReason;
  }

  private liveStartupBlockingReason(): string | null {
    if (!this.liveRecoveryInstalled()) {
      return null;
    }
    if (!this.startupReconciliationAttempted) {
      return 'Startup venue reconciliation has not completed yet.';
    }
    if (this.startupReconciliationError) {
      return this.startupReconciliationError;
    }
    if (this.startupReconciliationResult && !this.startupReconciliationResult.clean) {
      return this.summarizeStartupReconciliation(this.startupReconciliationResult);
    }
    return null;
  }

  private buildLiveControlState(projection: RuntimeProjection): RuntimeLiveControl {
    const current = this.state.execution.live;
    const liveProjection = this.describeLiveProjection(projection);
    const latestOperatorAction = projection.operatorActions.at(-1) ?? null;
    const killSwitchActive = this.liveExecution ? projection.killSwitch.active : current.killSwitchActive;
    const killSwitchReason = this.liveExecution ? projection.killSwitch.reason : current.killSwitchReason;
    const startupBlockingReason = this.liveStartupBlockingReason();
    const liveAdapterInstalled = this.liveAdapterInstalled();
    const collateralReason = collateralBlockingReason(current.collateralReadiness);

    let status: RuntimeLiveControl['status'] = 'paper-only';
    let blockingReason: string | null = null;
    let canArm = false;
    let flattenPath: RuntimeLiveControl['flattenPath'] = 'paper';

    if (!current.configured) {
      status = 'paper-only';
    } else if (!current.armable) {
      status = 'scaffold';
      blockingReason = 'Live mode was requested in config, but process-level arming is disabled for this process.';
    } else if (!this.config.liveExecution.enabled) {
      status = 'scaffold';
      blockingReason = 'Live control plane is configured, but venue-backed live execution is disabled for this process.';
    } else if (!this.liveExecution) {
      status = 'scaffold';
      blockingReason = this.liveSetupError ?? 'Live control plane is configured, but the operator live exchange gateway is not installed yet.';
    } else if (!this.liveVenueSnapshot) {
      status = 'scaffold';
      blockingReason = 'Live control plane is configured, but the startup venue snapshot path is not installed yet.';
    } else if (startupBlockingReason) {
      status = 'blocked-by-reconcile';
      blockingReason = startupBlockingReason;
      flattenPath = liveProjection.openPositionCount > 0 || liveProjection.activeOrderCount > 0 || liveProjection.reconcileOrderCount > 0 || liveProjection.mixedPositionCount > 0
        ? 'blocked'
        : 'paper';
    } else if (collateralReason) {
      status = 'blocked-by-reconcile';
      blockingReason = collateralReason;
      flattenPath = liveProjection.openPositionCount > 0 || liveProjection.activeOrderCount > 0 || liveProjection.reconcileOrderCount > 0 || liveProjection.mixedPositionCount > 0
        ? 'blocked'
        : 'paper';
    } else if (liveProjection.blockingReason) {
      status = 'blocked-by-reconcile';
      blockingReason = liveProjection.blockingReason;
      flattenPath = liveProjection.openPositionCount > 0 || liveProjection.activeOrderCount > 0 || liveProjection.reconcileOrderCount > 0 || liveProjection.mixedPositionCount > 0
        ? 'blocked'
        : 'paper';
    } else {
      status = 'adapter-ready';
      canArm = !killSwitchActive;
      flattenPath = liveProjection.openPositionCount > 0 ? 'live' : 'paper';
      if (killSwitchActive) {
        blockingReason = `Kill switch is active${killSwitchReason ? `: ${killSwitchReason}` : '.'}`;
      }
    }

    const live = {
      ...current,
      armed: current.armed && !killSwitchActive && canArm,
      status,
      liveAdapterReady: liveAdapterInstalled,
      canArm,
      blockingReason,
      killSwitchActive,
      killSwitchReason,
      flattenSupported: flattenPath !== 'blocked',
      flattenPath,
      lastOperatorAction: latestOperatorAction?.action ?? current.lastOperatorAction,
      lastOperatorActionAt: latestOperatorAction?.recordedAt ?? current.lastOperatorActionAt,
      summary: ''
    } satisfies RuntimeLiveControl;

    live.summary = buildLiveControlSummary(live, this.config.runtimeMode);
    return live;
  }

  private describeLiveProjection(projection: RuntimeProjection): LiveProjectionState {
    const activeLiveOrders = getActiveOrders(projection).filter((order) => this.orderExecutionPath(projection, order) === 'live');
    const reconcileLiveOrders = [...projection.orders.values()].filter(
      (order) => order.status === 'reconcile' && this.orderExecutionPath(projection, order) === 'live'
    );
    const livePositions = [...projection.positions.values()].filter(
      (position) => position.status === 'open' && position.netQuantity > 0 && this.positionExecutionPath(projection, position) === 'live'
    );
    const mixedPositions = [...projection.positions.values()].filter(
      (position) => position.status === 'open' && position.netQuantity > 0 && this.positionExecutionPath(projection, position) === 'mixed'
    );

    let blockingReason: string | null = null;
    if (projection.anomalies.length > 0) {
      blockingReason = projection.anomalies[0] ?? 'Ledger projection reported an anomaly that needs reconciliation.';
    } else if (reconcileLiveOrders.length > 0) {
      blockingReason = `${reconcileLiveOrders.length} live order${reconcileLiveOrders.length === 1 ? '' : 's'} still need reconciliation before arming or flattening.`;
    } else if (activeLiveOrders.length > 0) {
      blockingReason = `${activeLiveOrders.length} live order${activeLiveOrders.length === 1 ? '' : 's'} are still working. Flatten stays blocked until cancel/reconcile support is in place.`;
    } else if (mixedPositions.length > 0) {
      blockingReason = `${mixedPositions.length} open position${mixedPositions.length === 1 ? '' : 's'} mix paper and live fills, so operator exits stay fail-closed.`;
    }

    return {
      activeOrderCount: activeLiveOrders.length,
      reconcileOrderCount: reconcileLiveOrders.length,
      openPositionCount: livePositions.length,
      mixedPositionCount: mixedPositions.length,
      blockingReason
    };
  }

  private orderExecutionPath(projection: RuntimeProjection, order: ProjectedOrder): PositionExecutionPath {
    const intent = projection.intents.get(order.intentId);
    if (!intent) {
      return 'unknown';
    }
    return intent.executionMode;
  }

  private positionExecutionPath(projection: RuntimeProjection, position: ProjectedPosition): PositionExecutionPath {
    const fillModes = new Set<PositionExecutionPath>();
    const fillMap = new Map(projection.fills.map((fill) => [fill.fillId, fill.executionMode] as const));

    for (const lot of position.lots) {
      const mode = fillMap.get(lot.sourceFillId);
      if (mode === 'simulation' || mode === 'paper' || mode === 'live') {
        fillModes.add(mode);
      }
    }

    if (fillModes.size === 0) {
      return 'unknown';
    }
    if (fillModes.size > 1) {
      return 'mixed';
    }
    return [...fillModes][0] ?? 'unknown';
  }

  private async submitPaperFlatten(
    position: ProjectedPosition,
    quote: NonNullable<ReturnType<typeof createPaperQuote>>,
    observedAt: string
  ): Promise<{ status: string }> {
    if (quote.bestBid == null) {
      throw new Error(`Cannot flatten ${position.positionId}: best bid is unavailable.`);
    }

    const intent = this.createFlattenIntent(position, quote.bestBid, observedAt);
    if (!intent) {
      throw new Error(`Cannot flatten ${position.positionId}: invalid quantity or price.`);
    }

    return this.paperExecution.submitApprovedIntent({ intent, quote });
  }

  private async submitLiveFlatten(
    position: ProjectedPosition,
    quote: NonNullable<ReturnType<typeof createPaperQuote>>,
    projection: RuntimeProjection
  ): Promise<Pick<LiveExecutionResult, 'status'>> {
    if (!this.liveExecution || !this.liveAdapterInstalled()) {
      throw new Error(`Cannot flatten ${position.positionId}: the live adapter path is not installed for this process.`);
    }

    const startupBlockingReason = this.liveStartupBlockingReason();
    if (startupBlockingReason) {
      throw new Error(`Cannot flatten ${position.positionId}: ${startupBlockingReason}`);
    }

    const liveProjection = this.describeLiveProjection(projection);
    if (liveProjection.blockingReason) {
      throw new Error(`Cannot flatten ${position.positionId}: ${liveProjection.blockingReason}`);
    }

    if (!this.liveExchange?.getConditionalTokenReadiness) {
      throw new Error(`Cannot flatten ${position.positionId}: conditional-token balance/allowance readiness is not available for this live gateway.`);
    }

    const conditionalReadiness = await this.liveExchange.getConditionalTokenReadiness({
      tokenId: position.tokenId,
      requiredBalance: position.netQuantity,
      requiredAllowance: position.netQuantity
    });
    if (conditionalReadiness.status !== 'ready') {
      throw new Error(`Cannot flatten ${position.positionId}: ${conditionalReadiness.blockingReasons[0] ?? 'conditional-token balance/allowance readiness is not proven.'}`);
    }

    return this.liveExecution.requestFlatten({
      sessionId: 'wraith-operator-control',
      marketId: position.marketId,
      tokenId: position.tokenId,
      quote,
      note: 'Operator-requested reduce-only flatten.'
    });
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
      sessionId: this.config.runtimeMode === 'simulation' ? 'wraith-simulation-runtime' : 'wraith-paper-runtime',
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
      sessionId: 'wraith-operator-control',
      intentId: `flatten-${position.positionId}-${observedAt.replace(/[:.]/g, '-')}`,
      strategyId: 'operator-flatten',
      marketId: position.marketId,
      tokenId: position.tokenId,
      side: 'sell',
      limitPrice: bestBid,
      quantity,
      reduceOnly: true,
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
      const snapshot = await this.marketFetcher({
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
