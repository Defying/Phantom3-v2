import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { RuntimeStore } from './runtime-store.js';

type ConfigOverrides = Partial<Omit<AppConfig, 'liveExecution'>> & {
  liveExecution?: Partial<AppConfig['liveExecution']>;
};

function makeConfig(root: string, overrides: ConfigOverrides = {}): AppConfig {
  const base: AppConfig = {
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
    polymarketOperatorEligibility: 'unknown',
    liveModeEnabled: true,
    liveArmingEnabled: true,
    liveExecution: {
      enabled: false,
      venue: 'polymarket',
      maxQuoteAgeMs: 5_000,
      maxReconcileAgeMs: 15_000,
      missingOrderGraceMs: 30_000
    },
    controlToken: '1234567890abcdef'
  };

  return {
    ...base,
    ...overrides,
    liveExecution: {
      ...base.liveExecution,
      ...overrides.liveExecution
    }
  };
}

test('runtime stays scaffold-only and arming rejects while no live adapter is installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-runtime-live-controls-'));

  try {
    const config = makeConfig(root);
    const store = new RuntimeStore(config);
    await store.init();

    const live = store.getState().execution.live;
    const liveControlWatch = store.getState().watchlist.find((entry) => entry.id === 'live-control-plane');

    assert.equal(live.configured, true);
    assert.equal(live.armable, true);
    assert.equal(live.armed, false);
    assert.equal(live.liveAdapterReady, false);
    assert.equal(live.flattenSupported, false);
    assert.match(live.summary, /scaffold-only/i);
    assert.equal(liveControlWatch?.note, live.summary);

    await assert.rejects(
      () => store.armLive(),
      /no live adapter or startup reconciliation path is installed/i
    );

    assert.equal(store.getState().execution.live.armed, false);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rm(root, { recursive: true, force: true });
  }
});

test('reboot drops any persisted armed flag back to fail-closed false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-runtime-live-controls-'));

  try {
    const config = makeConfig(root);
    const firstBoot = new RuntimeStore(config);
    await firstBoot.init();

    const persistedState = structuredClone(firstBoot.getState()) as Record<string, any>;
    persistedState.execution.live.armed = true;
    persistedState.execution.live.lastOperatorAction = 'arm-live';
    persistedState.execution.live.lastOperatorActionAt = '2026-04-22T05:00:00.000Z';

    await writeFile(
      join(config.dataDir, 'runtime-state.json'),
      `${JSON.stringify({ ...persistedState, strategySnapshots: [] }, null, 2)}\n`,
      'utf8'
    );

    const restarted = new RuntimeStore(config);
    await restarted.init();

    const live = restarted.getState().execution.live;
    assert.equal(live.armed, false);
    assert.match(live.summary, /scaffold-only/i);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rm(root, { recursive: true, force: true });
  }
});

test('kill-switch latch survives reboot and still blocks arming until manually released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-runtime-live-controls-'));

  try {
    const config = makeConfig(root);
    const firstBoot = new RuntimeStore(config);
    await firstBoot.init();

    await firstBoot.engageKillSwitch('manual-trip');
    assert.equal(firstBoot.getState().execution.live.killSwitchActive, true);

    const restarted = new RuntimeStore(config);
    await restarted.init();

    const live = restarted.getState().execution.live;
    assert.equal(live.armed, false);
    assert.equal(live.killSwitchActive, true);
    assert.equal(live.killSwitchReason, 'manual-trip');
    assert.match(live.summary, /kill switch is active/i);

    await assert.rejects(() => restarted.armLive(), /kill switch is active/i);

    await restarted.releaseKillSwitch();
    assert.equal(restarted.getState().execution.live.killSwitchActive, false);
    await assert.rejects(
      () => restarted.armLive(),
      /no live adapter or startup reconciliation path is installed/i
    );
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rm(root, { recursive: true, force: true });
  }
});
