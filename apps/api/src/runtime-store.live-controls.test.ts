import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { RuntimeMarket } from '../../../packages/contracts/src/index.js';
import type { MarketSnapshot } from '../../../packages/market-data/src/index.js';
import type {
  LiveExchangeGateway,
  LiveSubmitOrderRequest,
  LiveVenueStateSnapshot
} from '../../../packages/live-execution/src/index.js';
import { createPaperQuote } from './strategy-runtime.js';
import { RuntimeStore } from './runtime-store.js';

const market: RuntimeMarket = {
  id: 'market-1',
  eventId: 'event-1',
  slug: 'test-market',
  eventTitle: 'Test Event',
  question: 'Will the test market settle yes?',
  yesLabel: 'Yes',
  noLabel: 'No',
  yesTokenId: 'token-yes',
  noTokenId: 'token-no',
  yesPrice: 0.44,
  noPrice: 0.56,
  spread: 0.04,
  volume24hr: 1000,
  liquidity: 5000,
  endDate: null,
  url: 'https://example.com/markets/test-market'
};

function nowIso(): string {
  return new Date().toISOString();
}

type ConfigOverrides = Omit<Partial<AppConfig>, 'liveExecution'> & {
  liveExecution?: Partial<AppConfig['liveExecution']> & {
    polymarket?: Partial<AppConfig['liveExecution']['polymarket']> & {
      auth?: Partial<AppConfig['liveExecution']['polymarket']['auth']>;
    };
  };
};

function makeConfig(dir: string, overrides: ConfigOverrides = {}): AppConfig {
  const defaultLiveExecution: AppConfig['liveExecution'] = {
    enabled: false,
    venue: 'polymarket',
    maxQuoteAgeMs: 60_000,
    maxReconcileAgeMs: 60_000,
    missingOrderGraceMs: 30_000,
    polymarket: {
      host: 'https://clob.polymarket.com',
      chainId: 137,
      useServerTime: true,
      auth: {
        signatureType: 0,
        funderAddress: null,
        privateKey: null,
        allowApiKeyDerivation: false,
        apiCredentials: null,
        hasPrivateKey: false,
        hasApiCredentials: false,
        needsApiKeyDerivation: false,
        canAccessAuthenticatedApi: false,
        canPlaceOrders: false
      }
    }
  };

  const liveExecutionOverrides = overrides.liveExecution;
  const liveExecution: AppConfig['liveExecution'] = {
    ...defaultLiveExecution,
    ...(liveExecutionOverrides ?? {}),
    polymarket: {
      ...defaultLiveExecution.polymarket,
      ...(liveExecutionOverrides?.polymarket ?? {}),
      auth: {
        ...defaultLiveExecution.polymarket.auth,
        ...(liveExecutionOverrides?.polymarket?.auth ?? {})
      }
    }
  };

  const { liveExecution: _ignoredLiveExecution, ...restOverrides } = overrides;

  return {
    host: '127.0.0.1',
    port: 4317,
    remoteDashboardEnabled: false,
    publicBaseUrl: 'http://127.0.0.1:4317',
    dataDir: dir,
    logDir: join(dir, 'logs'),
    marketRefreshMs: 30_000,
    marketLimit: 4,
    liveModeEnabled: true,
    liveArmingEnabled: true,
    liveExecution,
    controlToken: '1234567890abcdef',
    ...restOverrides
  };
}

function createMarketFetcher(timestamp: string) {
  return async (): Promise<MarketSnapshot> => ({
    fetchedAt: timestamp,
    markets: [market]
  });
}

function createVenueSnapshot(timestamp: string, positions: LiveVenueStateSnapshot['positions'] = []): LiveVenueStateSnapshot {
  return {
    observedAt: timestamp,
    orders: [],
    fills: [],
    positions
  };
}

function createExchange(requests: LiveSubmitOrderRequest[]): LiveExchangeGateway {
  return {
    async submitOrder(request) {
      requests.push(request);
      const observedAt = nowIso();
      const venueOrderId = `venue-${requests.length}`;

      if (request.intent.side === 'buy') {
        return {
          transportStatus: 'acknowledged',
          order: {
            observedAt,
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
            acknowledgedAt: observedAt,
            updatedAt: observedAt
          },
          fills: [
            {
              venueFillId: `fill-${requests.length}`,
              venueOrderId,
              clientOrderId: request.clientOrderId,
              marketId: request.intent.marketId,
              tokenId: request.intent.tokenId,
              side: request.intent.side,
              price: request.intent.limitPrice,
              quantity: request.intent.quantity,
              fee: 0,
              liquidityRole: 'taker',
              occurredAt: observedAt
            }
          ]
        };
      }

      return {
        transportStatus: 'acknowledged',
        order: {
          observedAt,
          venueOrderId,
          clientOrderId: request.clientOrderId,
          marketId: request.intent.marketId,
          tokenId: request.intent.tokenId,
          side: request.intent.side,
          limitPrice: request.intent.limitPrice,
          requestedQuantity: request.intent.quantity,
          filledQuantity: 0,
          remainingQuantity: request.intent.quantity,
          status: 'open',
          acknowledgedAt: observedAt,
          updatedAt: observedAt
        },
        fills: []
      };
    }
  };
}

