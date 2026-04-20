import { useEffect, useMemo, useState } from 'react';
import type { RuntimeState } from '../../../packages/contracts/src/index';

const tokenStorageKey = 'phantom3-v2-control-token';
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

type SocketState = 'connecting' | 'live' | 'reconnecting' | 'offline';

type RuntimeEnvelope = {
  type: 'runtime';
  data: RuntimeState;
};

async function fetchRuntime(): Promise<RuntimeState> {
  const response = await fetch('/api/runtime');
  if (!response.ok) {
    throw new Error('Failed to fetch runtime');
  }
  return response.json();
}

function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws`;
}

function formatPercent(value: number | null): string {
  return value === null ? '...' : `${(value * 100).toFixed(1)}%`;
}

function formatMaybeMoney(value: number | null): string {
  return value === null ? '...' : compactNumber.format(value);
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(() => localStorage.getItem(tokenStorageKey) ?? '');
  const [busy, setBusy] = useState(false);
  const [socketState, setSocketState] = useState<SocketState>('connecting');

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const loadFallback = async () => {
      try {
        const next = await fetchRuntime();
        if (!cancelled) {
          setRuntime(next);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }
    };

    const connect = () => {
      setSocketState((current) => (current === 'live' ? 'reconnecting' : 'connecting'));
      socket = new WebSocket(websocketUrl());

      socket.addEventListener('open', () => {
        if (cancelled) {
          return;
        }
        setSocketState('live');
        setError(null);
      });

      socket.addEventListener('message', (event) => {
        if (cancelled) {
          return;
        }
        try {
          const message = JSON.parse(event.data) as RuntimeEnvelope | { type: 'pong'; at: string };
          if (message.type === 'runtime') {
            setRuntime(message.data);
            setLoading(false);
            setError(null);
          }
        } catch {
          setError('Received invalid WebSocket payload.');
        }
      });

      socket.addEventListener('error', () => {
        if (!cancelled) {
          setSocketState('offline');
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) {
          return;
        }
        setSocketState('reconnecting');
        reconnectTimer = window.setTimeout(connect, 1500);
      });
    };

    void loadFallback();
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(tokenStorageKey, token);
  }, [token]);

  const statusTone = useMemo(() => {
    if (!runtime) return 'idle';
    if (runtime.paused || runtime.marketData.stale) return 'warning';
    return 'healthy';
  }, [runtime]);

  const sendControl = async (path: '/api/control/pause' | '/api/control/resume') => {
    if (!token) {
      setError('Control token required for write actions.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'x-phantom3-token': token
        }
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Control action failed');
      }
      const next = await fetchRuntime();
      setRuntime(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Control action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <section className="hero card">
        <div>
          <p className="eyebrow">Phantom3 v2</p>
          <h1>Phone-ready observer dashboard</h1>
          <p className="subtle">
            Safe-by-default v2 control plane. Market truth is now read live from Polymarket, while write actions remain token-gated.
          </p>
        </div>
        <div className={`status-pill ${statusTone}`}>
          {runtime?.paused ? 'Paused' : runtime ? 'Running' : 'Loading'}
        </div>
      </section>

      {error ? <section className="card error-banner">{error}</section> : null}

      <section className="grid two-up">
        <article className="card">
          <p className="eyebrow">Access</p>
          <h2>{runtime?.publicBaseUrl ?? '...'}</h2>
          <p className="subtle">Open this URL from your phone while on the same network.</p>
          <div className="kv-list">
            <div><span>Mode</span><strong>{runtime?.mode ?? '...'}</strong></div>
            <div><span>Transport</span><strong>{`WebSocket (${socketState})`}</strong></div>
            <div><span>Remote dashboard</span><strong>{runtime?.remoteDashboardEnabled ? 'enabled' : 'disabled'}</strong></div>
            <div><span>Last heartbeat</span><strong>{runtime?.lastHeartbeatAt ? new Date(runtime.lastHeartbeatAt).toLocaleTimeString() : '...'}</strong></div>
          </div>
        </article>

        <article className="card">
          <p className="eyebrow">Market sync</p>
          <h2>{runtime?.marketData.stale ? 'Sync degraded' : `${runtime?.markets.length ?? 0} live markets`}</h2>
          <p className="subtle">Read-only snapshot from {runtime?.marketData.source ?? '...'}</p>
          <div className="kv-list">
            <div><span>Status</span><strong>{runtime?.marketData.stale ? 'stale' : 'live'}</strong></div>
            <div><span>Cadence</span><strong>{runtime ? `${Math.round(runtime.marketData.refreshIntervalMs / 1000)}s` : '...'}</strong></div>
            <div><span>Last sync</span><strong>{runtime?.marketData.syncedAt ? new Date(runtime.marketData.syncedAt).toLocaleTimeString() : '...'}</strong></div>
            <div><span>Error</span><strong>{runtime?.marketData.error ?? 'none'}</strong></div>
          </div>
        </article>
      </section>

      <section className="card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Markets</p>
            <h2>Read-only Polymarket snapshot</h2>
          </div>
        </div>
        {runtime?.markets.length ? (
          <div className="module-grid market-grid">
            {runtime.markets.map((market) => (
              <article key={market.id} className="module-card market-card">
                <div className={`module-status ${runtime.marketData.stale ? 'warning' : 'healthy'}`}>
                  {runtime.marketData.stale ? 'stale' : 'live'}
                </div>
                <div>
                  <h3>{market.question}</h3>
                  <p>{market.eventTitle}</p>
                </div>
                <div className="price-row">
                  <div>
                    <span>{market.yesLabel}</span>
                    <strong>{formatPercent(market.yesPrice)}</strong>
                  </div>
                  <div>
                    <span>{market.noLabel}</span>
                    <strong>{formatPercent(market.noPrice)}</strong>
                  </div>
                </div>
                <div className="market-meta">
                  <span>24h vol {formatMaybeMoney(market.volume24hr)}</span>
                  <span>liq {formatMaybeMoney(market.liquidity)}</span>
                  <span>spread {formatPercent(market.spread)}</span>
                </div>
                <a className="market-link" href={market.url} target="_blank" rel="noreferrer">open market</a>
              </article>
            ))}
          </div>
        ) : (
          <p className="subtle">No live markets loaded yet.</p>
        )}
      </section>

      <section className="grid two-up">
        <article className="card">
          <p className="eyebrow">Controls</p>
          <label className="token-field">
            <span>Control token</span>
            <input
              type="password"
              placeholder="Paste token to enable pause/resume"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button disabled={busy || loading} onClick={() => void sendControl('/api/control/pause')}>Pause</button>
            <button className="secondary" disabled={busy || loading} onClick={() => void sendControl('/api/control/resume')}>Resume</button>
          </div>
          <p className="subtle small">Live trading is not wired in this bootstrap. These controls only affect the prototype runtime state.</p>
        </article>

        <article className="card">
          <p className="eyebrow">Watchlist</p>
          <div className="stack-list">
            {runtime?.watchlist.map((entry) => (
              <div className="list-item" key={entry.id}>
                <div>
                  <strong>{entry.label}</strong>
                  <p>{entry.note}</p>
                </div>
                <span className={`badge ${entry.status}`}>{entry.status}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Modules</p>
            <h2>Current v2 surfaces</h2>
          </div>
        </div>
        <div className="module-grid">
          {runtime?.modules.map((module) => (
            <article key={module.id} className="module-card">
              <div className={`module-status ${module.status}`}>{module.status}</div>
              <h3>{module.name}</h3>
              <p>{module.summary}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">Event log</p>
        <div className="event-list">
          {runtime?.events.map((entry) => (
            <div className={`event ${entry.level}`} key={entry.id}>
              <div>
                <strong>{entry.message}</strong>
                <p>{new Date(entry.at).toLocaleString()}</p>
              </div>
              <span>{entry.level}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
