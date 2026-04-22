import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { getOpenOrders, JsonlLedger, positionKeyFor } from '../../ledger/src/index.js';
import {
  LiveExecutionAdapter,
  type ApprovedTradeIntent,
  type LiveExecutionResult,
  type LiveSubmitOrderRequest,
  type LiveSubmitResult,
  type LiveVenueFill,
  type LiveVenueOrderSnapshot,
  type PaperQuote
} from './index.js';

const FIXED_NOW = '2026-04-21T16:00:00.000Z';
const LATER_NOW = '2026-04-21T16:00:05.000Z';
const MARKET_ID = 'market-1';
const TOKEN_ID = 'token-yes';
const SESSION_ID = 'live-safety-tests';
const STRATEGY_ID = 'live-thin-slice';
const cleanupDirs: string[] = [];

type QueuedResponse = LiveSubmitResult | ((request: LiveSubmitOrderRequest) => LiveSubmitResult | Promise<LiveSubmitResult>);

after(async () => {
  await Promise.all(cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

function createMutableClock(initial = FIXED_NOW) {
  let current = initial;
  return {
    clock: () => new Date(current),
    now: () => current,
    setNow: (value: string) => {
      current = value;
    }
  };
}

async function createHarness(options: {
  responses?: QueuedResponse[];
  maxQuoteAgeMs?: number;
  maxReconcileAgeMs?: number;
  missingOrderGraceMs?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'phantom3-live-execution-safety-'));
  cleanupDirs.push(directory);

  const time = createMutableClock();
  const requests: LiveSubmitOrderRequest[] = [];
  const queue = [...(options.responses ?? [])];
  const exchange = {
    async submitOrder(request: LiveSubmitOrderRequest): Promise<LiveSubmitResult> {
      requests.push(request);
      const next = queue.shift();
      if (!next) {
        throw new Error(`Unexpected live submit for ${request.clientOrderId}.`);
      }
      return typeof next === 'function' ? await next(request) : next;
    }
  };

  const makeLedger = async () => {
    const ledger = new JsonlLedger({ directory, clock: time.clock });
    await ledger.init();
    return ledger;
  };
  const makeAdapter = (ledger: JsonlLedger) => new LiveExecutionAdapter(ledger, exchange, {
    enabled: true,
    clock: time.clock,
    maxQuoteAgeMs: options.maxQuoteAgeMs ?? 60_000,
    maxReconcileAgeMs: options.maxReconcileAgeMs ?? 60_000,
    missingOrderGraceMs: options.missingOrderGraceMs ?? 30_000
  });

  const ledger = await makeLedger();

  return {
    directory,
    ledger,
    adapter: makeAdapter(ledger),
    requests,
    now: time.now,
    setNow: time.setNow,
    reopen: async () => {
      const nextLedger = await makeLedger();
      return {
        ledger: nextLedger,
        adapter: makeAdapter(nextLedger)
      };
    }
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

function makeVenueOrder(request: LiveSubmitOrderRequest, overrides: Partial<LiveVenueOrderSnapshot> = {}): LiveVenueOrderSnapshot {
  return {
    observedAt: FIXED_NOW,
    venueOrderId: `venue-${request.clientOrderId}`,
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
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

function makeVenueFill(request: LiveSubmitOrderRequest, overrides: Partial<LiveVenueFill> = {}): LiveVenueFill {
  return {
    venueFillId: `fill-${request.clientOrderId}`,
    venueOrderId: `venue-${request.clientOrderId}`,
    clientOrderId: request.clientOrderId,
    marketId: request.intent.marketId,
    tokenId: request.intent.tokenId,
    side: request.intent.side,
    price: request.intent.limitPrice,
    quantity: request.intent.quantity,
    fee: 0,
    liquidityRole: 'taker',
    occurredAt: FIXED_NOW,
    ...overrides
  };
}

function makeRestingSnapshot(result: LiveExecutionResult, overrides: Partial<LiveVenueOrderSnapshot> = {}): LiveVenueOrderSnapshot {
  return {
    observedAt: FIXED_NOW,
    clientOrderId: result.orderId,
    marketId: result.orderEvent.marketId,
    tokenId: result.orderEvent.tokenId,
    side: result.orderEvent.side,
    limitPrice: result.orderEvent.limitPrice,
    requestedQuantity: result.orderEvent.requestedQuantity,
    filledQuantity: result.orderEvent.filledQuantity,
    remainingQuantity: result.orderEvent.remainingQuantity,
    status: 'open',
    acknowledgedAt: result.orderEvent.acknowledgedAt ?? FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

test('kill switch latches across restart and only releases once the live book is flat', async () => {
  const harness = await createHarness({
    responses: [
      (request) => ({
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, {
          status: 'filled',
          filledQuantity: request.intent.quantity,
          remainingQuantity: 0
        }),
        fills: [makeVenueFill(request, { price: 0.41 })]
      }),
      (request) => ({
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, {
          status: 'filled',
          filledQuantity: request.intent.quantity,
          remainingQuantity: 0
        }),
        fills: [makeVenueFill(request, { side: 'sell', price: 0.52 })]
      }),
      (request) => ({
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, { status: 'open' })
      })
    ]
  });
  const positionKey = positionKeyFor(MARKET_ID, TOKEN_ID);

  const entry = await harness.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-entry', side: 'buy', limitPrice: 0.45, quantity: 4 }),
    quote: makeQuote({ quoteId: 'quote-entry', bestBid: 0.4, bestAsk: 0.41, midpoint: 0.405 })
  });
  assert.equal(entry.status, 'filled');
  assert.equal((await harness.ledger.readProjection()).positions.get(positionKey)?.netQuantity, 4);

  await harness.adapter.engageKillSwitch({ sessionId: SESSION_ID, note: 'operator trip' });

  const blocked = await harness.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'blocked-while-tripped', side: 'buy', limitPrice: 0.43, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-blocked' })
  });
  assert.equal(blocked.status, 'rejected');
  assert.match(blocked.orderEvent.rejectionReason ?? '', /kill switch/i);
  assert.equal(harness.requests.length, 1);

  const restarted = await harness.reopen();
  assert.equal((await restarted.ledger.readProjection()).killSwitch.active, true);

  const blockedAfterRestart = await restarted.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'blocked-after-restart', side: 'buy', limitPrice: 0.44, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-blocked-after-restart' })
  });
  assert.equal(blockedAfterRestart.status, 'rejected');
  assert.match(blockedAfterRestart.orderEvent.rejectionReason ?? '', /kill switch/i);
  assert.equal(harness.requests.length, 1);

  await assert.rejects(
    restarted.adapter.releaseKillSwitch({ sessionId: SESSION_ID, note: 'too early' }),
    /Cannot release the live kill switch/
  );

  const reduceOnlyExit = await restarted.adapter.submitApprovedIntent({
    intent: makeIntent({
      intentId: 'reduce-only-exit',
      side: 'sell',
      limitPrice: 0.52,
      quantity: 4,
      reduceOnly: true
    }),
    quote: makeQuote({ quoteId: 'quote-reduce-only-exit', bestBid: 0.51, bestAsk: 0.52, midpoint: 0.515 })
  });
  assert.equal(reduceOnlyExit.status, 'filled');

  const flattenedProjection = await restarted.ledger.readProjection();
  assert.equal(flattenedProjection.positions.get(positionKey)?.netQuantity, 0);
  assert.equal(flattenedProjection.killSwitch.active, true);

  await restarted.adapter.releaseKillSwitch({ sessionId: SESSION_ID, note: 'flat and clean' });
  assert.equal((await restarted.ledger.readProjection()).killSwitch.active, false);

  const postReleaseEntry = await restarted.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-after-release', side: 'buy', limitPrice: 0.42, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-post-release' })
  });
  assert.equal(postReleaseEntry.status, 'open');
  assert.equal(harness.requests.length, 3);
});

