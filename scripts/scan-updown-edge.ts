#!/usr/bin/env tsx

import { scanUpDownEdge } from '../packages/market-data/src/updown-edge.js';

const result = await scanUpDownEdge({
  minMinutesToEnd: Number(process.env.MIN_MINUTES_TO_END ?? '0.75'),
  maxMinutesToEnd: Number(process.env.MAX_MINUTES_TO_END ?? '20'),
  minLiquidity: Number(process.env.MIN_LIQUIDITY ?? '10000'),
  maxSpread: Number(process.env.MAX_SPREAD ?? '0.02'),
  minBufferBps: Number(process.env.MIN_BUFFER_BPS ?? '8'),
  strongBufferBps: Number(process.env.STRONG_BUFFER_BPS ?? '18'),
  maxEntryPrice: Number(process.env.MAX_ENTRY_PRICE ?? '0.93'),
  minModelProbability: Number(process.env.MIN_MODEL_PROBABILITY ?? '0.57'),
  minEdge: Number(process.env.MIN_EDGE ?? '0.03'),
  maxKellyFraction: Number(process.env.MAX_KELLY_FRACTION ?? '0.02')
});

console.log(JSON.stringify(result, null, 2));
