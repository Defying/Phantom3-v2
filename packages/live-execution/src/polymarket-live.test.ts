import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JsonlLedger, positionKeyFor } from '../../ledger/src/index.js';
import {
  DEFAULT_POLYMARKET_SUBMIT_BLOCKED_REASON,
  LiveExecutionAdapter,
  PolymarketLiveGateway,
  buildPolymarketL2Headers,
  buildPolymarketTrackedVenueStateSnapshot,
  type ApprovedTradeIntent,
  type LiveExchangeGateway,
  type PaperQuote,
  type TrackedVenueOrderRef
} from './index.js';

const FIXED_NOW = '2026-04-21T16:00:00.000Z';
const MARKET_ID = 'market-1';
const TOKEN_ID = 'token-yes';
const SESSION_ID = 'polymarket-live-tests';
const STRATEGY_ID = 'live-thin-slice';
const cleanupDirs: string[] = [];

after(async () => {
  await Promise.all(cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock(): Date {
  return new Date(FIXED_NOW);
}

function makeIdFactory() {
  let next = 0;
  return () => `test-${++next}`;
}

async function createHarness(exchange: LiveExchangeGateway) {
  const directory = await mkdtemp(join(tmpdir(), 'phantom3-polymarket-live-'));
  cleanupDirs.push(directory);

  const ledger = new JsonlLedger({ directory, clock });
  await ledger.init();

  return {
    ledger,
    adapter: new LiveExecutionAdapter(ledger, exchange, {
      enabled: true,
      clock,
      idFactory: makeIdFactory()
    })
  };
}

function makeIntent(overrides: Partial<ApprovedTradeIntent> & Pick<ApprovedTradeIntent, 'intentId' | 'side' | 'limitPrice' | 'quantity'>): ApprovedTradeIntent {
  return {
    sessionId: SESSION_ID,
    strategyId: STRATEGY_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    approvedAt: FIXED_NOW,
    thesis: 'Polymarket live adapter test',
    confidence: 0.5,
    reduceOnly: false,
    ...overrides
  };
}

function makeQuote(overrides: Partial<PaperQuote> = {}): PaperQuote {
  return {
    quoteId: 'quote-default',
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    observedAt: FIXED_NOW,
    bestBid: 0.44,
    bestAsk: 0.45,
    midpoint: 0.445,
    source: 'test-quote',
    ...overrides
  };
}

test('buildPolymarketL2Headers uses the documented HMAC format', () => {
  const headers = buildPolymarketL2Headers({
    credentials: {
      address: '0x1111111111111111111111111111111111111111',
      apiKey: 'api-key',
      secret: 'c2VjcmV0',
      passphrase: 'passphrase'
    },
    method: 'GET',
    requestPath: '/data/orders',
    timestamp: 1713830400
  });

  assert.deepEqual(headers, {
    POLY_ADDRESS: '0x1111111111111111111111111111111111111111',
    POLY_SIGNATURE: 'iHYqxz58Z8HTeRpt1svybvTHqypF4lckTbAKgLvXV9M=',
    POLY_TIMESTAMP: '1713830400',
    POLY_API_KEY: 'api-key',
    POLY_PASSPHRASE: 'passphrase'
  });
});

test('PolymarketLiveGateway rejects submit attempts until a signer exists', async () => {
  const gateway = new PolymarketLiveGateway({
    async getOrder() {
      throw new Error('not used');
    }
  });

  const result = await gateway.submitOrder({
    clientOrderId: 'ord-test',
    intent: makeIntent({ intentId: 'intent-submit-blocked', side: 'buy', limitPrice: 0.45, quantity: 10 }),
    quote: makeQuote()
  });

  assert.equal(result.transportStatus, 'rejected');
  assert.equal(result.reason, DEFAULT_POLYMARKET_SUBMIT_BLOCKED_REASON);
});

test('tracked Polymarket snapshots fail closed on venue fills without explicit fill evidence', async () => {
  const exchange: LiveExchangeGateway = {
    async submitOrder(request) {
      return {
        transportStatus: 'acknowledged',
        order: {
          observedAt: FIXED_NOW,
          venueOrderId: 'venue-order-1',
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
          updatedAt: FIXED_NOW
        }
      };
    }
  };

  const { adapter, ledger } = await createHarness(exchange);
  const submit = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'intent-open-buy', side: 'buy', limitPrice: 0.45, quantity: 10 }),
    quote: makeQuote()
  });

  const projectionBefore = await ledger.readProjection();
  const trackedOrder = projectionBefore.orders.get(submit.orderId);
  assert.ok(trackedOrder);
  assert.equal(trackedOrder.venueOrderId, 'venue-order-1');
  assert.equal(projectionBefore.fills.length, 0);
  assert.equal(projectionBefore.positions.get(positionKeyFor(MARKET_ID, TOKEN_ID)), undefined);

  const gateway = new PolymarketLiveGateway({
    async getOrder(orderId) {
      assert.equal(orderId, 'venue-order-1');
      return {
        id: 'venue-order-1',
        status: 'ORDER_STATUS_LIVE',
        owner: 'owner-1',
        maker_address: '0x1111111111111111111111111111111111111111',
        market: MARKET_ID,
        asset_id: TOKEN_ID,
        side: 'BUY',
        original_size: '10000000',
        size_matched: '4000000',
        price: '0.45',
        outcome: 'YES',
        expiration: '1735689600',
        order_type: 'GTC',
        associate_trades: ['trade-123'],
        created_at: 1713801600
      };
    }
  }, { clock });

  const snapshot = await gateway.fetchTrackedVenueStateSnapshot([trackedOrder]);
  assert.equal(snapshot.orders.length, 1);
  assert.equal(snapshot.fills.length, 0);
  assert.equal(snapshot.orders[0]?.status, 'partially-filled');
  assert.equal(snapshot.orders[0]?.filledQuantity, 4);
  assert.equal(snapshot.orders[0]?.clientOrderId, submit.orderId);

  const reconcile = await adapter.reconcileVenueSnapshot(snapshot);
  assert.deepEqual(reconcile.filledOrderIds, []);
  assert.deepEqual(reconcile.reconcileRequiredOrderIds, [submit.orderId]);

  const projectionAfter = await ledger.readProjection();
  const orderAfter = projectionAfter.orders.get(submit.orderId);
  assert.equal(orderAfter?.status, 'reconcile');
  assert.match(orderAfter?.statusReason ?? '', /explicit fill evidence/);
  assert.equal(projectionAfter.fills.length, 0);
  assert.equal(projectionAfter.positions.get(positionKeyFor(MARKET_ID, TOKEN_ID)), undefined);
});

test('tracked Polymarket snapshots refuse orders that do not yet have a venueOrderId', async () => {
  const trackedOrder: TrackedVenueOrderRef = {
    orderId: 'ord-without-venue-id',
    venueOrderId: null
  };

  await assert.rejects(
    buildPolymarketTrackedVenueStateSnapshot({
      client: {
        async getOrder() {
          throw new Error('not used');
        }
      },
      trackedOrders: [trackedOrder]
    }),
    /without a venueOrderId/
  );
});