test('flatten stays reduce-only, restart preserves working exits, and resting sells do not close positions locally', async () => {
  const harness = await createHarness({
    responses: [
      (request) => ({
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, {
          status: 'filled',
          filledQuantity: request.intent.quantity,
          remainingQuantity: 0
        }),
        fills: [makeVenueFill(request, { price: 0.41 })]
      }),
      (request) => ({
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, { status: 'open' })
      }),
      (request) => ({
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, { status: 'open' })
      })
    ]
  });
  const positionKey = positionKeyFor(MARKET_ID, TOKEN_ID);

  await harness.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-entry', side: 'buy', limitPrice: 0.45, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-entry', bestBid: 0.4, bestAsk: 0.41, midpoint: 0.405 })
  });

  const workingExit = await harness.adapter.submitApprovedIntent({
    intent: makeIntent({
      intentId: 'working-exit',
      side: 'sell',
      limitPrice: 0.55,
      quantity: 2,
      reduceOnly: true
    }),
    quote: makeQuote({ quoteId: 'quote-working-exit', bestBid: 0.5, bestAsk: 0.51, midpoint: 0.505 })
  });
  assert.equal(workingExit.status, 'open');

  await harness.adapter.engageKillSwitch({ sessionId: SESSION_ID, note: 'flatten in progress' });

  const flatten = await harness.adapter.requestFlatten({
    sessionId: SESSION_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    note: 'operator flatten',
    quote: makeQuote({ quoteId: 'quote-flatten', bestBid: 0.5, bestAsk: 0.51, midpoint: 0.505 })
  });
  assert.equal(flatten.status, 'open');

  const flattenRequest = harness.requests.at(-1);
  assert.ok(flattenRequest);
  assert.equal(flattenRequest.intent.reduceOnly, true);
  assert.equal(flattenRequest.intent.side, 'sell');
  assert.equal(flattenRequest.intent.quantity, 3);
  assert.equal(flattenRequest.intent.strategyId, 'operator-flatten');
  assert.deepEqual(flattenRequest.intent.metadata, { operatorAction: 'flatten' });

  const projection = await harness.ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 5);
  assert.equal(projection.killSwitch.active, true);
  assert.equal(projection.operatorActions.some((event) => event.action === 'flatten-requested'), true);
  assert.deepEqual(getOpenOrders(projection).map((order) => order.orderId).sort(), [workingExit.orderId, flatten.orderId].sort());

  const restarted = await harness.reopen();
  const projectionAfterRestart = await restarted.ledger.readProjection();
  assert.equal(projectionAfterRestart.positions.get(positionKey)?.netQuantity, 5);
  assert.deepEqual(getOpenOrders(projectionAfterRestart).map((order) => order.orderId).sort(), [workingExit.orderId, flatten.orderId].sort());

  const reconcile = await restarted.adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      makeRestingSnapshot(workingExit),
      makeRestingSnapshot(flatten),
      {
        observedAt: FIXED_NOW,
        venueOrderId: 'venue-untracked-exit',
        clientOrderId: 'untracked-exit',
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'sell',
        limitPrice: 0.56,
        requestedQuantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        status: 'open',
        acknowledgedAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      }
    ],
    fills: []
  });
  assert.deepEqual(reconcile.filledOrderIds, []);
  assert.deepEqual(reconcile.reconcileRequiredOrderIds, []);
  assert.deepEqual(reconcile.unmatchedVenueOrderIds, ['venue-untracked-exit']);

  const finalProjection = await restarted.ledger.readProjection();
  assert.equal(finalProjection.positions.get(positionKey)?.netQuantity, 5);
  assert.equal(finalProjection.orders.get(workingExit.orderId)?.status, 'open');
  assert.equal(finalProjection.orders.get(flatten.orderId)?.status, 'open');
});

