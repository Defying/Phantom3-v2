import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JsonlLedger, getOpenOrders, positionKeyFor } from '../../ledger/src/index.js';
import { PaperExecutionAdapter, type ApprovedTradeIntent, type PaperQuote } from './index.js';

const FIXED_NOW = '2026-04-21T16:00:00.000Z';
const MARKET_ID = 'market-1';
const TOKEN_ID = 'token-yes';
const SESSION_ID = 'live-safety-tests';
const STRATEGY_ID = 'live-thin-slice';
const cleanupDirs: string[] = [];

after(async () => {
  await Promise.all(cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock(): Date {
  return new Date(FIXED_NOW);
}

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'phantom3-live-safety-'));
  cleanupDirs.push(directory);

  const ledger = new JsonlLedger({ directory, clock });
  await ledger.init();

  return {
    directory,
    ledger,
    adapter: new PaperExecutionAdapter(ledger, { clock }),
    positionKey: positionKeyFor(MARKET_ID, TOKEN_ID)
  };
}

function makeIntent(overrides: Partial<ApprovedTradeIntent> & Pick<ApprovedTradeIntent, 'intentId' | 'side' | 'limitPrice' | 'quantity'>): ApprovedTradeIntent {
  return {
    sessionId: SESSION_ID,
    strategyId: STRATEGY_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    approvedAt: FIXED_NOW,
    thesis: 'Regression safety check',
    confidence: 0.5,
    ...overrides
  };
}

function makeQuote(overrides: Partial<PaperQuote> = {}): PaperQuote {
  return {
    quoteId: 'quote-default',
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    observedAt: FIXED_NOW,
    bestBid: 0.39,
    bestAsk: 0.4,
    midpoint: 0.395,
    source: 'test-quote',
    ...overrides
  };
}

test('midpoint-only quotes never create a fill or position', async () => {
  const { adapter, ledger, positionKey } = await createHarness();

  const result = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-midpoint-only', side: 'buy', limitPrice: 0.8, quantity: 10 }),
    quote: makeQuote({ quoteId: 'quote-midpoint-only', bestBid: null, bestAsk: null, midpoint: 0.41 })
  });

  assert.equal(result.status, 'open');
  assert.equal(result.fillEvent, undefined);

  let projection = await ledger.readProjection();
  assert.equal(projection.fills.length, 0);
  assert.equal(getOpenOrders(projection).length, 1);
  assert.equal(projection.positions.get(positionKey), undefined);

  const reconcile = await adapter.reconcileQuote(
    makeQuote({ quoteId: 'quote-midpoint-reconcile', bestBid: null, bestAsk: null, midpoint: 0.42 })
  );

  assert.deepEqual(reconcile.filledOrderIds, []);

  projection = await ledger.readProjection();
  assert.equal(projection.fills.length, 0);
  assert.equal(getOpenOrders(projection).length, 1);
  assert.equal(projection.positions.get(positionKey), undefined);
});

test('unmatched exits stay open until a real bid fills them, and realized P&L uses that fill price only', async () => {
  const { adapter, ledger, positionKey } = await createHarness();

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-entry', side: 'buy', limitPrice: 0.8, quantity: 10 }),
    quote: makeQuote({ quoteId: 'quote-entry', bestBid: 0.39, bestAsk: 0.4, midpoint: 0.395 })
  });

  let projection = await ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 10);
  assert.equal(projection.positions.get(positionKey)?.averageEntryPrice, 0.4);

  const exit = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'sell-working-exit', side: 'sell', limitPrice: 0.54, quantity: 10 })
  });

  assert.equal(exit.status, 'open');

  projection = await ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 10);
  assert.equal(getOpenOrders(projection).map((order) => order.orderId).includes(exit.orderId), true);

  const midpointOnly = await adapter.reconcileQuote(
    makeQuote({ quoteId: 'quote-exit-midpoint-only', bestBid: null, bestAsk: null, midpoint: 0.56 })
  );
  assert.deepEqual(midpointOnly.filledOrderIds, []);

  projection = await ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 10);
  assert.equal(projection.orders.get(exit.orderId)?.status, 'open');

  const filled = await adapter.reconcileQuote(
    makeQuote({ quoteId: 'quote-exit-fill', bestBid: 0.55, bestAsk: 0.57, midpoint: 0.56, bidSize: 10 })
  );
  assert.deepEqual(filled.filledOrderIds, [exit.orderId]);

  projection = await ledger.readProjection();
  const closedPosition = projection.positions.get(positionKey);
  const exitFill = projection.fills.at(-1);

  assert.ok(closedPosition);
  assert.equal(closedPosition.netQuantity, 0);
  assert.ok(Math.abs(closedPosition.realizedPnl - 1.5) < 1e-9);
  assert.equal(projection.orders.get(exit.orderId)?.status, 'filled');
  assert.equal(exitFill?.price, 0.55);
  assert.notEqual(exitFill?.price, 0.54);
  assert.notEqual(exitFill?.price, 0.56);
});

