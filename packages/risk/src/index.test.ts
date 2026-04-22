import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluatePaperTradeRisk,
  type PositionSnapshot,
  type RiskMarketSnapshot,
  type TradeIntent
} from './index.js';

const FIXED_NOW = '2026-04-21T16:00:00.000Z';

function makeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    intentId: 'intent-1',
    marketId: 'market-1',
    tokenId: 'token-yes',
    side: 'yes',
    desiredSizeUsd: 20,
    maxEntryPrice: 0.6,
    reduceOnly: false,
    createdAt: FIXED_NOW,
    ...overrides
  };
}

function makeMarket(overrides: Partial<RiskMarketSnapshot> = {}): RiskMarketSnapshot {
  return {
    marketId: 'market-1',
    tokenId: 'token-yes',
    bestBid: 0.49,
    bestAsk: 0.5,
    midpoint: 0.495,
    liquidityUsd: 5000,
    volume24hrUsd: 12000,
    sourceTimestamp: FIXED_NOW,
    observedAt: FIXED_NOW,
    sourceFreshnessMs: 0,
    ...overrides
  };
}

function makePosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    marketId: 'market-1',
    side: 'yes',
    exposureUsd: 20,
    quantity: 40,
    markPrice: 0.5,
    openedAt: FIXED_NOW,
    ...overrides
  };
}

test('entry approvals require an executable ask even when a midpoint is present', () => {
  const decision = evaluatePaperTradeRisk({
    intent: makeIntent(),
    market: makeMarket({ bestBid: null, bestAsk: null, midpoint: 0.41 }),
    positions: [],
    config: {
      minLiquidityUsd: 0,
      minVolume24hrUsd: 0,
      maxSpreadBps: 10_000
    },
    now: FIXED_NOW
  });

  assert.equal(decision.decision, 'reject');
  assert(decision.reasons.some((reason) => reason.code === 'missing_executable_entry_quote'));
  assert(decision.reasons.some((reason) => reason.code === 'missing_spread_quote'));
});

test('reduce-only approvals require an executable bid even when midpoint context exists', () => {
  const decision = evaluatePaperTradeRisk({
    intent: makeIntent({ intentId: 'intent-exit', reduceOnly: true, maxEntryPrice: null }),
    market: makeMarket({ bestBid: null, bestAsk: null, midpoint: 0.58 }),
    positions: [makePosition()],
    config: {
      minLiquidityUsd: 0,
      minVolume24hrUsd: 0,
      maxSpreadBps: 10_000
    },
    now: FIXED_NOW
  });

  assert.equal(decision.decision, 'reject');
  assert(decision.reasons.some((reason) => reason.code === 'missing_executable_exit_quote'));
  assert.equal(decision.reasons.some((reason) => reason.code === 'no_position_to_reduce'), false);
});

test('spread checks derive from the executable book rather than the midpoint reference feed', () => {
  const decision = evaluatePaperTradeRisk({
    intent: makeIntent(),
    market: makeMarket({
      bestBid: 0.49,
      bestAsk: 0.51,
      midpoint: 0.1
    }),
    positions: [],
    config: {
      minLiquidityUsd: 0,
      minVolume24hrUsd: 0,
      maxSpreadBps: 450
    },
    now: FIXED_NOW
  });

  assert.equal(decision.decision, 'approve');
  assert.equal(decision.metrics.spreadBps, 400);
});
