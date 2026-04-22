import { useEffect, useMemo, useState } from 'react';
import type {
  PaperIntentSummary,
  PaperPositionSummary,
  RiskDecisionSummary,
  RuntimeState,
  StrategyCandidate
} from '../../../packages/contracts/src/index';
import {
  buildControlHeaders,
  deriveDashboardFreshness,
  liveControlBadge,
  moduleBadge,
  watchEntryBadge,
  type DashboardFreshness
} from './dashboard-helpers';

const tokenStorageKey = 'phantom3-v2-control-token';
const tokenCookieKey = 'phantom3-v2-control-token';

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

type SocketState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'stale';
type Tone = 'healthy' | 'warning' | 'idle' | 'blocked' | 'info' | 'long' | 'short';
type TradingPreferenceOption = RuntimeState['tradingPreference']['selected'];
type StrategyRouting = NonNullable<RuntimeState['strategy']['routing']>;

type RuntimeEnvelope = { type: 'runtime'; data: RuntimeState } | { type: 'pong'; at: string };

async function fetchRuntime(token: string): Promise<RuntimeState> {
  const response = await fetch('/api/runtime', {
    headers: buildControlHeaders(token)
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Control token required to load runtime data.');
    }
    const payload = await response.json().catch(() => ({} as { error?: string }));
    throw new Error(payload.error || 'Failed to fetch runtime');
  }
  return response.json();
}

function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws`;
}

function readSessionToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(tokenStorageKey) ?? '';
  } catch {
    return '';
  }
}

function writeSessionToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) {
      window.sessionStorage.setItem(tokenStorageKey, token);
    } else {
      window.sessionStorage.removeItem(tokenStorageKey);
    }
  } catch {
    // Ignore browser storage failures and keep the in-memory copy.
  }
}

function clearLegacyTokenStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(tokenStorageKey);
  } catch {
    // Ignore browser storage failures.
  }
}

function syncTokenCookie(token: string): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    document.cookie = `${tokenCookieKey}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
    return;
  }

  document.cookie = `${tokenCookieKey}=${encodeURIComponent(trimmed)}; Path=/; SameSite=Strict${secure}`;
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

function tradingPreferenceTone(option: TradingPreferenceOption): Tone {
  return option.parityStatus === 'current-runtime' ? 'long' : 'warning';
}

function strategyRoutingTone(routing: StrategyRouting | null | undefined): Tone {
  return routing?.executionMode === 'paper-active' ? 'long' : 'warning';
}

function strategyEntryPolicyTone(routing: StrategyRouting | null | undefined): Tone {
  return routing?.entryPolicy === 'emit-new-entries' ? 'long' : 'warning';
}

function formatSelectionMode(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .split('-')
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
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
      : state === 'stale'
      ? 'Stale'
      : 'Offline';
  const title = state === 'stale' ? 'WebSocket: connected, but runtime updates are stale' : `WebSocket: ${label}`;
  return (
    <span className={`socket-dot socket-${state}`} title={title}>
      <span className="socket-pip" aria-hidden />
      <span className="socket-label">{label}</span>
    </span>
  );
}

