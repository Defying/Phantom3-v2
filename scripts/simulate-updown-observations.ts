#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';
import type { UpDownScanRow } from '../packages/market-data/src/updown-edge.js';

const COINBASE_API_BASE = 'https://api.exchange.coinbase.com';
const inputPath = process.env.WRAITH_UPDOWN_OBSERVATIONS ?? 'data/updown-observations.jsonl';
const minTrades = Number(process.env.WRAITH_UPDOWN_SIM_MIN_TRADES ?? '20');
const maxRows = Number(process.env.WRAITH_UPDOWN_SIM_MAX_ROWS ?? '10');
const dedupeMode = process.env.WRAITH_UPDOWN_SIM_DEDUPE ?? 'market-side';

type Observation = {
  kind: 'wraith-updown-observation';
  observedAt: string;
  row: UpDownScanRow;
};

type ParsedSlug = {
  asset: 'BTC' | 'ETH' | 'SOL';
  product: 'BTC-USD' | 'ETH-USD' | 'SOL-USD';
  windowSeconds: 300 | 900;
  startSeconds: number;
};

type CoinbaseCandle = [number, number, number, number, number, number];

type SimulationGate = {
  name: string;
  minMinutesToEnd: number;
  maxMinutesToEnd: number;
  minLiquidity: number;
  maxSpread: number;
  minBufferBps: number;
  maxEntryPrice: number;
  minModelProbability: number;
  minEdge: number;
};

type ScoredTrade = {
  observedAt: string;
  slug: string;
  asset: UpDownScanRow['asset'];
  window: UpDownScanRow['window'];
  side: UpDownScanRow['side'];
  buyPrice: number;
  modelProbability: number;
  edge: number;
  moveBps: number;
  minutesToEnd: number;
  outcome: UpDownScanRow['side'];
  won: boolean;
  unitPnl: number;
};

type SimulationResult = {
  gate: SimulationGate;
  considered: number;
  trades: number;
  wins: number;
  losses: number;
  hitRate: number | null;
  unitPnl: number;
  averageUnitPnl: number | null;
  impliedRoi: number | null;
  maxDrawdownUnits: number;
  examples: ScoredTrade[];
};

function parseNumberList(value: string | undefined, fallback: number[]): number[] {
  if (!value?.trim()) return fallback;
  return value
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry));
}

