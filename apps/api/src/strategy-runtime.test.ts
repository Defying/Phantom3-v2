import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE,
  type RuntimeMarket
} from '../../../packages/contracts/src/index.js';
import type { ProjectedPosition } from '../../../packages/ledger/src/index.js';
import {
  createPaperPositionSummary,
  createPaperQuote,
  createRiskMarketSnapshot
} from './strategy-runtime.js';

const FIXED_NOW = '2026-04-21T16:00:00.000Z';

function makeMarket(overrides: Partial<RuntimeMarket> = {}): RuntimeMarket {
  return {
    id: 'market-1',
    eventId: 'event-1',
    slug: 'market-1',
    eventTitle: 'Question',
    question: 'Will BTC close higher?',
    yesLabel: 'Yes',
    noLabel: 'No',
    yesTokenId: 'token-yes',
    noTokenId: 'token-no',
    yesPrice: 0.61,
    noPrice: 0.39,
    priceSource: RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE,
    spread: 0.04,
    volume24hr: 1500,
    liquidity: 8000,
    endDate: '2026-04-21T20:00:00.000Z',
    url: 'https://example.com/markets/1',
    ...overrides
  };
}

function makePosition(overrides: Partial<ProjectedPosition> = {}): ProjectedPosition {
  return {
    positionId: 'position-1',
    marketId: 'market-1',
    tokenId: 'token-yes',
    openedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    status: 'open',
    netQuantity: 5,
    averageEntryPrice: 0.5,
    realizedPnl: 0,
    lots: [],
    ...overrides
  };
}

test('risk market snapshots keep midpoint reference-only and never synthesize executable quotes', () => {
  const snapshot = createRiskMarketSnapshot(makeMarket(), 'yes', FIXED_NOW);

  assert.equal(snapshot.midpoint, 0.61);
  assert.equal(snapshot.bestBid, null);
  assert.equal(snapshot.bestAsk, null);
});

test('paper quotes carry midpoint context without inventing a best bid or ask', () => {
  const quote = createPaperQuote(makeMarket(), 'yes', FIXED_NOW);

  assert(quote);
  assert.equal(quote.midpoint, 0.61);
  assert.equal(quote.bestBid, null);
  assert.equal(quote.bestAsk, null);
  assert.equal(quote.source, RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE);
  assert.deepEqual(quote.metadata, {
    referenceOnly: true,
    executableBook: false,
    priceSource: RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE
  });
});

test('position summaries label midpoint-derived mark prices with their source', () => {
  const summary = createPaperPositionSummary(makePosition(), makeMarket());

  assert(summary);
  assert.equal(summary.markPrice, 0.61);
  assert.equal(summary.markPriceSource, RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE);
});