test('working sell orders reserve inventory and partial fills keep the remaining position open', async () => {
  const { adapter, ledger, positionKey } = await createHarness();

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-base', side: 'buy', limitPrice: 0.8, quantity: 10 }),
    quote: makeQuote({ quoteId: 'quote-buy-base', bestBid: 0.39, bestAsk: 0.4, midpoint: 0.395 })
  });

  const firstExit = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'sell-first', side: 'sell', limitPrice: 0.5, quantity: 6 })
  });
  assert.equal(firstExit.status, 'open');

  const secondExit = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'sell-second', side: 'sell', limitPrice: 0.5, quantity: 5 })
  });

  assert.equal(secondExit.status, 'rejected');
  assert.match(secondExit.orderEvent.rejectionReason ?? '', /Available after open-order reservations: 4/);

  let projection = await ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 10);
  assert.deepEqual(getOpenOrders(projection).map((order) => order.orderId), [firstExit.orderId]);

  const partialFill = await adapter.reconcileQuote(
    makeQuote({ quoteId: 'quote-partial-exit', bestBid: 0.51, bestAsk: 0.52, midpoint: 0.515, bidSize: 3 })
  );
  assert.deepEqual(partialFill.filledOrderIds, [firstExit.orderId]);

  projection = await ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 7);
  assert.equal(projection.orders.get(firstExit.orderId)?.status, 'partially-filled');
  assert.equal(projection.orders.get(firstExit.orderId)?.remainingQuantity, 3);
  assert.equal(projection.orders.get(secondExit.orderId)?.status, 'rejected');
});

test('restart replay rebuilds open positions and working exits before reconciliation resumes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phantom3-live-safety-restart-'));
  cleanupDirs.push(directory);

  const ledgerBeforeRestart = new JsonlLedger({ directory, clock });
  await ledgerBeforeRestart.init();
  const adapterBeforeRestart = new PaperExecutionAdapter(ledgerBeforeRestart, { clock });

  await adapterBeforeRestart.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-before-restart', side: 'buy', limitPrice: 0.7, quantity: 4 }),
    quote: makeQuote({ quoteId: 'quote-before-restart', bestBid: 0.24, bestAsk: 0.25, midpoint: 0.245 })
  });

  const workingExit = await adapterBeforeRestart.submitApprovedIntent({
    intent: makeIntent({ intentId: 'sell-before-restart', side: 'sell', limitPrice: 0.29, quantity: 2 })
  });
  assert.equal(workingExit.status, 'open');

  const ledgerAfterRestart = new JsonlLedger({ directory, clock });
  await ledgerAfterRestart.init();
  const projectionAfterRestart = await ledgerAfterRestart.readProjection();
  const positionKey = positionKeyFor(MARKET_ID, TOKEN_ID);

  assert.equal(projectionAfterRestart.positions.get(positionKey)?.netQuantity, 4);
  assert.deepEqual(getOpenOrders(projectionAfterRestart).map((order) => order.orderId), [workingExit.orderId]);

  const adapterAfterRestart = new PaperExecutionAdapter(ledgerAfterRestart, { clock });
  await adapterAfterRestart.reconcileQuote(
    makeQuote({ quoteId: 'quote-after-restart', bestBid: 0.3, bestAsk: 0.31, midpoint: 0.305, bidSize: 2 })
  );

  const finalProjection = await ledgerAfterRestart.readProjection();
  assert.equal(finalProjection.positions.get(positionKey)?.netQuantity, 2);
  assert.equal(finalProjection.orders.get(workingExit.orderId)?.status, 'filled');
});