function StatusBar({
  runtime,
  socketState,
  freshness
}: {
  runtime: RuntimeState | null;
  socketState: SocketState;
  freshness: DashboardFreshness;
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
        {freshness.stale ? <span className="chip chip-warning">Dashboard stale</span> : null}
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
  const routing = strategy.routing ?? null;
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
      {routing ? (
        <div className={`strategy-route-card ${routing.executionMode === 'reference-only' ? 'is-reference' : 'is-active'}`}>
          <div className="strategy-route-head">
            <strong>{routing.requestedLabel}</strong>
            <div className="strategy-route-badges">
              <span className={`chip-xs chip-${strategyRoutingTone(routing)}-ghost`}>
                {routing.executionMode === 'paper-active' ? 'active runtime' : 'reference only'}
              </span>
              <span className={`chip-xs chip-${strategyEntryPolicyTone(routing)}-ghost`}>
                {routing.entryPolicy === 'emit-new-entries' ? 'new entries on' : 'manage open only'}
              </span>
            </div>
          </div>
          <p className="subtle small">{routing.summary}</p>
          <div className="strategy-route-meta">
            <span>evaluating with <strong>{routing.evaluatedLabel}</strong></span>
            <span>selection mode <strong>{formatSelectionMode(routing.selectionMode)}</strong></span>
            <span>strategy <strong className="num">{routing.strategyId}</strong></span>
            <span>version <strong className="num">{routing.strategyVersion}</strong></span>
          </div>
        </div>
      ) : null}
      <div className="strategy-kv">
        <div><span>Mode</span><strong>{strategy.mode}</strong></div>
        <div><span>Watching</span><strong className="num">{strategy.watchedMarketCount}</strong></div>
        <div><span>Candidates</span><strong className="num">{strategy.candidateCount}</strong></div>
        <div><span>Intents</span><strong className="num">{strategy.openIntentCount}</strong></div>
        <div><span>Exposure</span><strong className="num">{formatUsd(strategy.openExposureUsd)}</strong></div>
        <div><span>Version</span><strong className="num">{strategy.strategyVersion}</strong></div>
      </div>
      {strategy.notes.length ? (
        <ul className="strategy-notes">
          {strategy.notes.slice(0, 5).map((note, idx) => (
            <li key={idx}>{note}</li>
          ))}
        </ul>
      ) : null}
      <div className="panel-sub">
        <header className="panel-sub-head">
          <p className="eyebrow">{routing?.executionMode === 'reference-only' ? 'Baseline candidates' : 'Candidates'}</p>
          <span className="panel-count num">{candidates.length}</span>
        </header>
        {candidates.length ? (
          <div className="cand-list">
            {candidates.slice(0, 5).map((candidate) => (
              <CandidateRow key={candidate.marketId} candidate={candidate} />
            ))}
          </div>
        ) : (
          <p className="subtle small">
            {routing?.executionMode === 'reference-only'
              ? 'No baseline candidates are visible yet.'
              : 'No candidates scored yet.'}
          </p>
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
  saveTradingPreference,
  runtime,
  socketState,
  freshness,
  lastRuntimeMessageAt
}: {
  token: string;
  setToken: (value: string) => void;
  busy: boolean;
  loading: boolean;
  sendControl: (path: '/api/control/pause' | '/api/control/resume') => Promise<void> | void;
  saveTradingPreference: (profile: TradingPreferenceOption['profile']) => Promise<void> | void;
  runtime: RuntimeState | null;
  socketState: SocketState;
  freshness: DashboardFreshness;
  lastRuntimeMessageAt: number | null;
}) {
  const tradingPreference = runtime?.tradingPreference;
  const selectedPreference = tradingPreference?.selected ?? null;
  const availablePreferences = tradingPreference?.available ?? [];
  const routing = runtime?.strategy.routing ?? null;
  const liveControl = liveControlBadge(runtime);
  const lastConfirmedUpdate = lastRuntimeMessageAt ? new Date(lastRuntimeMessageAt).toISOString() : runtime?.lastHeartbeatAt ?? null;

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
          placeholder="Paste token to enable controls and save preference"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
        />
      </label>
      <p className="subtle small">Saved only for this browser tab. Closing the tab clears it.</p>
      {freshness.stale ? (
        <p className="subtle small">Updates are stale. Use controls cautiously until the stream resumes.</p>
      ) : null}
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

      <div className="control-divider" />

      <div className="preference-header">
        <div>
          <p className="mini-eyebrow">Trading preference</p>
          <h3>{selectedPreference?.label ?? 'No preference selected'}</h3>
        </div>
        {selectedPreference ? (
          <span className={`pill pill-${routing ? strategyRoutingTone(routing) : tradingPreferenceTone(selectedPreference)} pill-ghost`}>
            {routing
              ? routing.executionMode === 'paper-active'
                ? 'active runtime'
                : 'reference only'
              : selectedPreference.parityStatus === 'current-runtime'
                ? 'active runtime'
                : 'reference only'}
          </span>
        ) : null}
      </div>
      {selectedPreference ? <p className="subtle small">{selectedPreference.note}</p> : null}
      {routing ? (
        <div className={`preference-route-note ${routing.executionMode === 'reference-only' ? 'is-reference' : 'is-active'}`}>
          <div className="preference-route-head">
            <strong>{routing.summary}</strong>
            <span className={`chip-xs chip-${strategyEntryPolicyTone(routing)}-ghost`}>
              {routing.entryPolicy === 'emit-new-entries' ? 'new entries enabled' : 'manage open positions only'}
            </span>
          </div>
          <p className="subtle small">{routing.note}</p>
          <div className="preference-route-meta">
            <span>requested <strong>{routing.requestedLabel}</strong></span>
            <span>evaluating <strong>{routing.evaluatedLabel}</strong></span>
            <span>mode <strong>{formatSelectionMode(routing.selectionMode)}</strong></span>
          </div>
        </div>
      ) : null}
      <div className="preference-list">
        {availablePreferences.map((option) => {
          const selected = option.profile === selectedPreference?.profile;
          const tone = tradingPreferenceTone(option);
          return (
            <article className={`preference-card ${selected ? 'is-selected' : ''}`} key={option.profile}>
              <div className="preference-card-head">
                <div>
                  <strong>{option.label}</strong>
                  <p className="subtle small">{option.summary}</p>
                </div>
                <span className={`chip-xs chip-${tone}-ghost`}>
                  {selected
                    ? routing
                      ? routing.executionMode === 'paper-active'
                        ? 'selected · active'
                        : 'selected · reference'
                      : option.parityStatus === 'current-runtime'
                        ? 'selected · active'
                        : 'selected · reference'
                    : option.parityStatus === 'current-runtime'
                      ? 'runtime'
                      : 'reference'}
                </span>
              </div>
              <p className="subtle small">{option.note}</p>
              <div className="preference-meta">
                <span>{option.intendedMarkets.join(' · ')}</span>
                <span>{option.intendedTimeframes.join(' · ')}</span>
              </div>
              <button
                className={`btn ${selected ? 'btn-secondary' : 'btn-primary'}`}
                disabled={busy || loading || !token || selected}
                onClick={() => void saveTradingPreference(option.profile)}
              >
                {selected ? 'Selected' : 'Use this profile'}
              </button>
            </article>
          );
        })}
      </div>

      <p className="subtle small">
        Paper-only runtime. Controls flip strategy evaluation on or off. Preference selection now routes through an explicit profile layer so the dashboard can show when a profile is active versus reference-only.
      </p>
      <div className="access-kv">
        <div><span>Public URL</span><strong>{runtime?.publicBaseUrl ?? '—'}</strong></div>
        <div><span>Transport</span><strong>WebSocket · {socketState}</strong></div>
        <div><span>Live control</span><strong className={`pill pill-${liveControl.tone} pill-ghost`}>{liveControl.label}</strong></div>
        <div><span>Entry policy</span><strong>{routing ? (routing.entryPolicy === 'emit-new-entries' ? 'emit new paper entries' : 'manage open positions only') : '—'}</strong></div>
        <div><span>Evaluator</span><strong>{routing?.evaluatedLabel ?? '—'}</strong></div>
        <div><span>Last update</span><strong className="num">{formatRelative(lastConfirmedUpdate)}</strong></div>
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
            {runtime?.modules.map((module) => {
              const badge = moduleBadge(module, runtime);
              return (
                <li key={module.id} className={`module-mini module-${module.status}`}>
                  <span className={`chip-xs chip-${badge.tone}-ghost`}>
                    {badge.label}
                  </span>
                  <div>
                    <strong>{module.name}</strong>
                    <p className="subtle small">{module.summary}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <p className="mini-eyebrow">Watchlist</p>
          <ul className="module-mini-list">
            {runtime?.watchlist.map((entry) => {
              const badge = watchEntryBadge(entry, runtime);
              return (
                <li key={entry.id} className="module-mini">
                  <span className={`chip-xs chip-${badge.tone}-ghost`}>
                    {badge.label}
                  </span>
                  <div>
                    <strong>{entry.label}</strong>
                    <p className="subtle small">{entry.note}</p>
                  </div>
                </li>
              );
            })}
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
  const [token, setToken] = useState(() => readSessionToken());
  const [busy, setBusy] = useState(false);
  const [socketState, setSocketState] = useState<SocketState>('connecting');
  const [lastRuntimeMessageAt, setLastRuntimeMessageAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    clearLegacyTokenStorage();
    const sessionToken = token.trim();
    syncTokenCookie(sessionToken);

    if (!sessionToken) {
      setRuntime(null);
      setLastRuntimeMessageAt(null);
      setLoading(false);
      setSocketState('offline');
      setError('Enter the control token to unlock runtime data and controls.');
      return () => undefined;
    }

    setLoading(true);

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
            setLastRuntimeMessageAt(Date.now());
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

    const loadAndConnect = async () => {
      try {
        const next = await fetchRuntime(sessionToken);
        if (cancelled) return;
        setRuntime(next);
        setLastRuntimeMessageAt(Date.now());
        setLoading(false);
        setError(null);
        connect();
      } catch (err) {
        if (!cancelled) {
          setRuntime(null);
          setLastRuntimeMessageAt(null);
          setSocketState('offline');
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }
    };

    void loadAndConnect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [token]);

  useEffect(() => {
    writeSessionToken(token);
  }, [token]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { positions, intents, riskDecisions } = useMemo(() => {
    const strategy = runtime?.strategy;
    return {
      positions: strategy?.positions ?? [],
      intents: strategy?.intents ?? [],
      riskDecisions: strategy?.riskDecisions ?? []
    };
  }, [runtime]);

  const dashboardFreshness = useMemo(
    () => deriveDashboardFreshness({
      now,
      lastRuntimeMessageAt,
      lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null
    }),
    [lastRuntimeMessageAt, now, runtime?.lastHeartbeatAt]
  );
  const effectiveSocketState: SocketState = socketState === 'live' && dashboardFreshness.stale ? 'stale' : socketState;

  const sendControl = async (path: '/api/control/pause' | '/api/control/resume') => {
    const sessionToken = token.trim();
    if (!sessionToken) {
      setError('Control token required for write actions.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: buildControlHeaders(sessionToken)
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(payload.error || 'Control action failed');
      }
      const next = await fetchRuntime(sessionToken);
      setRuntime(next);
      setLastRuntimeMessageAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Control action failed');
    } finally {
      setBusy(false);
    }
  };

  const saveTradingPreference = async (profile: TradingPreferenceOption['profile']) => {
    const sessionToken = token.trim();
    if (!sessionToken) {
      setError('Control token required for write actions.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/control/trading-preference', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildControlHeaders(sessionToken)
        },
        body: JSON.stringify({ profile })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(payload.error || 'Trading preference update failed');
      }
      const next = await fetchRuntime(sessionToken);
      setRuntime(next);
      setLastRuntimeMessageAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Trading preference update failed');
    } finally {
      setBusy(false);
    }
  };

  const lastConfirmedUpdate = lastRuntimeMessageAt ? new Date(lastRuntimeMessageAt).toISOString() : runtime?.lastHeartbeatAt ?? null;

  return (
    <div className="app-shell">
      <StatusBar runtime={runtime} socketState={effectiveSocketState} freshness={dashboardFreshness} />
      <main className="app-main">
        {error ? (
          <div className="error-banner" role="alert">
            <strong>⚠ {error}</strong>
            <button type="button" className="link-button" onClick={() => setError(null)}>dismiss</button>
          </div>
        ) : null}
        {dashboardFreshness.stale ? (
          <div className="warning-banner" role="status">
            <strong>{dashboardFreshness.reason === 'heartbeat' ? 'Runtime heartbeat stalled.' : 'Dashboard updates stalled.'}</strong>
            <span>
              Last confirmed update {formatRelative(lastConfirmedUpdate)}. Treat prices, badges, and controls as potentially outdated until the stream recovers.
            </span>
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
            saveTradingPreference={saveTradingPreference}
            runtime={runtime}
            socketState={effectiveSocketState}
            freshness={dashboardFreshness}
            lastRuntimeMessageAt={lastRuntimeMessageAt}
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
