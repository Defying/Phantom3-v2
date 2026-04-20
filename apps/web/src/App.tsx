import { useEffect, useMemo, useState } from 'react';
import type { RuntimeState } from '../../../packages/contracts/src/index';

const tokenStorageKey = 'phantom3-v2-control-token';

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
    if (runtime.paused) return 'warning';
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
          <h1>Phone-ready bootstrap dashboard</h1>
          <p className="subtle">
            Safe-by-default v2 control plane. Read-only access is open, write actions require the control token.
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

      <section className="grid two-up">
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

        <article className="card">
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
        </article>
      </section>
    </main>
  );
}
