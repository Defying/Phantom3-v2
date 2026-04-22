import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../../../packages/config/src/index.js';
import {
  RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE,
  type RuntimeMarket,
  type RuntimeState
} from '../../../packages/contracts/src/index.js';
import { JsonlLedger } from '../../../packages/ledger/src/index.js';
import {
  describePolymarketAccess,
  describePolymarketTransport,
  type MarketSnapshot
} from '../../../packages/market-data/src/index.js';
import { PaperExecutionAdapter } from '../../../packages/paper-execution/src/index.js';
import { RuntimeStore } from './runtime-store.js';

const OPENED_AT = '2026-04-21T16:00:00.000Z';
const REFRESHED_AT = '2026-04-21T16:05:00.000Z';

type Harness = {
  root: string;
  store: RuntimeStore;
  trackedMarket: RuntimeMarket;
  snapshotMarket: RuntimeMarket;
};

function makeMarket(overrides: Partial<RuntimeMarket> = {}): RuntimeMarket {
  return {
    id: 'market-tracked',
    eventId: 'event-tracked',
    slug: 'market-tracked',
    eventTitle: 'Tracked market',
    question: 'Will SOL close higher?',
    yesLabel: 'Yes',
    noLabel: 'No',
    yesTokenId: 'token-yes',
    noTokenId: 'token-no',
    yesPrice: 0.42,
    noPrice: 0.58,
    priceSource: RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE,
    spread: 0.03,
    volume24hr: 12_000,
    liquidity: 25_000,
    endDate: '2026-12-31T00:00:00.000Z',
    url: 'https://example.com/markets/tracked',
    ...overrides
  };
}

function makeConfig(root: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 4317,
    remoteDashboardEnabled: false,
    publicBaseUrl: 'http://127.0.0.1:4317',
    dataDir: join(root, 'data'),
    logDir: join(root, 'logs'),
    marketRefreshMs: 30_000,
    marketLimit: 1,
    polymarketProxy: null,
    polymarketProxyUrl: null,
    polymarketOperatorEligibility: 'unknown',
    liveModeEnabled: false,
    liveArmingEnabled: false,
    liveExecution: {
      enabled: false,
      venue: 'polymarket',
      maxQuoteAgeMs: 5_000,
      maxReconcileAgeMs: 15_000,
      missingOrderGraceMs: 30_000
    },
    controlToken: 'test-control-token-1234'
  };
}

function makeSnapshot(markets: RuntimeMarket[], fetchedAt = REFRESHED_AT): MarketSnapshot {
  return {
    fetchedAt,
    markets,
    transport: describePolymarketTransport(),
    access: describePolymarketAccess({ operatorEligibility: 'unknown' })
  };
}

