#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';
import type { UpDownScanRow } from '../packages/market-data/src/updown-edge.js';

const COINBASE_API_BASE = 'https://api.exchange.coinbase.com';
const inputPath = process.env.WRAITH_UPDOWN_OBSERVATIONS ?? 'data/updown-observations.jsonl';
const decisionFilter = new Set((process.env.WRAITH_UPDOWN_EVAL_DECISIONS ?? 'CANDIDATE').split(',').map((entry) => entry.trim()).filter(Boolean));

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
    headers: { 'user-agent': 'Wraith-updown-evaluator/0.1', accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json() as Promise<T>;
}

async function closingCandle(parsed: ParsedSlug): Promise<CoinbaseCandle | null> {
  const start = new Date(parsed.startSeconds * 1000).toISOString();
  const end = new Date((parsed.startSeconds + parsed.windowSeconds) * 1000).toISOString();
  const url = `${COINBASE_API_BASE}/products/${parsed.product}/candles?${new URLSearchParams({
    granularity: String(parsed.windowSeconds),
    start,
    end
  })}`;
  const rows = await getJson<unknown[]>(url);
  const candle = rows.find((row): row is CoinbaseCandle => Array.isArray(row) && row.length >= 5 && row[0] === parsed.startSeconds);
  return candle ?? null;
}

function profit(row: UpDownScanRow, won: boolean): number | null {
  const price = row.buyPrice ?? row.sidePrice;
  if (price === null) return null;
  return won ? 1 - price : -price;
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
  .filter((entry) => entry.kind === 'wraith-updown-observation')
  .filter((entry) => decisionFilter.has(entry.row.decision));

const seen = new Set<string>();
const unique = observations.filter((entry) => {
  const key = `${entry.row.slug}|${entry.row.side}|${entry.observedAt}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

let evaluated = 0;
let wins = 0;
let pnl = 0;
const rows = [];
const nowSeconds = Date.now() / 1000;

for (const observation of unique) {
  const parsed = parseSlug(observation.row.slug);
  if (!parsed) continue;
  if (nowSeconds < parsed.startSeconds + parsed.windowSeconds + 60) continue;
  const candle = await closingCandle(parsed);
  if (!candle) continue;
  const open = observation.row.coinbaseOpen;
  const close = candle[4];
  const outcome = close >= open ? 'Up' : 'Down';
  const won = observation.row.side === outcome;
  const rowPnl = profit(observation.row, won);
  if (rowPnl === null) continue;
  evaluated += 1;
  wins += won ? 1 : 0;
  pnl += rowPnl;
  rows.push({
    observedAt: observation.observedAt,
    slug: observation.row.slug,
    side: observation.row.side,
    decision: observation.row.decision,
    buyPrice: observation.row.buyPrice ?? observation.row.sidePrice,
    modelProbability: observation.row.modelProbability,
    edge: observation.row.edge,
    outcome,
    won,
    pnl: Number(rowPnl.toFixed(4))
  });
}

console.log(JSON.stringify({
  inputPath,
  decisions: [...decisionFilter],
  evaluated,
  wins,
  losses: evaluated - wins,
  hitRate: evaluated ? Number((wins / evaluated).toFixed(4)) : null,
  unitPnl: Number(pnl.toFixed(4)),
  averageUnitPnl: evaluated ? Number((pnl / evaluated).toFixed(4)) : null,
  rows
}, null, 2));