function parseSlug(slug: string): ParsedSlug | null {
  const match = /^(btc|eth|sol)-updown-(5m|15m)-(\d+)$/.exec(slug);
  if (!match) return null;
  const asset = match[1] === 'btc' ? 'BTC' : match[1] === 'eth' ? 'ETH' : 'SOL';
  return {
    asset,
    product: asset === 'BTC' ? 'BTC-USD' : asset === 'ETH' ? 'ETH-USD' : 'SOL-USD',
    windowSeconds: match[2] === '5m' ? 300 : 900,
    startSeconds: Number(match[3])
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Wraith-updown-simulator/0.1', accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json() as Promise<T>;
}

const candleCache = new Map<string, Promise<CoinbaseCandle | null>>();

async function closingCandle(parsed: ParsedSlug): Promise<CoinbaseCandle | null> {
  const key = `${parsed.product}:${parsed.windowSeconds}:${parsed.startSeconds}`;
  const cached = candleCache.get(key);
  if (cached) return cached;

  const request = (async () => {
    const start = new Date(parsed.startSeconds * 1000).toISOString();
    const end = new Date((parsed.startSeconds + parsed.windowSeconds) * 1000).toISOString();
    const url = `${COINBASE_API_BASE}/products/${parsed.product}/candles?${new URLSearchParams({
      granularity: String(parsed.windowSeconds),
      start,
      end
    })}`;
    const rows = await getJson<unknown[]>(url);
    return rows.find((row): row is CoinbaseCandle => Array.isArray(row) && row.length >= 5 && row[0] === parsed.startSeconds) ?? null;
  })();

  candleCache.set(key, request);
  return request;
}

function loadGates(): SimulationGate[] {
  const minBufferBps = parseNumberList(process.env.WRAITH_UPDOWN_SIM_MIN_BUFFER_BPS, [0, 5, 8, 12, 18]);
  const minModelProbability = parseNumberList(process.env.WRAITH_UPDOWN_SIM_MIN_MODEL_PROBABILITY, [0.5, 0.55, 0.57, 0.6, 0.65]);
  const minEdge = parseNumberList(process.env.WRAITH_UPDOWN_SIM_MIN_EDGE, [0, 0.01, 0.02, 0.03, 0.05]);
  const gates: SimulationGate[] = [];

  for (const buffer of minBufferBps) {
    for (const probability of minModelProbability) {
      for (const edge of minEdge) {
        gates.push({
          name: `buffer>=${buffer}bps prob>=${probability} edge>=${edge}`,
          minMinutesToEnd: Number(process.env.WRAITH_UPDOWN_SIM_MIN_MINUTES_TO_END ?? '0.75'),
          maxMinutesToEnd: Number(process.env.WRAITH_UPDOWN_SIM_MAX_MINUTES_TO_END ?? '20'),
          minLiquidity: Number(process.env.WRAITH_UPDOWN_SIM_MIN_LIQUIDITY ?? '10000'),
          maxSpread: Number(process.env.WRAITH_UPDOWN_SIM_MAX_SPREAD ?? '0.02'),
          minBufferBps: buffer,
          maxEntryPrice: Number(process.env.WRAITH_UPDOWN_SIM_MAX_ENTRY_PRICE ?? '0.93'),
          minModelProbability: probability,
          minEdge: edge
        });
      }
    }
  }

  return gates;
}

function qualifies(row: UpDownScanRow, gate: SimulationGate): boolean {
  const buyPrice = row.buyPrice ?? row.sidePrice;
  if (buyPrice === null || row.edge === null) return false;
  if (row.minutesToEnd < gate.minMinutesToEnd || row.minutesToEnd > gate.maxMinutesToEnd) return false;
  if (row.spread === null || row.spread > gate.maxSpread) return false;
  if (row.liquidity === null || row.liquidity < gate.minLiquidity) return false;
  if (Math.abs(row.moveBps) < gate.minBufferBps) return false;
  if (buyPrice > gate.maxEntryPrice) return false;
  if (row.modelProbability < gate.minModelProbability) return false;
  if (row.edge < gate.minEdge) return false;
  return true;
}

function tradeKey(observation: Observation): string {
  if (dedupeMode === 'observation') {
    return `${observation.row.slug}|${observation.row.side}|${observation.observedAt}`;
  }
  return `${observation.row.slug}|${observation.row.side}`;
}

function drawdown(values: number[]): number {
  let peak = 0;
  let equity = 0;
  let worst = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return Number(Math.abs(worst).toFixed(4));
}

function scoreTrades(gate: SimulationGate, trades: ScoredTrade[], considered: number): SimulationResult {
  const wins = trades.filter((trade) => trade.won).length;
  const unitPnl = trades.reduce((sum, trade) => sum + trade.unitPnl, 0);
  const totalSpent = trades.reduce((sum, trade) => sum + trade.buyPrice, 0);
  return {
    gate,
    considered,
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    hitRate: trades.length ? Number((wins / trades.length).toFixed(4)) : null,
    unitPnl: Number(unitPnl.toFixed(4)),
    averageUnitPnl: trades.length ? Number((unitPnl / trades.length).toFixed(4)) : null,
    impliedRoi: totalSpent > 0 ? Number((unitPnl / totalSpent).toFixed(4)) : null,
    maxDrawdownUnits: drawdown(trades.map((trade) => trade.unitPnl)),
    examples: trades.slice(0, maxRows)
  };
}

async function scoreObservation(observation: Observation): Promise<ScoredTrade | null> {
  const parsed = parseSlug(observation.row.slug);
  if (!parsed) return null;
  if (Date.now() / 1000 < parsed.startSeconds + parsed.windowSeconds + 60) return null;

  const candle = await closingCandle(parsed);
  if (!candle) return null;

  const buyPrice = observation.row.buyPrice ?? observation.row.sidePrice;
  if (buyPrice === null || observation.row.edge === null) return null;

  const close = candle[4];
  const outcome = close >= observation.row.coinbaseOpen ? 'Up' : 'Down';
  const won = observation.row.side === outcome;
  const unitPnl = won ? 1 - buyPrice : -buyPrice;

  return {
    observedAt: observation.observedAt,
    slug: observation.row.slug,
    asset: observation.row.asset,
    window: observation.row.window,
    side: observation.row.side,
    buyPrice,
    modelProbability: observation.row.modelProbability,
    edge: observation.row.edge,
    moveBps: observation.row.moveBps,
    minutesToEnd: observation.row.minutesToEnd,
    outcome,
    won,
    unitPnl: Number(unitPnl.toFixed(4))
  };
}

let text = '';
try {
  text = await readFile(inputPath, 'utf8');
} catch {
  console.log(JSON.stringify({ inputPath, evaluated: 0, message: 'No observations yet. Run npm run observe:updown first.' }, null, 2));
  process.exit(0);
}

const observations = text
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Observation)
  .filter((entry) => entry.kind === 'wraith-updown-observation');

const scoredByObservation = new Map<Observation, ScoredTrade>();
for (const observation of observations) {
  const scored = await scoreObservation(observation);
  if (scored) scoredByObservation.set(observation, scored);
}

const gates = loadGates();
const results: SimulationResult[] = [];

for (const gate of gates) {
  const seen = new Set<string>();
  const trades: ScoredTrade[] = [];
  let considered = 0;
  for (const observation of observations) {
    const scored = scoredByObservation.get(observation);
    if (!scored) continue;
    considered += 1;
    if (!qualifies(observation.row, gate)) continue;
    const key = tradeKey(observation);
    if (seen.has(key)) continue;
    seen.add(key);
    trades.push(scored);
  }
  results.push(scoreTrades(gate, trades, considered));
}

const ranked = results
  .filter((result) => result.trades >= minTrades)
  .sort((a, b) => b.averageUnitPnl! - a.averageUnitPnl! || b.unitPnl - a.unitPnl || b.trades - a.trades);

console.log(JSON.stringify({
  inputPath,
  observations: observations.length,
  resolvedObservations: scoredByObservation.size,
  dedupeMode,
  minTrades,
  generatedGates: gates.length,
  best: ranked.slice(0, maxRows),
  allResultsWithTrades: results.filter((result) => result.trades > 0).length
}, null, 2));
