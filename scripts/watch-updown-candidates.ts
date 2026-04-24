#!/usr/bin/env tsx

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scanUpDownEdge, type UpDownScanRow } from '../packages/market-data/src/updown-edge.js';

const statePath = process.env.WRAITH_UPDOWN_ALERT_STATE ?? 'runtime/updown-candidate-alerts.json';
const emitSkips = process.env.WRAITH_UPDOWN_EMIT_SKIPS === '1';

type AlertState = {
  seen: Record<string, string>;
};

async function readState(): Promise<AlertState> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as AlertState;
  } catch {
    return { seen: {} };
  }
}

async function writeState(state: AlertState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function signalKey(row: UpDownScanRow): string {
  return `${row.slug}|${row.side}|${row.buyPrice ?? row.sidePrice ?? 'na'}`;
}

function summarize(row: UpDownScanRow): string {
  const price = row.buyPrice ?? row.sidePrice;
  const priceText = price === null ? 'n/a' : `${(price * 100).toFixed(1)}¢`;
  const probabilityText = `${(row.modelProbability * 100).toFixed(1)}%`;
  const edgeText = row.edge === null ? 'n/a' : `${(row.edge * 100).toFixed(1)} pts`;
  const kellyText = `${(row.kellyFraction * 100).toFixed(2)}%`;
  return `${row.asset} ${row.window} ${row.side}: buy ${priceText}, model ${probabilityText}, edge ${edgeText}, kelly cap ${kellyText}, ${row.minutesToEnd.toFixed(1)}m left — ${row.url}`;
}

const scan = await scanUpDownEdge();
const candidates = scan.rows.filter((row) => row.decision === 'CANDIDATE');
const state = await readState();
const fresh = candidates.filter((row) => !state.seen[signalKey(row)]);

for (const row of candidates) {
  state.seen[signalKey(row)] = scan.scannedAt;
}
await writeState(state);

if (fresh.length > 0) {
  console.log(JSON.stringify({
    kind: 'wraith-updown-candidates',
    scannedAt: scan.scannedAt,
    count: fresh.length,
    alerts: fresh.map(summarize),
    rows: fresh
  }, null, 2));
} else if (emitSkips) {
  console.log(JSON.stringify({
    kind: 'wraith-updown-no-candidates',
    scannedAt: scan.scannedAt,
    count: 0,
    rows: scan.rows.slice(0, 6)
  }, null, 2));
}
