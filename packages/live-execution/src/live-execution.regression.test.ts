import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JsonlLedger, positionKeyFor } from '../../ledger/src/index.js';
import {
  LiveExecutionAdapter,
  type ApprovedTradeIntent,
  type LiveSubmitOrderRequest,
  type LiveSubmitResult,
  type LiveVenueFill,
  type LiveVenueOrderSnapshot,
  type PaperQuote
} from './index.js';

const FIXED_NOW = '2026-04-21T16:00:00.000Z';
const STALE_SNAPSHOT_AT = '2026-04-21T15:59:30.000Z';
const MARKET_ID = 'market-1';
const TOKEN_ID = 'token-yes';
const SESSION_ID = 'live-regression-tests';
const STRATEGY_ID = 'live-thin-slice';
const POSITION_KEY = positionKeyFor(MARKET_ID, TOKEN_ID);
const cleanupDirs: string[] = [];

after(async () => {
  await Promise.all(cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock(): Date {
  return new Date(FIXED_NOW);
}

async function createHarness(
  submitOrder: (request: LiveSubmitOrderRequest, context: { ledger: JsonlLedger }) => Promise<LiveSubmitResult>
) {
  const directory = await mkdtemp(join(tmpdir(), 'wraith-live-execution-'));
  cleanupDirs.push(directory);

  const ledger = new JsonlLedger({ directory, clock });
  await ledger.init();

  const adapter = new LiveExecutionAdapter(
    ledger,
    {
      submitOrder: (request) => submitOrder(request, { ledger })
    },
    {
      enabled: true,
      clock
    }
  );

  return {
    directory,
    ledger,
    adapter
  };
}

function makeIntent(
  overrides: Partial<ApprovedTradeIntent> & Pick<ApprovedTradeIntent, 'intentId' | 'side' | 'limitPrice' | 'quantity'>
): ApprovedTradeIntent {
  return {
    sessionId: SESSION_ID,
    strategyId: STRATEGY_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    approvedAt: FIXED_NOW,
    thesis: 'Live regression coverage',
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

function makeVenueOrder(
  request: LiveSubmitOrderRequest,
  overrides: Partial<LiveVenueOrderSnapshot> = {}
): LiveVenueOrderSnapshot {
  return {
    observedAt: FIXED_NOW,
    venueOrderId: 'venue-default',
    clientOrderId: request.clientOrderId,
    marketId: request.intent.marketId,
    tokenId: request.intent.tokenId,
    side: request.intent.side,
    limitPrice: request.intent.limitPrice,
    requestedQuantity: request.intent.quantity,
    filledQuantity: 0,
    remainingQuantity: request.intent.quantity,
    status: 'open',
    acknowledgedAt: FIXED_NOW,
    ...overrides
  };
}

function makeVenueFill(
  request: LiveSubmitOrderRequest,
  overrides: Partial<LiveVenueFill> & Pick<LiveVenueFill, 'venueFillId' | 'price' | 'quantity'>
): LiveVenueFill {
  return {
    venueFillId: overrides.venueFillId,
    venueOrderId: overrides.venueOrderId ?? 'venue-default',
    clientOrderId: overrides.clientOrderId ?? request.clientOrderId,
    marketId: request.intent.marketId,
    tokenId: request.intent.tokenId,
    side: request.intent.side,
    price: overrides.price,
    quantity: overrides.quantity,
    fee: overrides.fee ?? 0,
    liquidityRole: overrides.liquidityRole ?? 'taker',
    occurredAt: overrides.occurredAt ?? FIXED_NOW,
    raw: overrides.raw
  };
}

test('clientOrderId is durably recorded before the live gateway sees the submit, and acks alone never create a fill', async () => {
  const { adapter, ledger } = await createHarness(async (request, { ledger: liveLedger }) => {
    const projection = await liveLedger.readProjection();
    const pendingOrder = projection.orders.get(request.clientOrderId);

    assert.ok(projection.intents.has(request.intent.intentId));
    assert.ok(pendingOrder);
    assert.equal(pendingOrder.status, 'pending-submit');
    assert.equal(pendingOrder.remainingQuantity, request.intent.quantity);
    assert.equal(projection.fills.length, 0);
    assert.equal(projection.positions.get(POSITION_KEY), undefined);

    return {
      transportStatus: 'acknowledged',
      order: makeVenueOrder(request, {
        venueOrderId: 'venue-entry-open',
        status: 'open'
      })
    };
  });

  const result = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-open-authenticated', side: 'buy', limitPrice: 0.42, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-authenticated-open', bestAsk: 0.41, midpoint: 0.405 })
  });

  assert.equal(result.orderId, result.orderEvent.orderId);
  assert.equal(result.venueOrderId, 'venue-entry-open');
  assert.equal(result.status, 'open');
  assert.equal(result.fillEvents.length, 0);

  const projection = await ledger.readProjection();
  assert.equal(projection.orders.get(result.orderId)?.status, 'open');
  assert.equal(projection.orders.get(result.orderId)?.venueOrderId, 'venue-entry-open');
  assert.equal(projection.fills.length, 0);
  assert.equal(projection.positions.get(POSITION_KEY), undefined);
});

test('sell exits without venue fills stay in reconcile and never realize pnl or flatten the position', async () => {
  let submitCount = 0;
  const { adapter, ledger } = await createHarness(async (request) => {
    submitCount += 1;

    if (submitCount === 1) {
      return {
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, {
          venueOrderId: 'venue-entry-filled',
          status: 'filled',
          filledQuantity: 5,
          remainingQuantity: 0
        }),
        fills: [
          makeVenueFill(request, {
            venueFillId: 'venue-fill-entry-1',
            venueOrderId: 'venue-entry-filled',
            price: 0.4,
            quantity: 5
          })
        ]
      };
    }

    return {
      transportStatus: 'acknowledged',
      order: makeVenueOrder(request, {
        venueOrderId: 'venue-exit-missing-fill',
        side: 'sell',
        limitPrice: 0.55,
        status: 'filled',
        filledQuantity: 5,
        remainingQuantity: 0
      })
    };
  });

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-live-entry', side: 'buy', limitPrice: 0.42, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-entry-live', bestAsk: 0.4, midpoint: 0.395 })
  });

  let projection = await ledger.readProjection();
  assert.equal(projection.positions.get(POSITION_KEY)?.netQuantity, 5);
  assert.equal(projection.positions.get(POSITION_KEY)?.realizedPnl, 0);

  const exit = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'sell-exit-without-fill', side: 'sell', limitPrice: 0.55, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-exit-live', bestBid: 0.54, bestAsk: 0.56, midpoint: 0.55 })
  });

  assert.equal(exit.status, 'reconcile');
  assert.equal(exit.fillEvents.length, 0);
  assert.match(exit.orderEvent.statusReason ?? '', /full fill evidence/i);

  projection = await ledger.readProjection();
  assert.equal(projection.orders.get(exit.orderId)?.status, 'reconcile');
  assert.equal(projection.positions.get(POSITION_KEY)?.netQuantity, 5);
  assert.equal(projection.positions.get(POSITION_KEY)?.realizedPnl, 0);
});

