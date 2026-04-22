import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  JsonlLedger,
  LiveExecutionAdapter,
  type ApprovedTradeIntent,
  type LiveExchangeGateway,
  type LiveSubmitResult,
  type LiveVenueFill,
  type LiveVenueOrderSnapshot,
  type PaperQuote
} from './index.js';
import { positionKeyFor } from '../../ledger/src/index.js';

const FIXED_NOW = '2026-04-21T20:00:00.000Z';
const MARKET_ID = 'market-1';
const TOKEN_ID = 'token-yes';
const SESSION_ID = 'live-execution-tests';
const STRATEGY_ID = 'live-thin-slice';
const cleanupDirs: string[] = [];

after(async () => {
  await Promise.all(cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock(): Date {
  return new Date(FIXED_NOW);
}

function makeIntent(overrides: Partial<ApprovedTradeIntent> & Pick<ApprovedTradeIntent, 'intentId' | 'side' | 'limitPrice' | 'quantity'>): ApprovedTradeIntent {
  return {
    sessionId: SESSION_ID,
    strategyId: STRATEGY_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    approvedAt: FIXED_NOW,
    thesis: 'Live safety regression',
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
    bestBid: 0.59,
    bestAsk: 0.6,
    midpoint: 0.595,
    source: 'test-quote',
    ...overrides
  };
}

function makeVenueOrder(input: {
  clientOrderId: string;
  venueOrderId: string;
  side: 'buy' | 'sell';
  limitPrice: number;
  requestedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  status: LiveVenueOrderSnapshot['status'];
}): LiveVenueOrderSnapshot {
  return {
    observedAt: FIXED_NOW,
    acknowledgedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    clientOrderId: input.clientOrderId,
    venueOrderId: input.venueOrderId,
    side: input.side,
    limitPrice: input.limitPrice,
    requestedQuantity: input.requestedQuantity,
    filledQuantity: input.filledQuantity,
    remainingQuantity: input.remainingQuantity,
    status: input.status
  };
}

function makeVenueFill(input: {
  venueFillId: string;
  clientOrderId: string;
  venueOrderId: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
}): LiveVenueFill {
  return {
    venueFillId: input.venueFillId,
    clientOrderId: input.clientOrderId,
    venueOrderId: input.venueOrderId,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    side: input.side,
    price: input.price,
    quantity: input.quantity,
    fee: 0,
    liquidityRole: 'taker',
    occurredAt: FIXED_NOW
  };
}

class QueueExchange implements LiveExchangeGateway {
  private readonly responses: Array<(clientOrderId: string) => LiveSubmitResult>;
  calls = 0;

  constructor(responses: Array<(clientOrderId: string) => LiveSubmitResult>) {
    this.responses = [...responses];
  }

  async submitOrder(request: { clientOrderId: string }): Promise<LiveSubmitResult> {
    this.calls += 1;
    const next = this.responses.shift();
    if (!next) {
      throw new Error(`Unexpected live submit for ${request.clientOrderId}.`);
    }
    return next(request.clientOrderId);
  }
}

async function createHarness(exchange: LiveExchangeGateway) {
  const directory = await mkdtemp(join(tmpdir(), 'phantom3-live-execution-'));
  cleanupDirs.push(directory);

  const ledger = new JsonlLedger({ directory, clock });
  await ledger.init();

  return {
    directory,
    ledger,
    adapter: new LiveExecutionAdapter(ledger, exchange, { enabled: true, clock }),
    positionKey: positionKeyFor(MARKET_ID, TOKEN_ID)
  };
}

test('late venue fills for a locally canceled order are recorded and leave the order in reconcile instead of being ignored', async () => {
  const exchange = new QueueExchange([
    (clientOrderId) => ({
      transportStatus: 'acknowledged',
      order: makeVenueOrder({
        clientOrderId,
        venueOrderId: 'venue-entry',
        side: 'buy',
        limitPrice: 0.6,
        requestedQuantity: 2,
        filledQuantity: 2,
        remainingQuantity: 0,
        status: 'filled'
      }),
      fills: [
        makeVenueFill({
          venueFillId: 'venue-fill-entry',
          clientOrderId,
          venueOrderId: 'venue-entry',
          side: 'buy',
          price: 0.6,
          quantity: 2
        })
      ]
    }),
    (clientOrderId) => ({
      transportStatus: 'acknowledged',
      order: makeVenueOrder({
        clientOrderId,
        venueOrderId: 'venue-exit',
        side: 'sell',
        limitPrice: 0.66,
        requestedQuantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        status: 'open'
      })
    })
  ]);
  const { adapter, ledger, positionKey } = await createHarness(exchange);

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-entry', side: 'buy', limitPrice: 0.6, quantity: 2 }),
    quote: makeQuote({ quoteId: 'quote-entry', bestBid: 0.59, bestAsk: 0.6, midpoint: 0.595 })
  });

  const exit = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'sell-exit', side: 'sell', limitPrice: 0.66, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-exit', bestBid: 0.65, bestAsk: 0.66, midpoint: 0.655 })
  });
  assert.equal(exit.status, 'open');

  await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      makeVenueOrder({
        clientOrderId: exit.orderId,
        venueOrderId: 'venue-exit',
        side: 'sell',
        limitPrice: 0.66,
        requestedQuantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        status: 'canceled'
      })
    ],
    fills: []
  });

  let projection = await ledger.readProjection();
  assert.equal(projection.orders.get(exit.orderId)?.status, 'canceled');
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 2);

  const lateFill = await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      makeVenueOrder({
        clientOrderId: exit.orderId,
        venueOrderId: 'venue-exit',
        side: 'sell',
        limitPrice: 0.66,
        requestedQuantity: 1,
        filledQuantity: 1,
        remainingQuantity: 0,
        status: 'filled'
      })
    ],
    fills: [
      makeVenueFill({
        venueFillId: 'venue-fill-exit-late',
        clientOrderId: exit.orderId,
        venueOrderId: 'venue-exit',
        side: 'sell',
        price: 0.67,
        quantity: 1
      })
    ]
  });

  assert.deepEqual(lateFill.filledOrderIds, [exit.orderId]);
  assert.deepEqual(lateFill.unmatchedVenueFillIds, []);

  projection = await ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 1);
  assert.ok(Math.abs((projection.positions.get(positionKey)?.realizedPnl ?? 0) - 0.07) < 1e-9);
  assert.equal(projection.orders.get(exit.orderId)?.status, 'reconcile');
  assert.match(projection.orders.get(exit.orderId)?.statusReason ?? '', /local status canceled/);
});

