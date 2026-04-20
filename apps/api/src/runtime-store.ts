import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { RuntimeState, RuntimeEvent } from '../../../packages/contracts/src/index.js';

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

export class RuntimeStore {
  private readonly statePath: string;
  private state: RuntimeState;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: AppConfig) {
    this.statePath = join(config.dataDir, 'runtime-state.json');
    const now = isoNow();
    this.state = {
      appName: 'Phantom3 v2',
      version: '0.1.0',
      mode: 'paper',
      startedAt: now,
      lastHeartbeatAt: now,
      paused: false,
      remoteDashboardEnabled: config.remoteDashboardEnabled,
      publicBaseUrl: config.publicBaseUrl,
      modules: [
        { id: 'config', name: 'Config Gate', status: 'healthy', summary: 'Environment parsed, remote controls token-gated.' },
        { id: 'dashboard', name: 'Dashboard', status: 'healthy', summary: 'Mobile dashboard served from Fastify static host.' },
        { id: 'ledger', name: 'Bootstrap Ledger', status: 'warning', summary: 'File-backed runtime state only, real append-only ledger not wired yet.' },
        { id: 'market-data', name: 'Market Data Adapter', status: 'idle', summary: 'Stubbed for Milestone 0, no live feed connected yet.' },
        { id: 'strategy', name: 'Strategy Engine', status: 'idle', summary: 'Not ported from v1 yet.' },
        { id: 'execution', name: 'Execution Gateway', status: 'blocked', summary: 'Live execution intentionally not implemented in bootstrap.' }
      ],
      watchlist: [
        { id: 'read-only', label: 'Read-only observer', status: 'active', note: 'Dashboard and control plane bootstrap is live.' },
        { id: 'paper-mode', label: 'Paper mode only', status: 'active', note: 'Live trading remains disarmed by design.' },
        { id: 'ledger-upgrade', label: 'Ledger upgrade', status: 'planned', note: 'Replace file store with append-only durable ledger.' }
      ],
      events: [
        event('info', 'Phantom3 v2 bootstrap initialized.'),
        event('info', `Remote dashboard ${config.remoteDashboardEnabled ? 'enabled' : 'disabled'} at ${config.publicBaseUrl}`),
        event('warning', 'Execution and market-data adapters are still scaffold status.')
      ]
    };
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await mkdir(this.config.logDir, { recursive: true });
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const existing = JSON.parse(raw) as RuntimeState;
      this.state = {
        ...existing,
        lastHeartbeatAt: isoNow(),
        publicBaseUrl: this.config.publicBaseUrl,
        remoteDashboardEnabled: this.config.remoteDashboardEnabled
      };
      this.pushEvent('info', 'Reloaded persisted bootstrap state.');
    } catch {
      await this.persist();
    }
  }

  getState(): RuntimeState {
    return this.state;
  }

  pushEvent(level: RuntimeEvent['level'], message: string): void {
    this.state.events = [event(level, message), ...this.state.events].slice(0, 40);
    this.schedulePersist();
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
    this.state.lastHeartbeatAt = isoNow();
    this.pushEvent('info', paused ? 'Operator paused the runtime.' : 'Operator resumed the runtime.');
  }

  heartbeat(): void {
    this.state.lastHeartbeatAt = isoNow();
    this.schedulePersist();
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

  private async persist(): Promise<void> {
    await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}
