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
  minModelProbability: number;
  minEdge: number;
  maxKellyFraction: number;
};

export type UpDownScanRow = {
  decision: UpDownDecision;
  blockers: string[];
  asset: 'BTC' | 'ETH' | 'SOL';
  window: '5m' | '15m';
  minutesToEnd: number;
  side: UpDownSide;
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
type MarketPriceResponse = { price?: string | number | null };
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
  maxEntryPrice: 0.93,
  minModelProbability: 0.57,
  minEdge: 0.03,
  maxKellyFraction: 0.02
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

async function marketBuyPrice(tokenId: string | null, userAgent: string): Promise<number | null> {
  if (!tokenId) return null;
  try {
    const url = `${CLOB_API_BASE}/price?${new URLSearchParams({ token_id: tokenId, side: 'BUY' })}`;
    return asNumber((await getJson<MarketPriceResponse>(url, userAgent)).price);
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

async function coinbaseRecentReturns(product: string, userAgent: string, nowMs: number): Promise<number[]> {
  const lookbackMs = 2 * 60 * 60 * 1000;
  const start = new Date(nowMs - lookbackMs).toISOString();
  const end = new Date(nowMs).toISOString();
  const url = `${COINBASE_API_BASE}/products/${product}/candles?${new URLSearchParams({
    granularity: '60',
    start,
    end
  })}`;
  try {
    const rows = await getJson<unknown[]>(url, userAgent);
    if (!Array.isArray(rows) || rows.length < 3) return [];
    const closes = rows
      .filter((row): row is unknown[] => Array.isArray(row))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map((row) => asNumber(row[4]))
      .filter((value): value is number => value !== null && value > 0);
    const returns: number[] = [];
    for (let index = 1; index < closes.length; index += 1) {
      returns.push(Math.log(closes[index] / closes[index - 1]) * 10_000);
    }
    return returns;
  } catch {
    return [];
  }
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Number.isFinite(variance) ? Math.sqrt(variance) : null;
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function estimateDirectionalProbability(input: {
  moveBps: number;
  minutesToEnd: number;
  oneMinuteSigmaBps: number;
}): { probability: number; remainingSigmaBps: number } {
  const minutes = Math.max(input.minutesToEnd, 0.25);
  const remainingSigmaBps = Math.max(input.oneMinuteSigmaBps * Math.sqrt(minutes), 0.01);
  const z = Math.abs(input.moveBps) / remainingSigmaBps;
  return {
    probability: Math.max(0, Math.min(1, normalCdf(z))),
    remainingSigmaBps
  };
}

function kellyFraction(probability: number, price: number | null, maxKellyFraction: number): number {
  if (price === null || price <= 0 || price >= 1) return 0;
  const raw = (probability - price) / (1 - price);
  return Math.max(0, Math.min(maxKellyFraction, raw));
}

function verdict(input: {
  thresholds: UpDownScanThresholds;
  spread: number | null;
  liquidity: number | null;
  minutesToEnd: number;
  bufferBps: number;
  buyPrice: number | null;
  modelProbability: number;
  edge: number | null;
}): { decision: UpDownDecision; blockers: string[] } {
  const blockers: string[] = [];
  if (input.minutesToEnd < input.thresholds.minMinutesToEnd) blockers.push('too-close-to-resolution');
  if (input.minutesToEnd > input.thresholds.maxMinutesToEnd) blockers.push('too-early');
  if (input.spread === null || input.spread > input.thresholds.maxSpread) blockers.push('spread-too-wide');
  if (input.liquidity === null || input.liquidity < input.thresholds.minLiquidity) blockers.push('liquidity-too-low');
  if (Math.abs(input.bufferBps) < input.thresholds.minBufferBps) blockers.push('not-enough-price-buffer');
  if (input.buyPrice === null || input.buyPrice > input.thresholds.maxEntryPrice) blockers.push('entry-too-expensive');
  if (input.modelProbability < input.thresholds.minModelProbability) blockers.push('model-probability-too-low');
  if (input.edge === null || input.edge < input.thresholds.minEdge) blockers.push('edge-too-small');

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
    const recentSigma = standardDeviation(await coinbaseRecentReturns(asset.product, userAgent, nowMs));
    const oneMinuteSigmaBps = Math.max(recentSigma ?? 0, asset.output === 'BTC' ? 3 : asset.output === 'ETH' ? 4 : 6);

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
        const sideToken = side === (outcomes[0] ?? 'Up') ? tokens[0] ?? null : tokens[1] ?? null;
        const buyPrice = await marketBuyPrice(sideToken, userAgent) ?? sidePrice;
        const spread = asNumber(market.spread);
        const liquidity = asNumber(market.liquidityClob) ?? asNumber(market.liquidity);
        const model = estimateDirectionalProbability({ moveBps, minutesToEnd, oneMinuteSigmaBps });
        const edge = buyPrice === null ? null : model.probability - buyPrice;
        const decision = verdict({
          thresholds,
          spread,
          liquidity,
          minutesToEnd,
          bufferBps: moveBps,
          buyPrice,
          modelProbability: model.probability,
          edge
        });

        rows.push({
          decision: decision.decision,
          blockers: decision.blockers,
          asset: asset.output,
          window: window.output,
          minutesToEnd: Number(minutesToEnd.toFixed(2)),
          side,
          sidePrice,
          buyPrice,
          yes,
          no,
          coinbaseOpen: open,
          coinbaseCurrent: current,
          moveBps: Number(moveBps.toFixed(2)),
          remainingSigmaBps: Number(model.remainingSigmaBps.toFixed(2)),
          modelProbability: Number(model.probability.toFixed(4)),
          edge: edge === null ? null : Number(edge.toFixed(4)),
          kellyFraction: Number(kellyFraction(model.probability, buyPrice, thresholds.maxKellyFraction).toFixed(4)),
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
    return rank[a.decision] - rank[b.decision] || a.minutesToEnd - b.minutesToEnd || (b.edge ?? -1) - (a.edge ?? -1);
  });

  return {
    scannedAt: new Date(nowMs).toISOString(),
    note: 'Uses Coinbase spot candles as a proxy and compares model probability to Polymarket entry price. Polymarket resolves against Chainlink streams; require edge plus manual source sanity before live action.',
    thresholds,
    rows
  };
}