test('unmatched venue activity trips the live kill switch instead of being ignored', async () => {
  const exchange = new QueueExchange([]);
  const { adapter, ledger } = await createHarness(exchange);

  const reconciliation = await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [
      makeVenueOrder({
        clientOrderId: 'rogue-client-order',
        venueOrderId: 'rogue-venue-order',
        side: 'buy',
        limitPrice: 0.55,
        requestedQuantity: 3,
        filledQuantity: 1,
        remainingQuantity: 2,
        status: 'partially-filled'
      })
    ],
    fills: [
      makeVenueFill({
        venueFillId: 'rogue-venue-fill',
        clientOrderId: 'rogue-client-order',
        venueOrderId: 'rogue-venue-order',
        side: 'buy',
        price: 0.55,
        quantity: 1
      })
    ]
  });

  assert.deepEqual(reconciliation.unmatchedVenueOrderIds, ['rogue-venue-order']);
  assert.deepEqual(reconciliation.unmatchedVenueFillIds, ['rogue-venue-fill']);

  const projection = await ledger.readProjection();
  assert.equal(projection.killSwitch.active, true);
  assert.match(projection.killSwitch.reason ?? '', /Automatic live kill switch/);
  assert.equal(exchange.calls, 0);

  const rejected = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'blocked-entry', side: 'buy', limitPrice: 0.55, quantity: 1 }),
    quote: makeQuote({ quoteId: 'quote-blocked', bestBid: 0.54, bestAsk: 0.55, midpoint: 0.545 })
  });

  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.orderEvent.rejectionReason ?? '', /Live kill switch is active/);
  assert.equal(exchange.calls, 0);
});
