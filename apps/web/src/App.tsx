import { useEffect, useMemo, useState } from 'react';
import type {
  PaperIntentSummary,
  PaperPositionSummary,
  RiskDecisionSummary,
  RuntimeState,
  StrategyCandidate
} from '../../../packages/contracts/src/index';

const tokenStorageKey = 'phantom3-v2-control-token';

const compactUsdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1
});
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

type SocketState = 'connecting' | 'live' | 'reconnecting' | 'offline';
type Tone = 'healthy' | 'warning' | 'idle' | 'blocked' | 'info' | 'long' | 'short';

type RuntimeEnvelope = { type: 'runtime'; data: RuntimeState } | { type: 'pong'; at: string };

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

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 10_000) return compactUsdFormatter.format(value);
  return usdFormatter.format(value);
}

function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatUsd(value)}`;
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return compactNumber.format(value);
  if (Number.isInteger(value)) return integerFormatter.format(value);
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2).replace(/\.?0+$/, '');
}

function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return integerFormatter.format(Math.round(value));
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const delta = Date.now() - then;
  const absSec = Math.abs(delta) / 1000;
  const suffix = delta >= 0 ? 'ago' : 'from now';
  if (absSec < 5) return 'just now';
  if (absSec < 60) return `${Math.round(absSec)}s ${suffix}`;
  if (absSec < 3600) return `${Math.round(absSec / 60)}m ${suffix}`;
  if (absSec < 86_400) return `${Math.round(absSec / 3600)}h ${suffix}`;
  return `${Math.round(absSec / 86_400)}d ${suffix}`;
}

function formatAbsoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  return new Date(then).toLocaleString();
}

function pnlTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'idle';
  if (value > 0) return 'long';
  if (value < 0) return 'short';
  return 'idle';
}

function decisionTone(decision: RiskDecisionSummary['decision']): Tone {
  if (decision === 'approve') return 'long';
  if (decision === 'reject' || decision === 'block') return 'short';
  if (decision === 'resize') return 'warning';
  return 'idle';
}

function intentStatusTone(status: PaperIntentSummary['status']): Tone {
  if (status === 'submitted') return 'long';
  if (status === 'closed') return 'idle';
  if (status === 'watching') return 'warning';
  return 'info';
}

function strategyStatusTone(status: string): Tone {
  if (status === 'observing') return 'long';
  if (status === 'paused') return 'warning';
  if (status === 'degraded') return 'short';
  return 'idle';
}

function truncate(value: string, max = 140): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

// ──────────────────────────────────────────────────────────────────────────────

function SocketDot({ state }: { state: SocketState }) {
  const label =
    state === 'live'
      ? 'Live'
      : state === 'connecting'
      ? 'Connecting'
      : state === 'reconnecting'
      ? 'Reconnecting'
      : 'Offline';
  return (
    <span className={`socket-dot socket-${state}`} title={`WebSocket: ${label}`}>
      <span className="socket-pip" aria-hidden />
      <span className="socket-label">{label}</span>
    </span>
  );
}

function StatusBar({
  runtime,
  socketState
}: {
  runtime: RuntimeState | null;
  socketState: SocketState;
}) {
  const paused = runtime?.paused ?? false;
  const stale = runtime?.marketData.stale ?? false;
  const status = runtime?.strategy.status ?? 'idle';
  const mode = runtime?.strategy.mode ?? runtime?.mode ?? 'paper';

  const runLabel = paused ? 'Paused' : status === 'observing' ? 'Observing' : status[0].toUpperCase() + status.slice(1);
  const runTone: Tone = paused ? 'warning' : strategyStatusTone(status);

  return (
    <header className="status-bar">
      <div className="status-brand">
        <span className="brand-mark" aria-hidden />
        <div className="brand-text">
          <span className="brand-name">Phantom3</span>
          <span className="brand-sub">v2 paper desk</span>
        </div>
      </div>
      <div className="status-chips">
        <span className="chip chip-mode">{mode.toUpperCase()}</span>
        <span className={`chip chip-${runTone}`}>{runLabel}</span>
        <span className={`chip chip-${stale ? 'warning' : 'long'}`}>{stale ? 'Stale data' : 'Market live'}</span>
        <SocketDot state={socketState} />
      </div>
    </header>
  );
}

function KpiStrip({ runtime }: { runtime: RuntimeState | null }) {
  const strategy = runtime?.strategy;
  const positions = strategy?.positions ?? [];
  const unrealizedPnl = positions.reduce(
    (sum, p) => sum + (typeof p.unrealizedPnlUsd === 'number' ? p.unrealizedPnlUsd : 0),
    0
  );
  const hasPositions = positions.length > 0;
  const pnlClass = hasPositions ? (unrealizedPnl >= 0 ? 'tone-long' : 'tone-short') : 'tone-idle';

  const tiles: Array<{ label: string; value: string; hint?: string; tone?: string }> = [
    {
      label: 'Open exposure',
      value: formatUsd(strategy?.openExposureUsd ?? null),
      hint: strategy ? `${strategy.openPositionCount} position${strategy.openPositionCount === 1 ? '' : 's'}` : undefined
    },
    {
      label: 'Unrealized P&L',
      value: hasPositions ? formatSignedUsd(unrealizedPnl) : '—',
      hint: hasPositions ? 'sum of open lots' : 'no open positions',
      tone: pnlClass
    },
    {
      label: 'Open intents',
      value: formatInteger(strategy?.openIntentCount ?? 0),
      hint: `${strategy?.candidateCount ?? 0} candidates`
    },
    {
      label: 'Watched markets',
      value: formatInteger(strategy?.watchedMarketCount ?? runtime?.markets.length ?? 0),
      hint: runtime ? `sync every ${Math.round(runtime.marketData.refreshIntervalMs / 1000)}s` : undefined
    },
    {
      label: 'Last eval',
      value: formatRelative(strategy?.lastEvaluatedAt ?? null),
      hint: strategy?.lastEvaluatedAt ? formatAbsoluteTime(strategy.lastEvaluatedAt) : 'awaiting first tick'
    },
    {
      label: 'Runtime',
      value: runtime?.version ? `v${runtime.version}` : '—',
      hint: runtime?.startedAt ? `up ${formatRelative(runtime.startedAt)}` : undefined
    }
  ];

  return (
    <section className="kpi-strip" aria-label="Key metrics">
      {tiles.map((tile) => (
        <div className={`kpi-tile ${tile.tone ?? ''}`} key={tile.label}>
          <span className="kpi-label">{tile.label}</span>
          <strong className="kpi-value num">{tile.value}</strong>
          {tile.hint ? <span className="kpi-hint">{tile.hint}</span> : null}
        </div>
      ))}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function PositionRow({ position }: { position: PaperPositionSummary }) {
  const pnl = position.unrealizedPnlUsd;
  const tone = pnlTone(pnl);
  const sideTone: Tone = position.side === 'yes' ? 'long' : 'short';
  const exit = position.exit;

  return (
    <article className={`pos-row ${position.status === 'closed' ? 'is-closed' : ''}`}>
      <div className="pos-main">
        <div className="pos-headline">
          <span className={`pill pill-${sideTone}`}>{position.side.toUpperCase()}</span>
          <h3 title={position.marketQuestion}>{truncate(position.marketQuestion, 96)}</h3>
        </div>
        <div className="pos-meta">
          <span>Opened {formatRelative(position.openedAt)}</span>
          <span className={`pill pill-${position.status === 'open' ? 'info' : 'idle'} pill-ghost`}>
            {position.status}
          </span>
        </div>
      </div>
      <div className="pos-metrics">
        <div className="metric">
          <span>Qty</span>
          <strong className="num">{formatCompactNumber(position.quantity)}</strong>
        </div>
        <div className="metric">
          <span>Avg</span>
          <strong className="num">{formatPercent(position.averageEntryPrice, 1)}</strong>
        </div>
        <div className="metric">
          <span>Mark</span>
          <strong className="num">{formatPercent(position.markPrice, 1)}</strong>
        </div>
        <div className={`metric metric-pnl tone-${tone}`}>
          <span>P&amp;L</span>
          <strong className="num">{formatSignedUsd(pnl)}</strong>
        </div>
      </div>
      {exit ? (
        <div className="pos-exit">
          <span className={`chip-xs chip-${exit.status === 'armed' ? 'info' : exit.status === 'triggered' ? 'warning' : 'long'}`}>
            exit · {exit.status}
          </span>
          {exit.takeProfitPrice !== null ? (
            <span className="chip-xs chip-long-ghost">
              TP <span className="num">{formatPercent(exit.takeProfitPrice, 1)}</span>
            </span>
          ) : null}
          {exit.stopLossPrice !== null ? (
            <span className="chip-xs chip-short-ghost">
              SL <span className="num">{formatPercent(exit.stopLossPrice, 1)}</span>
            </span>
          ) : null}
          {exit.latestExitAt ? (
            <span className="chip-xs chip-idle-ghost">by {formatRelative(exit.latestExitAt)}</span>
          ) : null}
          {exit.triggers.length ? (
            <span className="chip-xs chip-warning-ghost">
              {exit.triggers.slice(0, 2).join(' · ')}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function PositionsPanel({ positions }: { positions: PaperPositionSummary[] }) {
  return (
    <section className="panel panel-positions" aria-label="Open paper positions">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Paper ledger</p>
          <h2>Open positions</h2>
        </div>
        <span className="panel-count num">{positions.length}</span>
      </header>
      {positions.length ? (
        <div className="pos-list">
          {positions.map((position) => (
            <PositionRow key={position.id} position={position} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <strong>No open positions.</strong>
          <p>When the paper engine enters a market, lots will stream in here with live mark, TP/SL and P&amp;L.</p>
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function IntentRow({ intent }: { intent: PaperIntentSummary }) {
  const sideTone: Tone = intent.side === 'yes' ? 'long' : 'short';
  const kindLabel = intent.kind === 'exit' ? 'EXIT' : 'ENTRY';
  const statusTone = intentStatusTone(intent.status);
  const guard =
    intent.maxEntryPrice !== null
      ? `≤ ${formatPercent(intent.maxEntryPrice, 1)}`
      : intent.limitPrice !== null
      ? `@ ${formatPercent(intent.limitPrice, 1)}`
      : '—';
  return (
    <article className="intent-row">
      <div className="intent-badges">
        <span className={`pill pill-${sideTone}`}>{intent.side.toUpperCase()}</span>
        <span className={`pill pill-ghost pill-${intent.kind === 'exit' ? 'warning' : 'info'}`}>{kindLabel}</span>
        {intent.reduceOnly ? <span className="pill pill-outline">reduce-only</span> : null}
      </div>
      <div className="intent-body">
        <h3 title={intent.marketQuestion}>{truncate(intent.marketQuestion, 92)}</h3>
        {intent.thesis ? <p className="intent-thesis">{truncate(intent.thesis, 140)}</p> : null}
        <div className="intent-meta">
          <span className="meta-key">size</span>
          <span className="num">{formatUsd(intent.desiredSizeUsd)}</span>
          <span className="meta-sep">·</span>
          <span className="meta-key">price</span>
          <span className="num">{guard}</span>
          <span className="meta-sep">·</span>
          <span className="meta-key">age</span>
          <span>{formatRelative(intent.createdAt)}</span>
          {intent.trigger ? (
            <>
              <span className="meta-sep">·</span>
              <span className="meta-key">trigger</span>
              <span>{intent.trigger}</span>
            </>
          ) : null}
        </div>
      </div>
      <span className={`pill pill-${statusTone} pill-status`}>{intent.status}</span>
    </article>
  );
}

function IntentsPanel({ intents }: { intents: PaperIntentSummary[] }) {
  return (
    <section className="panel panel-intents" aria-label="Strategy intents">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Strategy intents</p>
          <h2>Entry & exit queue</h2>
        </div>
        <span className="panel-count num">{intents.length}</span>
      </header>
      {intents.length ? (
        <div className="intent-list">
          {intents.slice(0, 8).map((intent) => (
            <IntentRow key={intent.id} intent={intent} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <strong>No intents staged.</strong>
          <p>Strategy will surface entry and reduce-only exit intents here as it evaluates watched markets.</p>
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function RiskRow({ decision }: { decision: RiskDecisionSummary }) {
  const tone = decisionTone(decision.decision);
  return (
    <article className="risk-row">
      <span className={`pill pill-${tone} pill-decision`}>{decision.decision}</span>
      <div className="risk-body">
        <h3 title={decision.question}>{truncate(decision.question, 88)}</h3>
        <div className="risk-meta">
          <span className="num">{formatUsd(decision.approvedSizeUsd)}</span>
          <span className="meta-sep">·</span>
          <span>{decision.kind}</span>
          {decision.reduceOnly ? (
            <>
              <span className="meta-sep">·</span>
              <span>reduce-only</span>
            </>
          ) : null}
          <span className="meta-sep">·</span>
          <span>{formatRelative(decision.createdAt)}</span>
        </div>
        {decision.reasons.length ? (
          <div className="reason-chips">
            {decision.reasons.slice(0, 4).map((reason, idx) => (
              <span className="chip-xs chip-idle-ghost" key={`${decision.id}-${idx}`}>{reason}</span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function RiskPanel({ decisions }: { decisions: RiskDecisionSummary[] }) {
  return (
    <section className="panel panel-risk" aria-label="Risk decisions">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Risk gate</p>
          <h2>Recent decisions</h2>
        </div>
        <span className="panel-count num">{decisions.length}</span>
      </header>
      {decisions.length ? (
        <div className="risk-list">
          {decisions.slice(0, 8).map((decision) => (
            <RiskRow key={decision.id} decision={decision} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <strong>No risk activity.</strong>
          <p>Approve / reject / resize decisions from the risk layer will render here as they happen.</p>
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function CandidateRow({ candidate }: { candidate: StrategyCandidate }) {
  return (
    <article className="cand-row">
      <div className="cand-score">
        <span>score</span>
        <strong className="num">{formatCompactNumber(candidate.score)}</strong>
      </div>
      <div className="cand-body">
        <h3 title={candidate.question}>{truncate(candidate.question, 84)}</h3>
        <div className="cand-prices">
          <span className="px-pill px-long">
            YES <span className="num">{formatPercent(candidate.yesPrice, 1)}</span>
          </span>
          <span className="px-pill px-short">
            NO <span className="num">{formatPercent(candidate.noPrice, 1)}</span>
          </span>
          <span className="px-pill px-neutral">
            spread <span className="num">{formatPercent(candidate.spread, 1)}</span>
          </span>
          <span className="px-pill px-neutral">
            liq <span className="num">{candidate.liquidity !== null ? compactUsdFormatter.format(candidate.liquidity) : '—'}</span>
          </span>
        </div>
        {candidate.rationale ? <p className="cand-rationale">{truncate(candidate.rationale, 160)}</p> : null}
      </div>
      <span className={`pill pill-${candidate.status === 'watch' ? 'info' : 'warning'}`}>
        {candidate.status}
      </span>
    </article>
  );
}

function StrategyAndCandidates({ runtime }: { runtime: RuntimeState | null }) {
  const strategy = runtime?.strategy;
  if (!strategy) return null;
  const candidates = strategy.candidates ?? [];
  const statusTone = runtime.paused ? 'warning' : strategyStatusTone(strategy.status);

  return (
    <section className="panel panel-strategy" aria-label="Strategy engine">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Strategy engine</p>
          <h2>{strategy.engineId}</h2>
        </div>
        <span className={`pill pill-${statusTone}`}>{runtime.paused ? 'paused' : strategy.status}</span>
      </header>
      <p className="panel-summary">{strategy.summary}</p>
      <div className="strategy-kv">
        <div><span>Version</span><strong className="num">{strategy.strategyVersion}</strong></div>
        <div><span>Mode</span><strong>{strategy.mode}</strong></div>
        <div><span>Watching</span><strong className="num">{strategy.watchedMarketCount}</strong></div>
        <div><span>Candidates</span><strong className="num">{strategy.candidateCount}</strong></div>
        <div><span>Intents</span><strong className="num">{strategy.openIntentCount}</strong></div>
        <div><span>Exposure</span><strong className="num">{formatUsd(strategy.openExposureUsd)}</strong></div>
      </div>
      {strategy.notes.length ? (
        <ul className="strategy-notes">
          {strategy.notes.slice(0, 4).map((note, idx) => (
            <li key={idx}>{note}</li>
          ))}
        </ul>
      ) : null}
      <div className="panel-sub">
        <header className="panel-sub-head">
          <p className="eyebrow">Candidates</p>
          <span className="panel-count num">{candidates.length}</span>
        </header>
        {candidates.length ? (
          <div className="cand-list">
            {candidates.slice(0, 5).map((candidate) => (
              <CandidateRow key={candidate.marketId} candidate={candidate} />
            ))}
          </div>
        ) : (
          <p className="subtle small">No candidates scored yet.</p>
        )}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function MarketsPanel({ runtime }: { runtime: RuntimeState | null }) {
  const markets = runtime?.markets ?? [];
  const stale = runtime?.marketData.stale ?? false;
  return (
    <section className="panel panel-markets" aria-label="Market snapshot">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Markets · read-only</p>
          <h2>Polymarket snapshot</h2>
        </div>
        <span className={`chip chip-${stale ? 'warning' : 'long'}`}>
          {stale ? 'stale' : 'live'} · {markets.length}
        </span>
      </header>
      {markets.length ? (
        <div className="market-grid">
          {markets.slice(0, 8).map((market) => (
            <article key={market.id} className="market-card">
              <h3 title={market.question}>{truncate(market.question, 80)}</h3>
              <p className="market-sub">{truncate(market.eventTitle, 60)}</p>
              <div className="market-prices">
                <div className="price-col price-yes">
                  <span>{market.yesLabel}</span>
                  <strong className="num">{formatPercent(market.yesPrice, 1)}</strong>
                </div>
                <div className="price-col price-no">
                  <span>{market.noLabel}</span>
                  <strong className="num">{formatPercent(market.noPrice, 1)}</strong>
                </div>
              </div>
              <div className="market-meta">
                <span>vol <span className="num">{market.volume24hr !== null ? compactUsdFormatter.format(market.volume24hr) : '—'}</span></span>
                <span>liq <span className="num">{market.liquidity !== null ? compactUsdFormatter.format(market.liquidity) : '—'}</span></span>
                <span>spr <span className="num">{formatPercent(market.spread, 1)}</span></span>
              </div>
              <a className="market-link" href={market.url} target="_blank" rel="noreferrer">open on Polymarket ↗</a>
            </article>
          ))}
        </div>
      ) : (
        <p className="subtle">No live markets loaded yet.</p>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function ControlsPanel({
  token,
  setToken,
  busy,
  loading,
  sendControl,
  runtime,
  socketState
}: {
  token: string;
  setToken: (value: string) => void;
  busy: boolean;
  loading: boolean;
  sendControl: (path: '/api/control/pause' | '/api/control/resume') => Promise<void> | void;
  runtime: RuntimeState | null;
  socketState: SocketState;
}) {
  return (
    <section className="panel panel-controls" aria-label="Controls and access">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Controls</p>
          <h2>Pause / resume</h2>
        </div>
        <span className={`pill pill-${runtime?.paused ? 'warning' : 'long'}`}>
          {runtime?.paused ? 'paused' : 'running'}
        </span>
      </header>
      <label className="token-field">
        <span>Control token</span>
        <input
          type="password"
          placeholder="Paste token to enable pause/resume"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
        />
      </label>
      <div className="button-row">
        <button
          className="btn btn-warning"
          disabled={busy || loading || !token}
          onClick={() => void sendControl('/api/control/pause')}
        >
          Pause
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || loading || !token}
          onClick={() => void sendControl('/api/control/resume')}
        >
          Resume
        </button>
      </div>
      <p className="subtle small">
        Paper-only runtime. Controls flip strategy evaluation on/off. No real exchange writes are performed.
      </p>
      <div className="access-kv">
        <div><span>Public URL</span><strong>{runtime?.publicBaseUrl ?? '—'}</strong></div>
        <div><span>Transport</span><strong>WebSocket · {socketState}</strong></div>
        <div><span>Heartbeat</span><strong className="num">{runtime?.lastHeartbeatAt ? new Date(runtime.lastHeartbeatAt).toLocaleTimeString() : '—'}</strong></div>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function EventsPanel({ runtime }: { runtime: RuntimeState | null }) {
  const [expanded, setExpanded] = useState(false);
  const events = runtime?.events ?? [];
  const preview = expanded ? events : events.slice(0, 3);
  return (
    <section className="panel panel-events" aria-label="Event log">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Event log</p>
          <h2>Latest activity</h2>
        </div>
        <button
          type="button"
          className="link-button"
          onClick={() => setExpanded((v) => !v)}
          disabled={events.length <= 3}
        >
          {expanded ? 'collapse' : `show all (${events.length})`}
        </button>
      </header>
      {preview.length ? (
        <ul className="event-list">
          {preview.map((entry) => (
            <li className={`event event-${entry.level}`} key={entry.id}>
              <span className={`chip-xs chip-${entry.level === 'error' ? 'short' : entry.level === 'warning' ? 'warning' : 'info'}-ghost`}>
                {entry.level}
              </span>
              <div className="event-body">
                <strong>{entry.message}</strong>
                <span className="event-time">{formatRelative(entry.at)} · {formatAbsoluteTime(entry.at)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="subtle small">No events yet.</p>
      )}
    </section>
  );
}

function ModulesAndWatchlist({ runtime }: { runtime: RuntimeState | null }) {
  return (
    <section className="panel panel-modules" aria-label="Modules and watchlist">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Infrastructure</p>
          <h2>Modules &amp; watchlist</h2>
        </div>
      </header>
      <div className="module-split">
        <div>
          <p className="mini-eyebrow">Modules</p>
          <ul className="module-mini-list">
            {runtime?.modules.map((module) => (
              <li key={module.id} className={`module-mini module-${module.status}`}>
                <span className={`chip-xs chip-${module.status === 'healthy' ? 'long' : module.status === 'warning' ? 'warning' : module.status === 'blocked' ? 'short' : 'idle'}-ghost`}>
                  {module.status}
                </span>
                <div>
                  <strong>{module.name}</strong>
                  <p className="subtle small">{module.summary}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mini-eyebrow">Watchlist</p>
          <ul className="module-mini-list">
            {runtime?.watchlist.map((entry) => (
              <li key={entry.id} className="module-mini">
                <span className={`chip-xs chip-${entry.status === 'active' ? 'long' : entry.status === 'planned' ? 'warning' : 'idle'}-ghost`}>
                  {entry.status}
                </span>
                <div>
                  <strong>{entry.label}</strong>
                  <p className="subtle small">{entry.note}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

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
        if (cancelled) return;
        setSocketState('live');
        setError(null);
      });

      socket.addEventListener('message', (event) => {
        if (cancelled) return;
        try {
          const message = JSON.parse(event.data) as RuntimeEnvelope;
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
        if (!cancelled) setSocketState('offline');
      });

      socket.addEventListener('close', () => {
        if (cancelled) return;
        setSocketState('reconnecting');
        reconnectTimer = window.setTimeout(connect, 1500);
      });
    };

    void loadFallback();
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(tokenStorageKey, token);
  }, [token]);

  const { positions, intents, riskDecisions } = useMemo(() => {
    const strategy = runtime?.strategy;
    return {
      positions: strategy?.positions ?? [],
      intents: strategy?.intents ?? [],
      riskDecisions: strategy?.riskDecisions ?? []
    };
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
        headers: { 'x-phantom3-token': token }
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({} as { error?: string }));
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
    <div className="app-shell">
      <StatusBar runtime={runtime} socketState={socketState} />
      <main className="app-main">
        {error ? (
          <div className="error-banner" role="alert">
            <strong>⚠ {error}</strong>
            <button type="button" className="link-button" onClick={() => setError(null)}>dismiss</button>
          </div>
        ) : null}

        <KpiStrip runtime={runtime} />

        <div className="grid-primary">
          <PositionsPanel positions={positions} />
          <RiskPanel decisions={riskDecisions} />
        </div>

        <IntentsPanel intents={intents} />

        <div className="grid-secondary">
          <StrategyAndCandidates runtime={runtime} />
          <ControlsPanel
            token={token}
            setToken={setToken}
            busy={busy}
            loading={loading}
            sendControl={sendControl}
            runtime={runtime}
            socketState={socketState}
          />
        </div>

        <MarketsPanel runtime={runtime} />

        <div className="grid-tertiary">
          <EventsPanel runtime={runtime} />
          <ModulesAndWatchlist runtime={runtime} />
        </div>

        <footer className="app-foot">
          <span>Phantom3 v2 · paper-only observer · {runtime?.version ? `v${runtime.version}` : ''}</span>
          <span className="subtle small">No real exchange writes are performed. This is a paper-trading dashboard.</span>
        </footer>
      </main>
    </div>
  );
}
