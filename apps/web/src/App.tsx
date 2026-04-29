import { useEffect, useMemo, useState } from 'react';
import type { ModuleStatus, RuntimeState } from '../../../packages/contracts/src/index';

const tokenStorageKey = 'wraith-control-token';
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const candidateIntentPaths = [
  'candidateIntents',
  'strategy.candidateIntents',
  'strategy.intents',
  'strategy.pipeline.candidateIntents'
] as const;

const riskDecisionPaths = [
  'riskDecisions',
  'risk.decisions',
  'strategy.riskDecisions',
  'strategy.pipeline.riskDecisions'
] as const;

const paperPositionPaths = [
  'paperPositions',
  'positions',
  'paper.positions',
  'paperLedger.positions',
  'ledger.positions'
] as const;

type SocketState = 'connecting' | 'live' | 'reconnecting' | 'offline';
type Tone = ModuleStatus | 'info';
type ControlPath =
  | '/api/control/pause'
  | '/api/control/resume'
  | '/api/control/live/arm'
  | '/api/control/live/disarm'
  | '/api/control/flatten'
  | '/api/control/kill-switch/engage'
  | '/api/control/kill-switch/release';
type LooseRecord = Record<string, unknown>;

type RuntimeEnvelope = {
  type: 'runtime';
  data: RuntimeState;
};

type DetailField = {
  label: string;
  value: string;
};

type DetailCard = {
  id: string;
  title: string;
  subtitle?: string;
  badge: string;
  tone: Tone;
  fields: DetailField[];
};

type StrategyPanel = {
  heading: string;
  summary: string;
  badge: string;
  tone: Tone;
  fields: DetailField[];
};

type DetailSectionProps = {
  eyebrow: string;
  title: string;
  subtitle: string;
  emptyState: string;
  items: DetailCard[];
};

type UpDownDecision = 'CANDIDATE' | 'WATCH' | 'SKIP';

type UpDownScanRow = {
  decision: UpDownDecision;
  blockers: string[];
  asset: 'BTC' | 'ETH' | 'SOL';
  window: '5m' | '15m';
  minutesToEnd: number;
  side: 'Up' | 'Down';
  sidePrice: number | null;
  buyPrice: number | null;
  yes: number | null;
  no: number | null;
  coinbaseOpen: number;
  coinbaseCurrent: number;
  moveBps: number;
  remainingSigmaBps: number;
  modelProbability: number;
  edge: number | null;
  kellyFraction: number;
  spread: number | null;
  liquidity: number | null;
  volume24hr: number | null;
  question: string;
  slug: string;
  url: string;
};

type UpDownScanResult = {
  scannedAt: string;
  note: string;
  rows: UpDownScanRow[];
};

async function fetchRuntime(): Promise<RuntimeState> {
  const response = await fetch('/api/runtime');
  if (!response.ok) {
    throw new Error('Failed to fetch runtime');
  }
  return response.json();
}

async function fetchUpDownScan(): Promise<UpDownScanResult> {
  const response = await fetch('/api/updown-scan');
  if (!response.ok) {
    throw new Error('Failed to scan Up/Down markets');
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

function defined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function asRecordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter(defined)
    : [];
}

function resolvePath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    const record = asRecord(current);
    return record ? record[segment] : undefined;
  }, source);
}

