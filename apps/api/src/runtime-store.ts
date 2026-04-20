import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { fetchTopMarkets } from '../../../packages/market-data/src/index.js';
import type { RuntimeState, RuntimeEvent, RuntimeMarketData, WatchEntry, RuntimeModule } from '../../../packages/contracts/src/index.js';

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

function buildModules(marketData: RuntimeMarketData, marketCount: number): RuntimeModule[] {
  return [
    { id: 'config', name: 'Config Gate', status: 'healthy', summary: 'Environment parsed, remote controls token-gated.' },
    { id: 'dashboard', name: 'Dashboard', status: 'healthy', summary: 'Mobile dashboard served from Fastify static host over live WebSocket updates.' },
    {
      id: 'ledger',
      name: 'Bootstrap Ledger',
      status: 'warning',
      summary: 'File-backed runtime state only, append-only paper ledger still needs to land.'
    },
    {
      id: 'market-data',
      name: 'Market Data Adapter',
      status: marketData.stale ? 'warning' : 'healthy',
      summary: marketData.stale
        ? marketData.error ?? 'Waiting for a live Polymarket snapshot.'
        : `Tracking ${marketCount} active markets from Polymarket Gamma + CLOB.`
    },
    { id: 'strategy', name: 'Strategy Engine', status: 'idle', summary: 'Not ported from v1 yet, runtime remains observer-first.' },
    { id: 'execution', name: 'Execution Gateway', status: 'blocked', summary: 'Live execution intentionally not implemented in milestone 1.' }
  ];
}

function buildWatchlist(marketData: RuntimeMarketData, marketCount: number): WatchEntry[] {
  return [
    {
      id: 'market-snapshot',
      label: 'Read-only market snapshot',
      status: marketData.stale ? 'disabled' : 'active',
      note: marketData.stale
        ? marketData.error ?? 'Waiting on first Gamma + CLOB sync.'
        : `Tracking ${marketCount} live markets on a ${Math.round(marketData.refreshIntervalMs / 1000)}s cadence.`
    },
    {
      id: 'paper-mode',
      label: 'Paper mode only',
      status: 'active',
      note: 'Live trading remains disarmed by design.'
    },
    {
      id: 'ledger-upgrade',
      label: 'Ledger upgrade',
      status: 'planned',
      note: 'Replace runtime-state JSON with an append-only paper ledger before strategy work.'
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

  return {
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
    modules: buildModules(marketData, 0),
    watchlist: buildWatchlist(marketData, 0),
    events: [
      event('info', 'Phantom3 v2 bootstrap initialized.'),
      event('info', `Remote dashboard ${config.remoteDashboardEnabled ? 'enabled' : 'disabled'} at ${config.publicBaseUrl}`),
      event('warning', 'Execution remains disarmed while milestone 1 builds out read-only truth first.')
    ]
  };
}

type RuntimeListener = (state: RuntimeState) => void;
type PersistedRuntimeState = Partial<RuntimeState> & Record<string, unknown>;

export class RuntimeStore {
  private readonly statePath: string;
  private state: RuntimeState;
  private persistTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<RuntimeListener>();
  private marketRefreshInFlight: Promise<void> | null = null;
  private marketSyncState: 'never' | 'ok' | 'error' = 'never';
  private lastMarketError: string | null = null;

  constructor(private readonly config: AppConfig) {
    this.statePath = join(config.dataDir, 'runtime-state.json');
    this.state = createInitialState(config);
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await mkdir(this.config.logDir, { recursive: true });
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const existing = JSON.parse(raw) as PersistedRuntimeState;
      this.state = this.hydrateState(existing);
      this.pushEvent('info', 'Reloaded persisted bootstrap state.');
    } catch {
      await this.persist();
    }
    await this.refreshMarketData();
  }

  getState(): RuntimeState {
    return structuredClone(this.state);
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
    const marketData = {
      ...base.marketData,
      ...(typeof existing.marketData === 'object' && existing.marketData ? existing.marketData : {}),
      refreshIntervalMs: this.config.marketRefreshMs
    } as RuntimeMarketData;

    const markets = Array.isArray(existing.markets) ? existing.markets : base.markets;
    const modules = Array.isArray(existing.modules) ? existing.modules : buildModules(marketData, markets.length);
    const watchlist = Array.isArray(existing.watchlist) ? existing.watchlist : buildWatchlist(marketData, markets.length);
    const events = Array.isArray(existing.events) ? existing.events : base.events;

    return {
      ...base,
      ...existing,
      lastHeartbeatAt: isoNow(),
      publicBaseUrl: this.config.publicBaseUrl,
      remoteDashboardEnabled: this.config.remoteDashboardEnabled,
      marketData,
      markets,
      modules,
      watchlist,
      events
    };
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
      this.state.modules = buildModules(this.state.marketData, snapshot.markets.length);
      this.state.watchlist = buildWatchlist(this.state.marketData, snapshot.markets.length);
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
      this.state.marketData = {
        ...this.state.marketData,
        stale: true,
        error: message
      };
      this.state.modules = buildModules(this.state.marketData, this.state.markets.length);
      this.state.watchlist = buildWatchlist(this.state.marketData, this.state.markets.length);
      this.schedulePersist();
      this.notify();

      if (this.marketSyncState !== 'error' || this.lastMarketError !== message) {
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
    await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}