test('partial fills survive repeated snapshot reconciliation without double-counting or dropping tracking', async () => {
  const { adapter, ledger } = await createHarness(async (request) => ({
    transportStatus: 'acknowledged',
    order: makeVenueOrder(request, {
      venueOrderId: 'venue-buy-working',
      status: 'open'
    })
  }));

  const submission = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-partial-then-final', side: 'buy', limitPrice: 0.42, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-partial-open', bestAsk: 0.41, midpoint: 0.405 })
  });

  const partial = await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-buy-working',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        limitPrice: 0.42,
        requestedQuantity: 5,
        filledQuantity: 2,
        remainingQuantity: 3,
        status: 'partially-filled'
      }
    ],
    fills: [
      {
        venueFillId: 'venue-fill-partial-1',
        venueOrderId: 'venue-buy-working',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        price: 0.39,
        quantity: 2,
        fee: 0,
        liquidityRole: 'taker',
        occurredAt: FIXED_NOW
      }
    ],
    positions: []
  });

  assert.deepEqual(partial.filledOrderIds, [submission.orderId]);

  let projection = await ledger.readProjection();
  assert.equal(projection.orders.get(submission.orderId)?.status, 'partially-filled');
  assert.equal(projection.orders.get(submission.orderId)?.remainingQuantity, 3);
  assert.equal(projection.positions.get(POSITION_KEY)?.netQuantity, 2);
  assert.deepEqual(projection.fills.map((fill) => fill.venueFillId), ['venue-fill-partial-1']);

  const final = await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-buy-working',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        limitPrice: 0.42,
        requestedQuantity: 5,
        filledQuantity: 5,
        remainingQuantity: 0,
        status: 'filled'
      }
    ],
    fills: [
      {
        venueFillId: 'venue-fill-partial-1',
        venueOrderId: 'venue-buy-working',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        price: 0.39,
        quantity: 2,
        fee: 0,
        liquidityRole: 'taker',
        occurredAt: FIXED_NOW
      },
      {
        venueFillId: 'venue-fill-final-2',
        venueOrderId: 'venue-buy-working',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        price: 0.38,
        quantity: 3,
        fee: 0,
        liquidityRole: 'taker',
        occurredAt: FIXED_NOW
      }
    ],
    positions: []
  });

  assert.deepEqual(final.filledOrderIds, [submission.orderId]);

  projection = await ledger.readProjection();
  assert.equal(projection.orders.get(submission.orderId)?.status, 'filled');
  assert.equal(projection.orders.get(submission.orderId)?.filledQuantity, 5);
  assert.equal(projection.positions.get(POSITION_KEY)?.netQuantity, 5);
  assert.deepEqual(
    projection.fills.map((fill) => fill.venueFillId),
    ['venue-fill-partial-1', 'venue-fill-final-2']
  );
});