function firstPresent(source: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = resolvePath(source, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function readString(source: unknown, paths: readonly string[]): string | null {
  const value = firstPresent(source, paths);
  return typeof value === 'string' && value.trim().length ? value : null;
}

function readNumber(source: unknown, paths: readonly string[]): number | null {
  const value = firstPresent(source, paths);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(source: unknown, paths: readonly string[]): string[] {
  const value = firstPresent(source, paths);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function isDateLike(value: string): boolean {
  return value.includes('T') && !Number.isNaN(Date.parse(value));
}

function humanizeKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1000) {
    return compactNumber.format(value);
  }
  if (Number.isInteger(value)) {
    return value.toString();
  }
  const digits = Math.abs(value) >= 1 ? 2 : 4;
  return value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatMoney(value: unknown): string {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (amount === null) {
    return formatValue(value);
  }
  const prefix = amount < 0 ? '-$' : '$';
  return `${prefix}${formatNumber(Math.abs(amount))}`;
}

function formatRatio(value: unknown): string {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (amount === null) {
    return formatValue(value);
  }
  if (amount >= 0 && amount <= 1) {
    return formatPercent(amount);
  }
  return formatNumber(amount);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  if (typeof value === 'string') {
    return isDateLike(value) ? new Date(value).toLocaleString() : value;
  }
  if (Array.isArray(value)) {
    const flattened = value.map((entry) => formatValue(entry)).filter(Boolean);
    return flattened.join(', ');
  }
  const record = asRecord(value);
  if (record) {
    const preview = Object.entries(record)
      .slice(0, 3)
      .map(([key, entry]) => `${humanizeKey(key)}: ${formatValue(entry)}`)
      .join(' · ');
    return preview;
  }
  return String(value);
}

function maybeField(
  label: string,
  value: unknown,
  formatter: (entry: unknown) => string = formatValue
): DetailField | null {
  if (value === null || value === undefined) {
    return null;
  }
  const formatted = formatter(value);
  return formatted ? { label, value: formatted } : null;
}

function toneFromValue(value: string | null | undefined): Tone {
  if (!value) {
    return 'idle';
  }
  const normalized = value.toLowerCase();
  if (['healthy', 'live', 'running', 'active', 'open', 'approve', 'approved'].some((needle) => normalized.includes(needle))) {
    return 'healthy';
  }
  if (['warning', 'stale', 'degraded', 'resize', 'paused', 'pending', 'review'].some((needle) => normalized.includes(needle))) {
    return 'warning';
  }
  if (['blocked', 'error', 'reject', 'rejected', 'closed', 'flat', 'disabled', 'halted'].some((needle) => normalized.includes(needle))) {
    return 'blocked';
  }
  if (['buy', 'sell', 'yes', 'no', 'long', 'short'].some((needle) => normalized.includes(needle))) {
    return 'info';
  }
  return 'idle';
}

function buildSubtitle(parts: Array<string | null | undefined>): string | undefined {
  const values = parts.filter((part): part is string => Boolean(part && part.trim().length));
  return values.length ? values.join(' · ') : undefined;
}

function extractArray(source: unknown, paths: readonly string[]): LooseRecord[] {
  return asRecordArray(firstPresent(source, paths));
}

function extractStrategyPanel(runtime: RuntimeState | null): StrategyPanel {
  if (!runtime) {
    return {
      heading: 'Loading strategy state',
      summary: 'Waiting for the runtime payload.',
      badge: 'loading',
      tone: 'idle',
      fields: []
    };
  }

  const strategyModule = runtime.modules.find((module) => module.id === 'strategy');
  const source =
    asRecord(firstPresent(runtime, ['strategyStatus', 'strategy', 'strategyEngine', 'strategyState'])) ??
    strategyModule ??
    null;

  const status =
    readString(source, ['status', 'state', 'phase', 'mode']) ??
    strategyModule?.status ??
    (runtime.paused ? 'paused' : 'observer');

  const fields = [
    maybeField('Version', readString(source, ['strategyVersion', 'version'])),
    maybeField('Phase', readString(source, ['phase', 'state', 'mode'])),
    maybeField('Last update', firstPresent(source, ['updatedAt', 'lastUpdatedAt', 'lastEvaluatedAt', 'lastIntentAt'])),
    maybeField('Market', readString(source, ['marketId', 'activeMarketId', 'symbol']))
  ].filter(defined);

  return {
    heading: readString(source, ['name', 'label']) ?? strategyModule?.name ?? 'Strategy Engine',
    summary:
      readString(source, ['summary', 'message', 'note']) ??
      strategyModule?.summary ??
      'Strategy payload will appear here when the engine starts publishing state.',
    badge: status,
    tone: toneFromValue(status),
    fields
  };
}

function buildCandidateIntentCards(runtime: RuntimeState | null): DetailCard[] {
  return extractArray(runtime, candidateIntentPaths).slice(0, 6).map((entry, index) => {
    const question = readString(entry, ['question', 'marketQuestion', 'marketTitle', 'label']);
    const thesis = readString(entry, ['thesis', 'summary', 'note']);
    const status = readString(entry, ['status', 'state']);
    const side = readString(entry, ['side']);
    const badge = side ?? status ?? 'candidate';

    return {
      id: readString(entry, ['intentId', 'id']) ?? `candidate-${index}`,
      title: question ?? thesis ?? `Candidate intent ${index + 1}`,
      subtitle:
        (thesis && thesis !== question ? thesis : null) ??
        buildSubtitle([
          readString(entry, ['marketId', 'slug']),
          readString(entry, ['tokenId'])
        ]),
      badge,
      tone: status ? toneFromValue(status) : toneFromValue(side),
      fields: [
        maybeField('Intent', readString(entry, ['intentId', 'id'])),
        maybeField('Market', readString(entry, ['marketId', 'slug'])),
        maybeField('Token', readString(entry, ['tokenId'])),
        maybeField('Confidence', firstPresent(entry, ['confidence', 'score', 'probability']), formatRatio),
        maybeField('Target USD', firstPresent(entry, ['desiredSizeUsd', 'sizeUsd', 'notionalUsd']), formatMoney),
        maybeField('Target size', firstPresent(entry, ['size', 'requestedSize']), formatValue),
        maybeField('Max entry', firstPresent(entry, ['maxEntryPrice', 'entryPrice', 'limitPrice']), formatValue),
        maybeField('Created', firstPresent(entry, ['createdAt', 'at']))
      ].filter(defined)
    };
  });
}

function buildRiskDecisionCards(runtime: RuntimeState | null): DetailCard[] {
  return extractArray(runtime, riskDecisionPaths).slice(0, 6).map((entry, index) => {
    const reasons = readStringArray(entry, ['reasons']);
    const decision = readString(entry, ['decision', 'status']) ?? 'pending';
    const question = readString(entry, ['question', 'marketQuestion', 'marketTitle']);
    const intentId = readString(entry, ['intentId']);

    return {
      id: readString(entry, ['id', 'intentId']) ?? `risk-${index}`,
      title: question ?? (intentId ? `Intent ${intentId}` : `Risk decision ${index + 1}`),
      subtitle: reasons.length ? reasons.join(' · ') : buildSubtitle([readString(entry, ['marketId']), readString(entry, ['note', 'message'])]),
      badge: decision,
      tone: toneFromValue(decision),
      fields: [
        maybeField('Intent', intentId),
        maybeField('Market', readString(entry, ['marketId'])),
        maybeField('Approved USD', firstPresent(entry, ['approvedSizeUsd', 'sizeUsd']), formatMoney),
        maybeField('Approved size', firstPresent(entry, ['size']), formatValue),
        maybeField('Created', firstPresent(entry, ['createdAt', 'at']))
      ].filter(defined)
    };
  });
}

function buildPaperPositionCards(runtime: RuntimeState | null): DetailCard[] {
  return extractArray(runtime, paperPositionPaths).slice(0, 6).map((entry, index) => {
    const question = readString(entry, ['question', 'marketQuestion', 'marketTitle', 'label']);
    const status = readString(entry, ['status']) ?? (readNumber(entry, ['remainingSize']) ? 'open' : 'flat');
    const side = readString(entry, ['side']);

    return {
      id: readString(entry, ['lotId', 'positionId', 'id']) ?? `position-${index}`,
      title: question ?? readString(entry, ['marketId', 'slug']) ?? `Paper position ${index + 1}`,
      subtitle: buildSubtitle([
        side,
        readString(entry, ['tokenId']),
        readString(entry, ['lotId', 'positionId'])
      ]),
      badge: status,
      tone: toneFromValue(status),
      fields: [
        maybeField('Remaining size', firstPresent(entry, ['remainingSize', 'size', 'quantity']), formatValue),
        maybeField('Avg entry', firstPresent(entry, ['averageEntryPrice', 'entryPrice']), formatValue),
        maybeField('Realized P&L', firstPresent(entry, ['realizedPnl']), formatMoney),
        maybeField('Mark', firstPresent(entry, ['unrealizedMark', 'markPrice', 'mark']), formatValue),
        maybeField('Updated', firstPresent(entry, ['updatedAt', 'closedAt', 'openedAt', 'createdAt']))
      ].filter(defined)
    };
  });
}

function UpDownScanPanel({ scan, loading, onRefresh }: { scan: UpDownScanResult | null; loading: boolean; onRefresh: () => void }) {
  const visibleRows = scan?.rows.slice(0, 9) ?? [];
  const candidateCount = scan?.rows.filter((row) => row.decision === 'CANDIDATE').length ?? 0;
  const watchCount = scan?.rows.filter((row) => row.decision === 'WATCH').length ?? 0;
  const topDecision = candidateCount ? 'CANDIDATE' : watchCount ? 'WATCH' : 'SKIP';
  const tone = topDecision === 'CANDIDATE' ? 'healthy' : topDecision === 'WATCH' ? 'warning' : 'blocked';

  return (
    <section className="card updown-card">
      <div className="section-head section-head-stack">
        <div>
          <p className="eyebrow">Crypto Up/Down scanner</p>
          <h2>{candidateCount ? `${candidateCount} candidate${candidateCount === 1 ? '' : 's'}` : watchCount ? `${watchCount} watch setup${watchCount === 1 ? '' : 's'}` : 'No trade right now'}</h2>
        </div>
        <div className="scan-actions">
          <span className={`status-pill ${tone}`}>{topDecision}</span>
          <button className="secondary compact-button" disabled={loading} onClick={onRefresh}>{loading ? 'Scanning...' : 'Refresh'}</button>
        </div>
      </div>
      <p className="subtle">{scan?.note ?? 'Waiting for the first BTC/ETH/SOL 5m + 15m scan.'}</p>
      <div className="summary-strip">
        <div className="summary-tile"><span>Candidates</span><strong>{candidateCount}</strong></div>
        <div className="summary-tile"><span>Watch</span><strong>{watchCount}</strong></div>
        <div className="summary-tile"><span>Scanned</span><strong>{scan ? scan.rows.length : '...'}</strong></div>
        <div className="summary-tile"><span>Updated</span><strong>{scan?.scannedAt ? new Date(scan.scannedAt).toLocaleTimeString() : '...'}</strong></div>
      </div>
      {visibleRows.length ? (
        <div className="updown-grid">
          {visibleRows.map((row) => (
            <article className="detail-card updown-row" key={row.slug}>
              <div className="detail-card-head">
                <div>
                  <h3>{row.asset} {row.window} · {row.side}</h3>
                  <p>{row.minutesToEnd.toFixed(1)}m left · move {row.moveBps.toFixed(2)} bps · buy {formatPercent(row.buyPrice ?? row.sidePrice)}</p>
                </div>
                <span className={`badge ${row.decision === 'CANDIDATE' ? 'healthy' : row.decision === 'WATCH' ? 'warning' : 'blocked'}`}>{row.decision}</span>
              </div>
              <div className="field-grid">
                <div className="field-chip"><span>Model / Edge</span><strong>{formatPercent(row.modelProbability)} / {formatPercent(row.edge)}</strong></div>
                <div className="field-chip"><span>Kelly cap</span><strong>{formatPercent(row.kellyFraction)}</strong></div>
                <div className="field-chip"><span>Up / Down</span><strong>{formatPercent(row.yes)} / {formatPercent(row.no)}</strong></div>
                <div className="field-chip"><span>Spread</span><strong>{formatPercent(row.spread)}</strong></div>
                <div className="field-chip"><span>Liquidity</span><strong>{formatMaybeMoney(row.liquidity)}</strong></div>
                <div className="field-chip"><span>Blockers</span><strong>{row.blockers.length ? row.blockers.join(', ') : 'none'}</strong></div>
              </div>
              <a className="market-link" href={row.url} target="_blank" rel="noreferrer">open market</a>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">No scan rows yet.</div>
      )}
    </section>
  );
}

function DetailSection({ eyebrow, title, subtitle, emptyState, items }: DetailSectionProps) {
  return (
    <article className="card">
      <div className="section-head section-head-stack">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <p className="subtle small">{subtitle}</p>
      </div>

      {items.length ? (
        <div className="detail-list">
          {items.map((item) => (
            <article className="detail-card" key={item.id}>
              <div className="detail-card-head">
                <div>
                  <h3>{item.title}</h3>
                  {item.subtitle ? <p>{item.subtitle}</p> : null}
                </div>
                <span className={`badge ${item.tone}`}>{item.badge}</span>
              </div>
              {item.fields.length ? (
                <div className="field-grid">
                  {item.fields.map((field) => (
                    <div className="field-chip" key={`${item.id}-${field.label}`}>
                      <span>{field.label}</span>
                      <strong>{field.value}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">{emptyState}</div>
      )}
    </article>
  );
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(() => localStorage.getItem(tokenStorageKey) ?? '');
  const [busy, setBusy] = useState(false);
  const [socketState, setSocketState] = useState<SocketState>('connecting');
  const [incidentReason, setIncidentReason] = useState('operator-requested');
  const [upDownScan, setUpDownScan] = useState<UpDownScanResult | null>(null);
  const [upDownLoading, setUpDownLoading] = useState(false);

  const refreshUpDownScan = async () => {
    setUpDownLoading(true);
    try {
      setUpDownScan(await fetchUpDownScan());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Up/Down scan failed');
    } finally {
      setUpDownLoading(false);
    }
  };

  useEffect(() => {
    void refreshUpDownScan();
  }, []);

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

  const candidateIntents = useMemo(() => buildCandidateIntentCards(runtime), [runtime]);
  const riskDecisions = useMemo(() => buildRiskDecisionCards(runtime), [runtime]);
  const paperPositions = useMemo(() => buildPaperPositionCards(runtime), [runtime]);
  const strategyPanel = useMemo(() => extractStrategyPanel(runtime), [runtime]);
  const liveControl = runtime?.execution.live ?? null;
  const isSimulation = runtime?.mode === 'simulation';
  const executionLabel = isSimulation ? 'Simulation' : 'Paper';
  const liveTone = useMemo<Tone>(() => {
    if (isSimulation) return 'info';
    if (!liveControl) return 'idle';
    if (liveControl.status === 'blocked-by-reconcile') return 'blocked';
    if (liveControl.killSwitchActive || liveControl.status === 'scaffold') return 'warning';
    if (liveControl.status === 'adapter-ready') return liveControl.armed ? 'healthy' : 'info';
    return 'idle';
  }, [isSimulation, liveControl]);

  const sendControl = async (path: ControlPath, body?: Record<string, unknown>) => {
    if (!token) {
      setError('Control token required for write actions.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'x-wraith-token': token,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
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
          <p className="eyebrow">Wraith</p>
          <h1>Phone-ready observer dashboard</h1>
          <p className="subtle">
            Safe-by-default v2 control plane. Market truth is read live from Polymarket; simulation mode cannot install wallet or order gateways.
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

      <UpDownScanPanel scan={upDownScan} loading={upDownLoading} onRefresh={() => void refreshUpDownScan()} />

      <section className="card">
        <div className="section-head section-head-stack">
          <div>
            <p className="eyebrow">Strategy pulse</p>
            <h2>{strategyPanel.heading}</h2>
          </div>
          <span className={`status-pill ${strategyPanel.tone}`}>{strategyPanel.badge}</span>
        </div>
        <p className="subtle">{strategyPanel.summary}</p>
        <div className="summary-strip">
          <div className="summary-tile">
            <span>Candidate intents</span>
            <strong>{candidateIntents.length}</strong>
          </div>
          <div className="summary-tile">
            <span>Risk decisions</span>
            <strong>{riskDecisions.length}</strong>
          </div>
          <div className="summary-tile">
            <span>{executionLabel} positions</span>
            <strong>{paperPositions.length}</strong>
          </div>
          <div className="summary-tile">
            <span>Runtime mode</span>
            <strong>{runtime?.mode ?? '...'}</strong>
          </div>
        </div>
        {strategyPanel.fields.length ? (
          <div className="field-grid field-grid-spacious">
            {strategyPanel.fields.map((field) => (
              <div className="field-chip" key={field.label}>
                <span>{field.label}</span>
                <strong>{field.value}</strong>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="section-head section-head-stack">
          <div>
            <p className="eyebrow">{isSimulation ? 'Simulation lock' : 'Live control plane'}</p>
            <h2>{isSimulation ? 'No wallet / no orders' : liveControl ? humanizeKey(liveControl.status) : 'Loading live controls'}</h2>
          </div>
          <span className={`status-pill ${liveTone}`}>{isSimulation ? 'simulation' : liveControl?.armed ? 'armed' : liveControl ? 'disarmed' : 'loading'}</span>
        </div>
        <p className="subtle">{isSimulation ? 'Runtime is structurally disarmed: no wallet readiness, no live adapter, no exchange order path.' : liveControl?.summary ?? 'Waiting for live control state.'}</p>
        <div className="summary-strip">
          <div className="summary-tile">
            <span>Adapter</span>
            <strong>{isSimulation ? 'not installed' : liveControl ? (liveControl.liveAdapterReady ? 'ready' : liveControl.configured ? 'scaffold' : 'paper-only') : '...'}</strong>
          </div>
          <div className="summary-tile">
            <span>Can arm</span>
            <strong>{liveControl ? (liveControl.canArm ? 'yes' : 'no') : '...'}</strong>
          </div>
          <div className="summary-tile">
            <span>Flatten path</span>
            <strong>{liveControl ? humanizeKey(liveControl.flattenPath) : '...'}</strong>
          </div>
          <div className="summary-tile">
            <span>Kill switch</span>
            <strong>{liveControl?.killSwitchActive ? 'latched' : 'clear'}</strong>
          </div>
          <div className="summary-tile">
            <span>pUSD readiness</span>
            <strong>{liveControl ? humanizeKey(liveControl.collateralReadiness.status) : '...'}</strong>
          </div>
        </div>
        <div className="field-grid field-grid-spacious">
          <div className="field-chip">
            <span>Blocking reason</span>
            <strong>{liveControl?.blockingReason ?? 'none'}</strong>
          </div>
          <div className="field-chip">
            <span>Last operator action</span>
            <strong>
              {liveControl?.lastOperatorAction
                ? `${humanizeKey(liveControl.lastOperatorAction)}${liveControl.lastOperatorActionAt ? ` · ${new Date(liveControl.lastOperatorActionAt).toLocaleString()}` : ''}`
                : 'none'}
            </strong>
          </div>
          <div className="field-chip">
            <span>Collateral proof</span>
            <strong>
              {liveControl
                ? `${liveControl.collateralReadiness.pUsdBalance ?? 'unknown'} pUSD / ${liveControl.collateralReadiness.pUsdAllowance ?? 'unknown'} allowance${liveControl.collateralReadiness.blockingReasons.length ? ` · ${liveControl.collateralReadiness.blockingReasons[0]}` : ''}`
                : 'waiting'}
            </strong>
          </div>
        </div>
      </section>

      <section className="grid two-up">
        <DetailSection
          eyebrow="Strategy output"
          title={`Candidate intents (${candidateIntents.length})`}
          subtitle={candidateIntents.length ? 'Latest strategy ideas that reached the dashboard.' : 'This list stays empty until the strategy payload publishes candidate intents.'}
          emptyState="No candidate intents in the current runtime payload yet. When the strategy engine starts emitting them, they will appear here automatically."
          items={candidateIntents}
        />
        <DetailSection
          eyebrow="Risk gate"
          title={`Risk decisions (${riskDecisions.length})`}
          subtitle={riskDecisions.length ? 'Latest approve, reject, or resize outcomes from the risk layer.' : 'This list stays empty until the runtime payload includes risk decisions.'}
          emptyState="No risk decisions are present yet. Approved, rejected, or resized intents will render here once the risk layer starts publishing them."
          items={riskDecisions}
        />
      </section>

      <DetailSection
        eyebrow={`${executionLabel} ledger`}
        title={`${executionLabel} positions (${paperPositions.length})`}
        subtitle={paperPositions.length ? `Open or recently updated ${executionLabel.toLowerCase()} positions from the runtime payload.` : `The dashboard is ready for ${executionLabel.toLowerCase()} positions as soon as the runtime starts exposing them.`}
        emptyState={`No ${executionLabel.toLowerCase()} positions are available yet. Position lots or holdings will appear here once they are added to runtime state.`}
        items={paperPositions}
      />

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
              placeholder="Paste token to enable controls"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label className="token-field control-note-field">
            <span>Kill-switch / incident note</span>
            <input
              type="text"
              placeholder="operator-requested"
              value={incidentReason}
              onChange={(event) => setIncidentReason(event.target.value)}
            />
          </label>
          <div className="control-group">
            <span>Runtime</span>
            <div className="button-row">
              <button disabled={busy || loading} onClick={() => void sendControl('/api/control/pause')}>Pause</button>
              <button className="secondary" disabled={busy || loading} onClick={() => void sendControl('/api/control/resume')}>Resume</button>
            </div>
          </div>
          {isSimulation ? (
            <div className="control-group">
              <span>Simulation lock</span>
              <p className="subtle small">Live arming is hidden because this runtime cannot construct wallet or order paths.</p>
            </div>
          ) : (
            <div className="control-group">
              <span>Live arming</span>
              <div className="button-row">
                <button disabled={busy || loading || !liveControl?.canArm} onClick={() => void sendControl('/api/control/live/arm')}>Arm live</button>
                <button className="secondary" disabled={busy || loading || !liveControl?.armed} onClick={() => void sendControl('/api/control/live/disarm')}>Disarm live</button>
              </div>
            </div>
          )}
          <div className="control-group">
            <span>Flatten</span>
            <div className="button-row">
              <button
                className={liveControl?.flattenPath === 'live' ? '' : 'secondary'}
                disabled={busy || loading || !liveControl?.flattenSupported}
                onClick={() => void sendControl('/api/control/flatten')}
              >
                {liveControl?.flattenPath === 'live'
                  ? 'Reduce-only flatten'
                  : liveControl?.flattenPath === 'paper'
                    ? isSimulation ? 'Flatten simulated positions' : 'Flatten paper positions'
                    : 'Flatten blocked'}
              </button>
            </div>
          </div>
          <div className="control-group">
            <span>Incident control</span>
            <div className="button-row">
              <button
                disabled={busy || loading || Boolean(liveControl?.killSwitchActive)}
                onClick={() => void sendControl('/api/control/kill-switch/engage', { reason: incidentReason || 'operator-requested' })}
              >
                Engage kill switch
              </button>
              <button
                className="secondary"
                disabled={busy || loading || !liveControl?.killSwitchActive}
                onClick={() => void sendControl('/api/control/kill-switch/release')}
              >
                Release kill switch
              </button>
            </div>
          </div>
          <p className="subtle small">{isSimulation ? 'Simulation controls only mutate local ledger/runtime state.' : liveControl?.summary ?? 'Waiting for control readiness.'}</p>
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
