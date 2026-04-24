#!/usr/bin/env tsx

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scanUpDownEdge } from '../packages/market-data/src/updown-edge.js';

const outputPath = process.env.WRAITH_UPDOWN_OBSERVATIONS ?? 'data/updown-observations.jsonl';
const scan = await scanUpDownEdge();
const lines = scan.rows.map((row) => JSON.stringify({
  kind: 'wraith-updown-observation',
  observedAt: scan.scannedAt,
  thresholds: scan.thresholds,
  row
}));

await mkdir(dirname(outputPath), { recursive: true });
if (lines.length > 0) {
  await appendFile(outputPath, `${lines.join('\n')}\n`);
}

console.log(JSON.stringify({
  observedAt: scan.scannedAt,
  outputPath,
  rows: scan.rows.length,
  candidates: scan.rows.filter((row) => row.decision === 'CANDIDATE').length,
  watch: scan.rows.filter((row) => row.decision === 'WATCH').length
}, null, 2));
