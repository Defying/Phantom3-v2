import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { createApiApp } from './app.js';
import type { RuntimeStore } from './runtime-store.js';

const CONTROL_TOKEN = 'control-token-123456';
const CONTROL_COOKIE = `phantom3-v2-control-token=${encodeURIComponent(CONTROL_TOKEN)}`;

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 4317,
    remoteDashboardEnabled: false,
    publicBaseUrl: 'http://127.0.0.1:4317',
    dataDir: './data',
    logDir: './logs',
    marketRefreshMs: 30_000,
    marketLimit: 16,
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
    controlToken: CONTROL_TOKEN,
    ...overrides
  };
}

function createStore(): RuntimeStore {
  const state = {
    mode: 'paper',
    markets: [],
    marketData: { stale: false },
    strategy: {
      status: 'idle',
      candidateCount: 0,
      positions: [],
      intents: [],
      riskDecisions: []
    },
    execution: {},
    paused: false,
    publicBaseUrl: 'http://127.0.0.1:4317',
    remoteDashboardEnabled: false,
    tradingPreference: {
      selected: null,
      available: []
    },
    events: [],
    modules: [],
    watchlist: []
  } as any;

  return {
    async init() {
      return undefined;
    },
    getState() {
      return state;
    },
    getStrategySummary() {
      return state.strategy;
    },
    getPaperStrategyView() {
      return {
        mode: 'paper',
        safeToExpose: true,
        summary: state.strategy,
        latestSnapshot: null,
        snapshots: []
      };
    },
    getStrategySnapshots() {
      return [];
    },
    subscribe() {
      return () => undefined;
    },
    setPaused() {
      return undefined;
    },
    setTradingPreference() {
      return state.tradingPreference.selected;
    },
    async armLive() {
      return { ok: true };
    },
    async disarmLive() {
      return { ok: true };
    },
    async flattenOpenPositions() {
      return { ok: true };
    },
    engageKillSwitch() {
      return { ok: true };
    },
    releaseKillSwitch() {
      return { ok: true };
    },
    heartbeat() {
      return undefined;
    },
    async refreshMarketData() {
      return undefined;
    }
  } as unknown as RuntimeStore;
}

test('remoteDashboardEnabled=false blocks non-loopback runtime access even with a valid token', async (t) => {
  const { app } = await createApiApp(makeConfig(), {
    logger: false,
    store: createStore(),
    initStore: false,
    registerStatic: false,
    startHeartbeat: false,
    startMarketRefresh: false
  });
  t.after(async () => app.close());

  const remoteResponse = await app.inject({
    method: 'GET',
    url: '/api/runtime',
    remoteAddress: '203.0.113.9',
    headers: {
      host: '127.0.0.1:4317',
      'x-phantom3-token': CONTROL_TOKEN
    }
  });

  assert.equal(remoteResponse.statusCode, 403);
  assert.match(remoteResponse.body, /Remote dashboard access is disabled/i);

  const localResponse = await app.inject({
    method: 'GET',
    url: '/api/runtime',
    remoteAddress: '127.0.0.1',
    headers: {
      host: '127.0.0.1:4317',
      'x-phantom3-token': CONTROL_TOKEN
    }
  });

  assert.equal(localResponse.statusCode, 200);
});

test('runtime reads require auth but accept the shared control-token cookie', async (t) => {
  const { app } = await createApiApp(makeConfig({ remoteDashboardEnabled: true }), {
    logger: false,
    store: createStore(),
    initStore: false,
    registerStatic: false,
    startHeartbeat: false,
    startMarketRefresh: false
  });
  t.after(async () => app.close());

  const unauthorized = await app.inject({
    method: 'GET',
    url: '/api/runtime'
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: 'GET',
    url: '/api/runtime',
    headers: {
      cookie: CONTROL_COOKIE
    }
  });
  assert.equal(authorized.statusCode, 200);
});

test('websocket handshake rejects missing auth before upgrading', async (t) => {
  const { app } = await createApiApp(makeConfig({
    remoteDashboardEnabled: true,
    publicBaseUrl: 'https://dashboard.example'
  }), {
    logger: false,
    store: createStore(),
    initStore: false,
    registerStatic: false,
    startHeartbeat: false,
    startMarketRefresh: false
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/api/ws',
    headers: {
      host: 'dashboard.example',
      origin: 'https://dashboard.example'
    }
  });

  assert.equal(response.statusCode, 401);
});

test('websocket handshake enforces host/origin guardrails and allows same-origin authenticated access', async (t) => {
  const { app } = await createApiApp(makeConfig({
    remoteDashboardEnabled: true,
    publicBaseUrl: 'https://dashboard.example'
  }), {
    logger: false,
    store: createStore(),
    initStore: false,
    registerStatic: false,
    startHeartbeat: false,
    startMarketRefresh: false
  });
  t.after(async () => app.close());

  const rejected = await app.inject({
    method: 'GET',
    url: '/api/ws',
    headers: {
      host: 'dashboard.example',
      origin: 'https://evil.example',
      cookie: CONTROL_COOKIE
    }
  });

  assert.equal(rejected.statusCode, 403);

  const accepted = await app.inject({
    method: 'GET',
    url: '/api/ws',
    headers: {
      host: 'dashboard.example',
      origin: 'https://dashboard.example',
      cookie: CONTROL_COOKIE
    }
  });

  assert.equal(accepted.statusCode, 404);
});