async function createStore(args: {
  config: AppConfig;
  exchange?: LiveExchangeGateway;
  liveVenueSnapshot?: () => Promise<LiveVenueStateSnapshot>;
  liveSetupError?: string;
}): Promise<RuntimeStore> {
  const store = new RuntimeStore(args.config, {
    liveExchange: args.exchange,
    liveVenueSnapshot: args.liveVenueSnapshot,
    liveSetupError: args.liveSetupError,
    marketFetcher: createMarketFetcher(nowIso())
  });
  await store.init();
  return store;
}

async function flushStore(store: RuntimeStore | null): Promise<void> {
  if (!store) {
    return;
  }
  const internal = store as any;
  if (internal.persistTimer) {
    clearTimeout(internal.persistTimer);
    internal.persistTimer = null;
  }
  await internal.persist();
}

test('live arming stays fail-closed while the adapter path is still scaffold-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wraith-live-runtime-'));
  let store: RuntimeStore | null = null;
  try {
    store = await createStore({
      config: makeConfig(dir, {
        liveExecution: {
          enabled: false,
          venue: 'polymarket',
          maxQuoteAgeMs: 60_000,
          maxReconcileAgeMs: 60_000,
          missingOrderGraceMs: 30_000
        }
      })
    });

    if (!store) {
      throw new Error('expected store to initialize');
    }
    const liveStore = store;
    const live = liveStore.getState().execution.live;
    assert.equal(live.status, 'scaffold');
    assert.equal(live.liveAdapterReady, false);
    assert.equal(live.canArm, false);
    await assert.rejects(() => liveStore.armLive(), /not ready|disabled|not installed/i);
  } finally {
    await flushStore(store);
    await rm(dir, { recursive: true, force: true });
  }
});


test('live arming reports wallet setup errors when the gateway fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wraith-live-runtime-'));
  let store: RuntimeStore | null = null;
  try {
    store = await createStore({
      config: makeConfig(dir, {
        liveExecution: {
          enabled: true,
          venue: 'polymarket',
          maxQuoteAgeMs: 60_000,
          maxReconcileAgeMs: 60_000,
          missingOrderGraceMs: 30_000
        }
      }),
      liveSetupError: 'Polymarket wallet/auth setup failed: missing private key'
    });

    const liveStore = store;
    const live = liveStore.getState().execution.live;
    assert.equal(live.status, 'scaffold');
    assert.equal(live.liveAdapterReady, false);
    assert.match(live.blockingReason ?? '', /wallet\/auth setup failed/i);
    await assert.rejects(() => liveStore.armLive(), /wallet\/auth setup failed/i);
  } finally {
    await flushStore(store);
    await rm(dir, { recursive: true, force: true });
  }
});