test('stale venue snapshots are skipped instead of mutating tracked orders', async () => {
  const { adapter, ledger } = await createHarness(async (request) => ({
    transportStatus: 'acknowledged',
    order: makeVenueOrder(request, {
      venueOrderId: 'venue-stale-open',
      status: 'open'
    })
  }));

  const submission = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-stale-snapshot', side: 'buy', limitPrice: 0.42, quantity: 3 }),
    quote: makeQuote({ quoteId: 'quote-stale-open', bestAsk: 0.41, midpoint: 0.405 })
  });

  const stale = await adapter.reconcileVenueSnapshot({
    observedAt: STALE_SNAPSHOT_AT,
    orders: [
      {
        observedAt: STALE_SNAPSHOT_AT,
        venueOrderId: 'venue-stale-open',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        limitPrice: 0.42,
        requestedQuantity: 3,
        filledQuantity: 3,
        remainingQuantity: 0,
        status: 'filled'
      }
    ],
    fills: [],
    positions: []
  });

  assert.match(stale.skippedReason ?? '', /older than 15000ms/);
  assert.deepEqual(stale.reconciledOrderIds, []);

  const projection = await ledger.readProjection();
  assert.equal(projection.orders.get(submission.orderId)?.status, 'open');
  assert.equal(projection.fills.length, 0);
  assert.equal(projection.positions.get(POSITION_KEY), undefined);
});

