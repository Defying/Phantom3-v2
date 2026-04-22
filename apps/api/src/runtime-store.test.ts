import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { RuntimeMarket } from '../../../packages/contracts/src/index.js';
import { getOpenOrders, JsonlLedger } from '../../../packages/ledger/src/index.js';
import type { MarketSnapshot } from '../../../packages/market-data/src/index.js';
import { PaperExecutionAdapter } from '../../../packages/paper-execution/src/index.js';
import { OPERATOR_CONTROL_STATE_FILENAME, RuntimeStore } from './runtime-store.js';

function makeConfig(root: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 4317,
    remoteDashboardEnabled: false,
    publicBaseUrl: 'http://127.0.0.1:4317',
    dataDir: join(root, 'data'),
    logDir: join(root, 'logs'),
    marketRefreshMs: 30_000,
    marketLimit: 16,
    polymarketProxy: null,
    polymarketProxyUrl: null,
    polymarketOperatorEligibility: 'restricted',
    liveModeEnabled: true,
    liveArmingEnabled: false,
    liveExecution: {
      enabled: false,
      venue: 'polymarket',
      maxQuoteAgeMs: 5_000,
      maxReconcileAgeMs: 15_000,
      missingOrderGraceMs: 30_000
    },
    controlToken: '1234567890abcdef'
  };
}

function makeMarket(id: string, overrides: Partial<RuntimeMarket> = {}): RuntimeMarket {
  return {
    id,
    eventId: `${id}-event`,
    slug: id,
    eventTitle: `${id} title`,
    question: `${id} question`,
    yesLabel: 'Yes',
    noLabel: 'No',
    yesTokenId: `${id}-yes`,
    noTokenId: `${id}-no`,
    yesPrice: 0.68,
    noPrice: 0.32,
    priceSource: 'clob-midpoint-reference',
    spread: 0.02,
    volume24hr: 25_000,
    liquidity: 50_000,
    endDate: '2026-04-22T20:00:00.000Z',
    url: `https://example.com/${id}`,
    ...overrides
  };
}

function setSnapshotState(store: RuntimeStore, snapshot: MarketSnapshot): void {
  const internal = store as unknown as {
    state: {
      markets: RuntimeMarket[];
      marketData: {
        syncedAt: string | null;
        stale: boolean;
        error: string | null;
        transport: MarketSnapshot['transport'];
        access: MarketSnapshot['access'];
      };
    };
  };

  internal.state.markets = snapshot.markets;
  internal.state.marketData = {
    ...internal.state.marketData,
    syncedAt: snapshot.fetchedAt,
    stale: false,
    error: null,
    transport: snapshot.transport,
    access: snapshot.access
  };
}

async function seedFilledEntry(config: AppConfig, market: RuntimeMarket, observedAt: string): Promise<void> {
  const clock = () => new Date(observedAt);
  const ledger = new JsonlLedger({ directory: config.dataDir, clock });
  await ledger.init();
  const execution = new PaperExecutionAdapter(ledger, { clock, allowPartialFills: false });

  await execution.submitApprovedIntent({
    intent: {
      sessionId: 'runtime-store-test',
      intentId: `seed-entry-${market.id}`,
      strategyId: 'runtime-store-test',
      marketId: market.id,
      tokenId: market.yesTokenId ?? `${market.id}-yes`,
      side: 'buy',
      limitPrice: 0.56,
      quantity: 5,
      approvedAt: observedAt,
      thesis: 'Seed a paper position so pause can still refresh reduce-only exit state.',
      metadata: {
        kind: 'entry',
        question: market.question,
        generatedAt: observedAt,
        signalScore: 0.9,
        desiredSizeUsd: 2.8,
        exit: {
          takeProfitPrice: 0.74,
          stopLossPrice: 0.5,
          latestExitAt: '2026-04-22T18:00:00.000Z',
          invalidateIfSpreadAbove: 0.05,
          invalidateIfComplementDriftAbove: 0.08,
          invalidateIfHoursToExpiryBelow: 6
        },
        side: 'yes'
      }
    },
    quote: {
      quoteId: `seed-quote-${market.id}`,
      marketId: market.id,
      tokenId: market.yesTokenId ?? `${market.id}-yes`,
      observedAt,
      bestBid: 0.55,
      bidSize: 5,
      bestAsk: 0.56,
      askSize: 5,
      midpoint: 0.555,
      source: 'runtime-store-test'
    }
  });
}

