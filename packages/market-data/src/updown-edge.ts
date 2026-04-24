const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';
const COINBASE_API_BASE = 'https://api.exchange.coinbase.com';

export type UpDownDecision = 'CANDIDATE' | 'WATCH' | 'SKIP';
export type UpDownSide = 'Up' | 'Down';

export type UpDownScanThresholds = {
  minMinutesToEnd: number;
  maxMinutesToEnd: number;
  minLiquidity: number;
  maxSpread: number;
  minBufferBps: number;
  strongBufferBps: number;
  maxEntryPrice: number;
};

export type UpDownScanRow = {
  decision: UpDownDecision;
  blockers: string[];
  asset: 'BTC' | 'ETH' | 'SOL';
  window: '5m' | '15m';
  minutesToEnd: number;
  side: UpDownSide;
  sidePrice: number | null;
  yes: number | null;
  no: number | null;
  coinbaseOpen: number;
  coinbaseCurrent: number;
  moveBps: number;
  spread: number | null;
  liquidity: number | null;
  volume24hr: number | null;
  question: string;
  slug: string;
  url: string;
};

export type UpDownScanResult = {
  scannedAt: string;
  note: string;
  thresholds: UpDownScanThresholds;
  rows: UpDownScanRow[];
};

type AssetConfig = {
  asset: 'btc' | 'eth' | 'sol';
  product: string;
  output: 'BTC' | 'ETH' | 'SOL';
};

type WindowConfig = {
  minutes: 5 | 15;
  seconds: 300 | 900;
  output: '5m' | '15m';
};

type GammaEvent = {
  slug?: string | null;
  title?: string | null;
  volume24hr?: number | string | null;
  endDate?: string | null;
  markets?: GammaMarket[] | null;
};

type GammaMarket = {
  slug?: string | null;
  question?: string | null;
  endDate?: string | null;
  clobTokenIds?: string | string[] | null;
  outcomes?: string | string[] | null;
  spread?: number | string | null;
  liquidity?: number | string | null;
  liquidityClob?: number | string | null;
  volume24hr?: number | string | null;
};

type MidpointResponse = { mid?: string | number | null };
type CoinbaseTickerResponse = { price?: string | number | null };

type ScanOptions = Partial<UpDownScanThresholds> & {
  nowMs?: number;
  userAgent?: string;
};

const ASSETS: AssetConfig[] = [
  { asset: 'btc', product: 'BTC-USD', output: 'BTC' },
  { asset: 'eth', product: 'ETH-USD', output: 'ETH' },
  { asset: 'sol', product: 'SOL-USD', output: 'SOL' }
];

const WINDOWS: WindowConfig[] = [
  { minutes: 5, seconds: 300, output: '5m' },
  { minutes: 15, seconds: 900, output: '15m' }
];

const DEFAULT_THRESHOLDS: UpDownScanThresholds = {
  minMinutesToEnd: 0.75,
  maxMinutesToEnd: 20,
  minLiquidity: 10000,
  maxSpread: 0.02,
  minBufferBps: 8,
  strongBufferBps: 18,
  maxEntryPrice: 0.93
};

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function getJson<T>(url: string, userAgent: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json() as Promise<T>;
}

async function gammaEventBySlug(slug: string, userAgent: string): Promise<GammaEvent | null> {
  const url = `${GAMMA_API_BASE}/events?${new URLSearchParams({ slug, limit: '1' })}`;
  const events = await getJson<GammaEvent[]>(url, userAgent);
  return events[0] ?? null;
}

async function midpoint(tokenId: string | null, userAgent: string): Promise<number | null> {
  if (!tokenId) return null;
  try {
    const url = `${CLOB_API_BASE}/midpoint?${new URLSearchParams({ token_id: tokenId })}`;
    return asNumber((await getJson<MidpointResponse>(url, userAgent)).mid);
  } catch {
    return null;
  }
}

async function coinbaseTicker(product: string, userAgent: string): Promise<number | null> {
  const url = `${COINBASE_API_BASE}/products/${product}/ticker`;
  return asNumber((await getJson<CoinbaseTickerResponse>(url, userAgent)).price);
}

async function coinbaseOpen(product: string, granularitySeconds: number, startMs: number, userAgent: string, nowMs: number): Promise<number | null> {
  if (startMs > nowMs) return null;
  const start = new Date(startMs).toISOString();
  const end = new Date(Math.min(nowMs, startMs + granularitySeconds * 1000)).toISOString();
  const url = `${COINBASE_API_BASE}/products/${product}/candles?${new URLSearchParams({
    granularity: String(granularitySeconds),
    start,
    end
  })}`;
  try {
    const rows = await getJson<unknown[]>(url, userAgent);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const startSeconds = Math.floor(startMs / 1000);
    const matching = rows.find((row) => Array.isArray(row) && row[0] === startSeconds) ?? rows[0];
    // Coinbase candle shape: [time, low, high, open, close, volume]
    return Array.isArray(matching) ? asNumber(matching[3]) : null;
  } catch {
    return null;
  }
}