test('duplicate candidate snapshots fail closed into reconcile instead of guessing which venue order is real', async () => {
  const { adapter, ledger } = await createHarness(async (request) => ({
    transportStatus: 'acknowledged',
    order: makeVenueOrder(request, {
      venueOrderId: null,
      clientOrderId: request.clientOrderId,
      status: 'open'
    })
  }));

  const submission = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-duplicate-candidate', side: 'buy', limitPrice: 0.42, quantity: 2 }),
    quote: makeQuote({ quoteId: 'quote-duplicate-open', bestAsk: 0.41, midpoint: 0.405 })
  });

  const duplicate = await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-duplicate-a',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        limitPrice: 0.42,
        requestedQuantity: 2,
        filledQuantity: 0,
        remainingQuantity: 2,
        status: 'open'
      },
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-duplicate-b',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        limitPrice: 0.42,
        requestedQuantity: 2,
        filledQuantity: 0,
        remainingQuantity: 2,
        status: 'open'
      }
    ],
    fills: [],
    positions: []
  });

  assert.deepEqual(duplicate.reconcileRequiredOrderIds, [submission.orderId]);

  const projection = await ledger.readProjection();
  assert.equal(projection.orders.get(submission.orderId)?.status, 'reconcile');
  assert.match(projection.orders.get(submission.orderId)?.statusReason ?? '', /multiple candidate orders/i);
});

test('unmatched venue orders are surfaced explicitly without mutating tracked local state', async () => {
  const { adapter, ledger } = await createHarness(async (request) => ({
    transportStatus: 'acknowledged',
    order: makeVenueOrder(request, {
      venueOrderId: 'venue-matched-open',
      status: 'open'
    })
  }));

  const submission = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-with-orphan-order', side: 'buy', limitPrice: 0.42, quantity: 2 }),
    quote: makeQuote({ quoteId: 'quote-orphan-open', bestAsk: 0.41, midpoint: 0.405 })
  });

  const reconcile = await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-matched-open',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        limitPrice: 0.42,
        requestedQuantity: 2,
        filledQuantity: 0,
        remainingQuantity: 2,
        status: 'open'
      },
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-orphan-untracked',
        clientOrderId: 'external-order-123',
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'sell',
        limitPrice: 0.7,
        requestedQuantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        status: 'open'
      }
    ],
    fills: [],
    positions: []
  });

  assert.deepEqual(reconcile.unmatchedVenueOrderIds, ['venue-orphan-untracked']);

  const projection = await ledger.readProjection();
  assert.equal(projection.orders.get(submission.orderId)?.status, 'open');
  assert.equal(projection.fills.length, 0);
  assert.equal(projection.positions.get(POSITION_KEY), undefined);
});

test('reduce-only flatten uses only unreserved inventory and records the operator trail before submit', async () => {
  let submitCount = 0;
  const { adapter, ledger } = await createHarness(async (request, { ledger: liveLedger }) => {
    submitCount += 1;

    if (submitCount === 1) {
      return {
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, {
          venueOrderId: 'venue-entry-seeded',
          status: 'filled',
          filledQuantity: 5,
          remainingQuantity: 0
        }),
        fills: [
          makeVenueFill(request, {
            venueFillId: 'venue-fill-seeded-entry',
            venueOrderId: 'venue-entry-seeded',
            price: 0.4,
            quantity: 5
          })
        ]
      };
    }

    if (submitCount === 2) {
      return {
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, {
          venueOrderId: 'venue-existing-exit',
          side: 'sell',
          limitPrice: 0.6,
          requestedQuantity: 2,
          filledQuantity: 0,
          remainingQuantity: 2,
          status: 'open'
        })
      };
    }

    const projection = await liveLedger.readProjection();
    const flattenAction = projection.operatorActions.at(-1);
    const pendingFlatten = projection.orders.get(request.clientOrderId);

    assert.equal(request.intent.reduceOnly, true);
    assert.equal(request.intent.side, 'sell');
    assert.equal(request.intent.quantity, 3);
    assert.equal(request.intent.metadata?.operatorAction, 'flatten');
    assert.ok(flattenAction);
    assert.equal(flattenAction.action, 'flatten-requested');
    assert.deepEqual(flattenAction.metadata, {
      quantity: 3,
      reservedSellQuantity: 2
    });
    assert.equal(pendingFlatten?.status, 'pending-submit');

    return {
      transportStatus: 'acknowledged',
      order: makeVenueOrder(request, {
        venueOrderId: 'venue-flatten-open',
        side: 'sell',
        limitPrice: 0.58,
        requestedQuantity: 3,
        filledQuantity: 0,
        remainingQuantity: 3,
        status: 'open'
      })
    };
  });

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-for-flatten', side: 'buy', limitPrice: 0.42, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-flatten-entry', bestAsk: 0.4, midpoint: 0.395 })
  });

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'sell-existing-working-exit', side: 'sell', limitPrice: 0.6, quantity: 2 }),
    quote: makeQuote({ quoteId: 'quote-working-exit', bestBid: 0.57, bestAsk: 0.59, midpoint: 0.58 })
  });

  const flatten = await adapter.requestFlatten({
    sessionId: 'operator-session',
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    quote: makeQuote({ quoteId: 'quote-flatten-request', bestBid: 0.58, bestAsk: 0.59, midpoint: 0.585 }),
    note: 'Operator flatten after live mismatch'
  });

  assert.equal(flatten.status, 'open');
  assert.equal(flatten.orderEvent.side, 'sell');
  assert.equal(flatten.orderEvent.requestedQuantity, 3);

  const projection = await ledger.readProjection();
  const openSellOrders = [...projection.orders.values()].filter((order) => order.side === 'sell' && order.status === 'open');

  assert.equal(projection.positions.get(POSITION_KEY)?.netQuantity, 5);
  assert.equal(projection.positions.get(POSITION_KEY)?.realizedPnl, 0);
  assert.deepEqual(openSellOrders.map((order) => order.remainingQuantity), [2, 3]);
});