test('ambiguous submit results trip the kill switch and fail closed for new entries', async () => {
  const harness = await createHarness({
    responses: [
      (request) => ({
        transportStatus: 'ambiguous',
        reason: 'Adapter timed out before the venue ack was trustworthy.',
        order: makeVenueOrder(request, { status: 'open', ambiguous: true })
      })
    ]
  });

  const ambiguous = await harness.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'ambiguous-entry', side: 'buy', limitPrice: 0.45, quantity: 2 }),
    quote: makeQuote({ quoteId: 'quote-ambiguous-entry' })
  });
  assert.equal(ambiguous.status, 'reconcile');

  const projection = await harness.ledger.readProjection();
  assert.equal(projection.orders.get(ambiguous.orderId)?.status, 'reconcile');
  assert.equal(projection.killSwitch.active, true);
  assert.match(projection.killSwitch.reason ?? '', /ambiguous|manual reconciliation/i);

  const blocked = await harness.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'blocked-after-ambiguity', side: 'buy', limitPrice: 0.44, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-blocked-after-ambiguity' })
  });
  assert.equal(blocked.status, 'rejected');
  assert.match(blocked.orderEvent.rejectionReason ?? '', /kill switch|reconciliation/i);
  assert.equal(harness.requests.length, 1);
});

test('stale venue snapshots mark tracked orders reconcile and keep new entries blocked', async () => {
  const harness = await createHarness({
    maxReconcileAgeMs: 1_000,
    responses: [
      (request) => ({
        transportStatus: 'acknowledged',
        order: makeVenueOrder(request, { status: 'open' })
      })
    ]
  });

  const workingEntry = await harness.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'working-entry', side: 'buy', limitPrice: 0.45, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-working-entry' })
  });
  assert.equal(workingEntry.status, 'open');

  harness.setNow(LATER_NOW);

  const stale = await harness.adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [makeRestingSnapshot(workingEntry)],
    fills: []
  });
  assert.deepEqual(stale.reconcileRequiredOrderIds, [workingEntry.orderId]);
  assert.match(stale.skippedReason ?? '', /older than 1000ms/);

  const projection = await harness.ledger.readProjection();
  assert.equal(projection.orders.get(workingEntry.orderId)?.status, 'reconcile');
  assert.equal(projection.killSwitch.active, true);

  const blocked = await harness.adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'blocked-after-stale-reconcile', side: 'buy', limitPrice: 0.43, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-blocked-after-stale-reconcile', observedAt: LATER_NOW })
  });
  assert.equal(blocked.status, 'rejected');
  assert.match(blocked.orderEvent.rejectionReason ?? '', /kill switch|reconciliation/i);
  assert.equal(harness.requests.length, 1);
});