async function createHarness(options: { withWorkingOrder?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-runtime-store-'));
  const dataDir = join(root, 'data');
  const logDir = join(root, 'logs');
  await mkdir(dataDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const trackedMarket = makeMarket();
  const snapshotMarket = makeMarket({
    id: 'market-topn',
    eventId: 'event-topn',
    slug: 'market-topn',
    eventTitle: 'Top-N market',
    question: 'Will BTC trade above $100k?',
    yesTokenId: 'token-topn-yes',
    noTokenId: 'token-topn-no',
    yesPrice: null,
    noPrice: null,
    spread: null,
    volume24hr: null,
    liquidity: null,
    url: 'https://example.com/markets/topn'
  });

  await writeFile(
    join(dataDir, 'runtime-state.json'),
    `${JSON.stringify({
      marketData: {
        source: 'Polymarket Gamma + CLOB',
        syncedAt: OPENED_AT,
        stale: true,
        refreshIntervalMs: 30_000,
        error: 'seeded runtime-store regression test'
      },
      markets: [trackedMarket],
      events: []
    }, null, 2)}\n`,
    'utf8'
  );

  let now = new Date(OPENED_AT);
  const clock = () => now;
  const ledger = new JsonlLedger({ directory: dataDir, clock });
  await ledger.init();
  const execution = new PaperExecutionAdapter(ledger, {
    clock,
    allowPartialFills: false
  });

  await execution.submitApprovedIntent({
    intent: {
      sessionId: 'runtime-store-test',
      intentId: 'intent-open-no',
      strategyId: 'runtime-store-test',
      marketId: trackedMarket.id,
      tokenId: trackedMarket.noTokenId ?? 'token-no',
      side: 'buy',
      limitPrice: 0.59,
      quantity: 5,
      approvedAt: now.toISOString(),
      thesis: 'Seed a tracked NO position.'
    },
    quote: {
      quoteId: 'quote-open-no',
      marketId: trackedMarket.id,
      tokenId: trackedMarket.noTokenId ?? 'token-no',
      observedAt: now.toISOString(),
      bestBid: 0.58,
      bidSize: 5,
      bestAsk: 0.59,
      askSize: 5,
      midpoint: 0.585,
      source: 'runtime-store-test'
    }
  });

  if (options.withWorkingOrder) {
    now = new Date(REFRESHED_AT);
    await execution.submitApprovedIntent({
      intent: {
        sessionId: 'runtime-store-test',
        intentId: 'intent-resting-exit',
        strategyId: 'runtime-store-test',
        marketId: trackedMarket.id,
        tokenId: trackedMarket.noTokenId ?? 'token-no',
        side: 'sell',
        limitPrice: 0.72,
        quantity: 2,
        approvedAt: now.toISOString(),
        thesis: 'Leave a resting reduce-only paper exit open.'
      },
      quote: {
        quoteId: 'quote-resting-exit',
        marketId: trackedMarket.id,
        tokenId: trackedMarket.noTokenId ?? 'token-no',
        observedAt: now.toISOString(),
        bestBid: 0.61,
        bidSize: 2,
        bestAsk: 0.62,
        askSize: 2,
        midpoint: 0.615,
        source: 'runtime-store-test'
      }
    });
  }

  const store = new RuntimeStore(makeConfig(root));
  Reflect.set(store, 'refreshMarketData', async () => {});
  await store.init();

  return { root, store, trackedMarket, snapshotMarket };
}

async function cleanupHarness(harness: Harness): Promise<void> {
  const persistTimer = Reflect.get(harness.store, 'persistTimer') as NodeJS.Timeout | null;
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  await rm(harness.root, { recursive: true, force: true });
}

async function runEvaluateStrategy(store: RuntimeStore, snapshot: MarketSnapshot): Promise<void> {
  const internalState = Reflect.get(store, 'state') as RuntimeState;
  internalState.marketData = {
    ...internalState.marketData,
    syncedAt: snapshot.fetchedAt,
    stale: false,
    error: null,
    transport: snapshot.transport,
    access: snapshot.access
  };

  const evaluateStrategy = Reflect.get(store, 'evaluateStrategy') as (
    trigger: 'market-refresh',
    snapshot: MarketSnapshot
  ) => Promise<void>;
  await evaluateStrategy.call(store, 'market-refresh', snapshot);
}

test('dropped top-N refresh keeps ledger-backed positions and working orders in scope', async () => {
  const harness = await createHarness({ withWorkingOrder: true });

  try {
    const snapshot = makeSnapshot([harness.snapshotMarket]);
    await runEvaluateStrategy(harness.store, snapshot);

    const state = harness.store.getState();
    assert.deepEqual(state.markets.map((market) => market.id), [harness.snapshotMarket.id, harness.trackedMarket.id]);
    assert.equal(state.strategy.positions.length, 1);
    assert.equal(state.strategy.positions[0]?.marketQuestion, harness.trackedMarket.question);
    assert.equal(state.strategy.positions[0]?.side, 'no');
    assert.equal(state.execution.trades.length, 1);
    assert.equal(state.execution.trades[0]?.marketQuestion, harness.trackedMarket.question);
    assert.equal(state.execution.trades[0]?.side, 'no');
    assert.equal(state.execution.trades[0]?.openOrderCount, 1);
    assert.match(state.strategy.notes.join(' '), /Retained 1 ledger-backed market/);
  } finally {
    await cleanupHarness(harness);
  }
});

test('flatten fails closed with an explicit off-snapshot reason for carried positions', async () => {
  const harness = await createHarness();

  try {
    const snapshot = makeSnapshot([harness.snapshotMarket]);
    await runEvaluateStrategy(harness.store, snapshot);
    Reflect.set(harness.store, 'latestSnapshotMarketIds', new Set(snapshot.markets.map((market) => market.id)));

    const result = await harness.store.flattenOpenPositions();
    assert.equal(result.ok, true);
    assert.equal(result.submitted, 0);
    assert.equal(result.skipped, 1);
    assert.match(result.errors[0] ?? '', /outside the latest top-1 market snapshot/i);

    const state = harness.store.getState();
    assert.equal(state.strategy.positions.length, 1);
    assert.equal(state.strategy.positions[0]?.marketQuestion, harness.trackedMarket.question);
    assert.equal(state.execution.trades[0]?.status, 'open');
  } finally {
    await cleanupHarness(harness);
  }
});