test('restart recovery reattaches late venue evidence by clientOrderId instead of orphaning the tracked order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wraith-live-restart-'));
  cleanupDirs.push(directory);

  const ledgerBeforeRestart = new JsonlLedger({ directory, clock });
  await ledgerBeforeRestart.init();
  const adapterBeforeRestart = new LiveExecutionAdapter(
    ledgerBeforeRestart,
    {
      submitOrder: async () => {
        throw new Error('gateway timeout before ACK');
      }
    },
    {
      enabled: true,
      clock
    }
  );

  const submission = await adapterBeforeRestart.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-timeout-before-ack', side: 'buy', limitPrice: 0.42, quantity: 4 }),
    quote: makeQuote({ quoteId: 'quote-timeout-entry', bestAsk: 0.41, midpoint: 0.405 })
  });

  assert.equal(submission.status, 'reconcile');

  const ledgerAfterRestart = new JsonlLedger({ directory, clock });
  await ledgerAfterRestart.init();
  const projectionAfterRestart = await ledgerAfterRestart.readProjection();

  assert.equal(projectionAfterRestart.orders.get(submission.orderId)?.status, 'reconcile');
  assert.equal(projectionAfterRestart.positions.get(POSITION_KEY), undefined);

  const adapterAfterRestart = new LiveExecutionAdapter(
    ledgerAfterRestart,
    {
      submitOrder: async () => {
        throw new Error('submit should not run during recovery reconciliation');
      }
    },
    {
      enabled: true,
      clock
    }
  );

  const recovered = await adapterAfterRestart.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-late-ack',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        limitPrice: 0.42,
        requestedQuantity: 4,
        filledQuantity: 4,
        remainingQuantity: 0,
        status: 'filled'
      }
    ],
    fills: [
      {
        venueFillId: 'venue-fill-late-ack',
        venueOrderId: 'venue-late-ack',
        clientOrderId: submission.orderId,
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        price: 0.4,
        quantity: 4,
        fee: 0,
        liquidityRole: 'taker',
        occurredAt: FIXED_NOW
      }
    ],
    positions: []
  });

  assert.deepEqual(recovered.filledOrderIds, [submission.orderId]);
  assert.deepEqual(recovered.reconcileRequiredOrderIds, []);

  const finalProjection = await ledgerAfterRestart.readProjection();
  assert.equal(finalProjection.orders.get(submission.orderId)?.status, 'filled');
  assert.equal(finalProjection.orders.get(submission.orderId)?.venueOrderId, 'venue-late-ack');
  assert.equal(finalProjection.positions.get(POSITION_KEY)?.netQuantity, 4);
});
