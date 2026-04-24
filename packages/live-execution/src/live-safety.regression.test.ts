import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JsonlLedger, getActiveOrders, positionKeyFor, type ApprovedTradeIntent, type PaperQuote } from '../../ledger/src/index.js';
import { LiveExecutionAdapter, type LiveSubmitOrderRequest, type LiveSubmitResult } from './index.js';

const FIXED_NOW = '2026-04-22T01:00:00.000Z';
const MARKET_ID = 'market-1';
const TOKEN_ID = 'token-yes';
const SESSION_ID = 'live-safety-tests';
const STRATEGY_ID = 'live-thin-slice';
const cleanupDirs: string[] = [];

after(async () => {
  await Promise.all(cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

type SubmitResponder = (request: LiveSubmitOrderRequest) => LiveSubmitResult | Promise<LiveSubmitResult>;

async function createHarness(responders: SubmitResponder[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'wraith-live-execution-'));
  cleanupDirs.push(directory);

  let currentNow = FIXED_NOW;
  const clock = () => new Date(currentNow);

  const ledger = new JsonlLedger({ directory, clock });
  await ledger.init();

  let nextId = 0;
  const adapter = new LiveExecutionAdapter(ledger, {
    submitOrder: async (request) => {
      const responder = responders.shift();
      assert.ok(responder, `Unexpected submitOrder call for ${request.clientOrderId}`);
      return responder(request);
    }
  }, {
    enabled: true,
    clock,
    idFactory: () => `test-${++nextId}`
  });

  return {
    directory,
    ledger,
    adapter,
    positionKey: positionKeyFor(MARKET_ID, TOKEN_ID),
    setNow(value: string | Date) {
      currentNow = value instanceof Date ? value.toISOString() : value;
    }
  };
}

function makeIntent(overrides: Partial<ApprovedTradeIntent> & Pick<ApprovedTradeIntent, 'intentId' | 'side' | 'limitPrice' | 'quantity'>): ApprovedTradeIntent {
  return {
    sessionId: SESSION_ID,
    strategyId: STRATEGY_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    approvedAt: FIXED_NOW,
    thesis: 'Live safety regression check',
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

function filledSubmit(price: number): SubmitResponder {
  return (request) => {
    const venueOrderId = `venue-${request.clientOrderId}`;
    return {
      transportStatus: 'acknowledged',
      order: {
        observedAt: FIXED_NOW,
        venueOrderId,
        clientOrderId: request.clientOrderId,
        marketId: request.intent.marketId,
        tokenId: request.intent.tokenId,
        side: request.intent.side,
        limitPrice: request.intent.limitPrice,
        requestedQuantity: request.intent.quantity,
        filledQuantity: request.intent.quantity,
        remainingQuantity: 0,
        status: 'filled',
        acknowledgedAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      },
      fills: [
        {
          venueFillId: `fill-${request.clientOrderId}`,
          venueOrderId,
          clientOrderId: request.clientOrderId,
          marketId: request.intent.marketId,
          tokenId: request.intent.tokenId,
          side: request.intent.side,
          price,
          quantity: request.intent.quantity,
          fee: 0,
          liquidityRole: 'taker',
          occurredAt: FIXED_NOW
        }
      ]
    };
  };
}

function openSubmit(): SubmitResponder {
  return (request) => ({
    transportStatus: 'acknowledged',
    order: {
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
      updatedAt: FIXED_NOW
    }
  });
}

test('requestFlatten fails closed while a working buy order still exists', async () => {
  const { adapter, ledger, positionKey } = await createHarness([
    filledSubmit(0.4),
    openSubmit()
  ]);

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-filled', side: 'buy', limitPrice: 0.45, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-buy-filled' })
  });

  const workingEntry = await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-working', side: 'buy', limitPrice: 0.35, quantity: 2 }),
    quote: makeQuote({ quoteId: 'quote-buy-working' })
  });
  assert.equal(workingEntry.status, 'open');

  await assert.rejects(
    adapter.requestFlatten({
      sessionId: SESSION_ID,
      marketId: MARKET_ID,
      tokenId: TOKEN_ID,
      quote: makeQuote({ quoteId: 'quote-flatten', bestBid: 0.34, bestAsk: 0.35 })
    }),
    /Cannot flatten while 1 working buy order still needs reconciliation/
  );

  const projection = await ledger.readProjection();
  assert.equal(projection.positions.get(positionKey)?.netQuantity, 5);
  assert.equal(getActiveOrders(projection, { marketId: MARKET_ID, tokenId: TOKEN_ID }).filter((order) => order.side === 'buy').length, 1);
  assert.equal(projection.operatorActions.length, 0);
});

test('reconcileVenueSnapshot surfaces unmatched venue fills for caller-side incident handling', async () => {
  const { adapter } = await createHarness();

  const result = await adapter.reconcileVenueSnapshot({
    observedAt: FIXED_NOW,
    orders: [],
    fills: [
      {
        venueFillId: 'fill-orphan-1',
        venueOrderId: 'venue-order-orphan-1',
        clientOrderId: 'client-order-orphan-1',
        marketId: MARKET_ID,
        tokenId: TOKEN_ID,
        side: 'buy',
        price: 0.41,
        quantity: 1,
        fee: 0,
        liquidityRole: 'taker',
        occurredAt: FIXED_NOW
      }
    ],
    positions: []
  });

  assert.deepEqual(result.reconciledOrderIds, []);
  assert.deepEqual(result.unmatchedVenueOrderIds, []);
  assert.deepEqual(result.unmatchedVenueFillIds, ['fill-orphan-1']);
  assert.equal(result.envelopes.length, 0);
});


test('reconcileStartupState fails closed when venue inventory is missing a tracked live position', async () => {
  const { adapter, positionKey } = await createHarness([filledSubmit(0.4)]);

  await adapter.submitApprovedIntent({
    intent: makeIntent({ intentId: 'buy-startup-mismatch', side: 'buy', limitPrice: 0.45, quantity: 5 }),
    quote: makeQuote({ quoteId: 'quote-startup-mismatch' })
  });

  const result = await adapter.reconcileStartupState({
    observedAt: FIXED_NOW,
    orders: [],
    fills: [],
    positions: []
  });

  assert.equal(result.clean, false);
  assert.deepEqual(result.trackedLivePositionKeys, [positionKey]);
  assert.deepEqual(result.positionMismatchKeys, [positionKey]);
  assert.match(result.reasons[0] ?? '', /missing from the venue position snapshot/i);
});