function verdict(input: {
  thresholds: UpDownScanThresholds;
  spread: number | null;
  liquidity: number | null;
  minutesToEnd: number;
  bufferBps: number;
  sidePrice: number | null;
}): { decision: UpDownDecision; blockers: string[] } {
  const blockers: string[] = [];
  if (input.minutesToEnd < input.thresholds.minMinutesToEnd) blockers.push('too-close-to-resolution');
  if (input.minutesToEnd > input.thresholds.maxMinutesToEnd) blockers.push('too-early');
  if (input.spread === null || input.spread > input.thresholds.maxSpread) blockers.push('spread-too-wide');
  if (input.liquidity === null || input.liquidity < input.thresholds.minLiquidity) blockers.push('liquidity-too-low');
  if (Math.abs(input.bufferBps) < input.thresholds.minBufferBps) blockers.push('not-enough-price-buffer');
  if (input.sidePrice === null || input.sidePrice > input.thresholds.maxEntryPrice) blockers.push('entry-too-expensive');

  if (blockers.length > 0) return { decision: 'SKIP', blockers };
  if (Math.abs(input.bufferBps) >= input.thresholds.strongBufferBps) return { decision: 'CANDIDATE', blockers: [] };
  return { decision: 'WATCH', blockers: ['buffer-not-strong'] };
}

export async function scanUpDownEdge(options: ScanOptions = {}): Promise<UpDownScanResult> {
  const nowMs = options.nowMs ?? Date.now();
  const userAgent = options.userAgent ?? 'Wraith-updown-scanner/0.1';
  const thresholds: UpDownScanThresholds = { ...DEFAULT_THRESHOLDS, ...options };
  const rows: UpDownScanRow[] = [];

  for (const asset of ASSETS) {
    const current = await coinbaseTicker(asset.product, userAgent);
    if (current === null) continue;

    for (const window of WINDOWS) {
      const currentStart = Math.floor(nowMs / 1000 / window.seconds) * window.seconds;
      for (let i = 0; i <= 4; i += 1) {
        const startSeconds = currentStart + i * window.seconds;
        const startMs = startSeconds * 1000;
        const slug = `${asset.asset}-updown-${window.output}-${startSeconds}`;
        const event = await gammaEventBySlug(slug, userAgent);
        const market = event?.markets?.[0];
        const endDate = market?.endDate ?? event?.endDate ?? null;
        if (!event || !market || !endDate) continue;

        const minutesToEnd = (Date.parse(endDate) - nowMs) / 60_000;
        if (minutesToEnd < -1 || minutesToEnd > thresholds.maxMinutesToEnd + 5) continue;

        const open = await coinbaseOpen(asset.product, window.seconds, startMs, userAgent, nowMs);
        if (open === null) continue;

        const moveBps = ((current - open) / open) * 10_000;
        const side: UpDownSide = moveBps >= 0 ? 'Up' : 'Down';
        const tokens = parseStringArray(market.clobTokenIds);
        const outcomes = parseStringArray(market.outcomes);
        const yes = await midpoint(tokens[0] ?? null, userAgent);
        const no = await midpoint(tokens[1] ?? null, userAgent);
        const sidePrice = side === (outcomes[0] ?? 'Up') ? yes : no;
        const spread = asNumber(market.spread);
        const liquidity = asNumber(market.liquidityClob) ?? asNumber(market.liquidity);
        const decision = verdict({ thresholds, spread, liquidity, minutesToEnd, bufferBps: moveBps, sidePrice });

        rows.push({
          decision: decision.decision,
          blockers: decision.blockers,
          asset: asset.output,
          window: window.output,
          minutesToEnd: Number(minutesToEnd.toFixed(2)),
          side,
          sidePrice,
          yes,
          no,
          coinbaseOpen: open,
          coinbaseCurrent: current,
          moveBps: Number(moveBps.toFixed(2)),
          spread,
          liquidity,
          volume24hr: asNumber(market.volume24hr) ?? asNumber(event.volume24hr),
          question: market.question ?? event.title ?? slug,
          slug,
          url: `https://polymarket.com/event/${event.slug ?? slug}`
        });
      }
    }
  }

  rows.sort((a, b) => {
    const rank: Record<UpDownDecision, number> = { CANDIDATE: 0, WATCH: 1, SKIP: 2 };
    return rank[a.decision] - rank[b.decision] || a.minutesToEnd - b.minutesToEnd || Math.abs(b.moveBps) - Math.abs(a.moveBps);
  });

  return {
    scannedAt: new Date(nowMs).toISOString(),
    note: 'Uses Coinbase spot candles as a proxy. Polymarket resolves against Chainlink streams; require a large buffer and manual source check before any live action.',
    thresholds,
    rows
  };
}