test('kill switch state stays durable through a clean live adapter restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wraith-live-runtime-'));
  let store: RuntimeStore | null = null;
  let restarted: RuntimeStore | null = null;
  try {
    const config = makeConfig(dir, {
      liveExecution: {
        enabled: true,
        venue: 'polymarket',
        maxQuoteAgeMs: 60_000,
        maxReconcileAgeMs: 60_000,
        missingOrderGraceMs: 30_000
      }
    });
    const requests: LiveSubmitOrderRequest[] = [];
    const exchange = createExchange(requests);

    store = await createStore({
      config,
      exchange,
      liveVenueSnapshot: async () => createVenueSnapshot(nowIso())
    });

    if (!store) {
      throw new Error('expected store to initialize');
    }
    const liveStore = store;
    assert.equal(liveStore.getState().execution.live.status, 'adapter-ready');
    await liveStore.armLive();
    await liveStore.engageKillSwitch('manual-trip');
    const tripped = liveStore.getState().execution.live;
    assert.equal(tripped.killSwitchActive, true);
    assert.equal(tripped.armed, false);

    restarted = new RuntimeStore(config, {
      liveExchange: exchange,
      liveVenueSnapshot: async () => createVenueSnapshot(nowIso()),
      marketFetcher: createMarketFetcher(nowIso())
    });
    await restarted.init();

    const restartedLive = restarted.getState().execution.live;
    assert.equal(restartedLive.killSwitchActive, true);
    assert.equal(restartedLive.canArm, false);

    await restarted.releaseKillSwitch();
    assert.equal(restarted.getState().execution.live.killSwitchActive, false);
  } finally {
    await flushStore(restarted);
    await flushStore(store);
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup reconciliation latches the kill switch when venue inventory disagrees with the ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wraith-live-runtime-'));
  let seededStore: RuntimeStore | null = null;
  let restarted: RuntimeStore | null = null;
  try {
    const config = makeConfig(dir, {
      liveExecution: {
        enabled: true,
        venue: 'polymarket',
        maxQuoteAgeMs: 60_000,
        maxReconcileAgeMs: 60_000,
        missingOrderGraceMs: 30_000
      }
    });
    const requests: LiveSubmitOrderRequest[] = [];
    const exchange = createExchange(requests);

    seededStore = await createStore({
      config,
      exchange,
      liveVenueSnapshot: async () => createVenueSnapshot(nowIso())
    });

    const seededInternal = seededStore as any;
    const quote = createPaperQuote(market, 'yes', nowIso());
    assert.ok(quote, 'expected a usable quote for the seeded test market');

    await seededInternal.liveExecution.submitApprovedIntent({
      intent: {
        sessionId: 'seed-live-position',
        intentId: 'seed-intent',
        strategyId: 'seed-strategy',
        marketId: market.id,
        tokenId: market.yesTokenId ?? 'token-yes',
        side: 'buy',
        limitPrice: market.yesPrice ?? 0.44,
        quantity: 10,
        approvedAt: nowIso(),
        thesis: 'Seed a reconciled live position for startup recovery tests.'
      },
      quote
    });

    restarted = new RuntimeStore(config, {
      liveExchange: exchange,
      liveVenueSnapshot: async () => createVenueSnapshot(nowIso()),
      marketFetcher: createMarketFetcher(nowIso())
    });
    await restarted.init();

    if (!restarted) {
      throw new Error('expected restarted store to initialize');
    }
    const restartedStore = restarted;
    const live = restartedStore.getState().execution.live;
    assert.equal(live.status, 'blocked-by-reconcile');
    assert.equal(live.killSwitchActive, true);
    assert.equal(live.canArm, false);
    assert.match(live.blockingReason ?? '', /missing from the venue position snapshot/i);
    await assert.rejects(() => restartedStore.armLive(), /missing from the venue position snapshot|not ready/i);
  } finally {
    await flushStore(restarted);
    await flushStore(seededStore);
    await rm(dir, { recursive: true, force: true });
  }
});

test('live flatten stays reduce-only and kill-switch release fails closed with open live inventory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wraith-live-runtime-'));
  let store: RuntimeStore | null = null;
  try {
    const config = makeConfig(dir, {
      liveExecution: {
        enabled: true,
        venue: 'polymarket',
        maxQuoteAgeMs: 60_000,
        maxReconcileAgeMs: 60_000,
        missingOrderGraceMs: 30_000
      }
    });
    const requests: LiveSubmitOrderRequest[] = [];
    const exchange = createExchange(requests);

    store = await createStore({
      config,
      exchange,
      liveVenueSnapshot: async () => createVenueSnapshot(nowIso())
    });

    const internal = store as any;
    const quote = createPaperQuote(market, 'yes', nowIso());
    assert.ok(quote, 'expected a usable quote for the seeded test market');

    await internal.liveExecution.submitApprovedIntent({
      intent: {
        sessionId: 'seed-live-position',
        intentId: 'seed-intent',
        strategyId: 'seed-strategy',
        marketId: market.id,
        tokenId: market.yesTokenId ?? 'token-yes',
        side: 'buy',
        limitPrice: market.yesPrice ?? 0.44,
        quantity: 10,
        approvedAt: nowIso(),
        thesis: 'Seed a reconciled live position for control-plane tests.'
      },
      quote
    });
    await internal.refreshExecutionState();

    if (!store) {
      throw new Error('expected store to initialize');
    }
    const liveStore = store;
    const live = liveStore.getState().execution.live;
    assert.equal(live.flattenPath, 'live');

    await liveStore.engageKillSwitch('inventory-check');
    await assert.rejects(() => liveStore.releaseKillSwitch(), /live inventory remains open|needs reconciliation/i);

    const flatten = await liveStore.flattenOpenPositions();
    assert.equal(flatten.submitted, 1);
    assert.equal(requests.at(-1)?.intent.side, 'sell');
    assert.equal(requests.at(-1)?.intent.reduceOnly, true);
  } finally {
    await flushStore(store);
    await rm(dir, { recursive: true, force: true });
  }
});