test('pause blocks new entry evaluation while still refreshing reduce-only paper exit state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-runtime-store-pause-'));

  try {
    const config = makeConfig(root);
    const store = new RuntimeStore(config);
    await store.init();

    const exitMarket = makeMarket('exit-market', {
      question: 'Will ETH finish green?',
      yesPrice: 0.49,
      noPrice: 0.51
    });
    const entryMarket = makeMarket('entry-market', {
      question: 'Will BTC close higher?'
    });

    await seedFilledEntry(config, exitMarket, '2026-04-21T15:00:00.000Z');

    const transport = (store.getState().marketData.transport as MarketSnapshot['transport']);
    const access = {
      ...(store.getState().marketData.access as MarketSnapshot['access']),
      operatorEligibility: 'confirmed-eligible',
      note: 'Test-only market snapshot access.'
    } as MarketSnapshot['access'];
    const snapshot: MarketSnapshot = {
      fetchedAt: '2026-04-21T16:00:00.000Z',
      markets: [exitMarket, entryMarket],
      transport,
      access
    };

    setSnapshotState(store, snapshot);
    await store.setPaused(true);

    const ledger = new JsonlLedger({ directory: config.dataDir });
    await ledger.init();
    const before = await ledger.readProjection();
    assert.equal(before.intents.size, 1);
    assert.equal(getOpenOrders(before).length, 0);

    const internal = store as unknown as {
      evaluateStrategy: (trigger: 'market-refresh', snapshot: MarketSnapshot) => Promise<void>;
    };
    await internal.evaluateStrategy('market-refresh', snapshot);

    const after = await ledger.readProjection();
    assert.equal(after.intents.size, 1, 'pause should prevent any new entry intent from being approved');
    assert.equal(getOpenOrders(after).length, 0, 'pause should prevent new paper entry orders from opening');

    const summary = store.getStrategySummary();
    assert.equal(summary.status, 'paused');
    assert.equal(summary.riskDecisions.some((decision) => decision.kind === 'entry'), false, 'pause should stop new entry evaluation');
    assert.equal(summary.riskDecisions.some((decision) => decision.kind === 'exit'), true, 'pause should still allow reduce-only exit safety evaluation');

    const position = summary.positions.find((candidate) => candidate.marketId === exitMarket.id);
    assert(position?.exit, 'expected seeded position to expose an exit state while paused');
    assert.equal(position.exit.status, 'triggered');
    assert(position.exit.triggers.includes('stop-loss-hit'));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rm(root, { recursive: true, force: true });
  }
});

test('operator control state is persisted before success returns and unreadable state fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-runtime-store-control-'));

  try {
    const config = makeConfig(root);
    const store = new RuntimeStore(config);
    await store.init();

    await store.setPaused(true);
    const engaged = await store.engageKillSwitch('operator trip');
    assert.deepEqual(engaged, { ok: true, active: true, changed: true });

    const controlStatePath = join(config.dataDir, OPERATOR_CONTROL_STATE_FILENAME);
    const persisted = JSON.parse(await readFile(controlStatePath, 'utf8')) as {
      paused: boolean;
      live: {
        killSwitchActive: boolean;
        killSwitchReason: string | null;
        lastOperatorAction: string | null;
      };
    };
    assert.equal(persisted.paused, true);
    assert.equal(persisted.live.killSwitchActive, true);
    assert.equal(persisted.live.killSwitchReason, 'operator trip');
    assert.equal(persisted.live.lastOperatorAction, 'engage-kill-switch');

    const runtimeStatePath = join(config.dataDir, 'runtime-state.json');
    const runtimeState = JSON.parse(await readFile(runtimeStatePath, 'utf8')) as {
      paused?: boolean;
      execution?: { live?: Record<string, unknown> };
    };
    runtimeState.paused = false;
    runtimeState.execution = {
      ...(runtimeState.execution ?? {}),
      live: {
        ...(runtimeState.execution?.live ?? {}),
        killSwitchActive: false,
        killSwitchReason: null,
        lastOperatorAction: null,
        lastOperatorActionAt: null
      }
    };
    await writeFile(runtimeStatePath, `${JSON.stringify(runtimeState, null, 2)}\n`, 'utf8');

    const restarted = new RuntimeStore(config);
    await restarted.init();
    const rehydrated = restarted.getState();
    assert.equal(rehydrated.paused, true, 'authoritative control state should win over stale runtime-state.json');
    assert.equal(rehydrated.execution.live.killSwitchActive, true);
    assert.equal(rehydrated.execution.live.killSwitchReason, 'operator trip');

    await writeFile(controlStatePath, '{this-is-not-json\n', 'utf8');

    const failClosed = new RuntimeStore(config);
    await failClosed.init();
    const failClosedState = failClosed.getState();
    assert.equal(failClosedState.paused, true);
    assert.equal(failClosedState.execution.live.killSwitchActive, true);
    assert.equal(failClosedState.execution.live.lastOperatorAction, 'control-state-unreadable');
    assert.match(failClosedState.execution.live.killSwitchReason ?? '', /unreadable/i);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rm(root, { recursive: true, force: true });
  }
});
