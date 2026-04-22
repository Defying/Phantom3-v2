import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeModule, RuntimeState, WatchEntry } from '../../../packages/contracts/src/index';
import {
  buildControlHeaders,
  deriveDashboardFreshness,
  liveControlBadge,
  moduleBadge,
  watchEntryBadge
} from './dashboard-helpers';

test('buildControlHeaders sends both bearer and legacy token headers', () => {
  assert.deepEqual(buildControlHeaders('secret-token'), {
    authorization: 'Bearer secret-token',
    'x-phantom3-token': 'secret-token'
  });
});

test('deriveDashboardFreshness marks a stalled runtime stream stale', () => {
  const freshness = deriveDashboardFreshness({
    now: 100_000,
    lastRuntimeMessageAt: 40_000,
    lastHeartbeatAt: new Date(90_000).toISOString()
  });

  assert.equal(freshness.stale, true);
  assert.equal(freshness.reason, 'stream');
});

test('deriveDashboardFreshness marks an old runtime heartbeat stale even after a recent fetch', () => {
  const freshness = deriveDashboardFreshness({
    now: 100_000,
    lastRuntimeMessageAt: 90_000,
    lastHeartbeatAt: new Date(40_000).toISOString()
  });

  assert.equal(freshness.stale, true);
  assert.equal(freshness.reason, 'heartbeat');
});

test('execution module badge stays paper-only when no live adapter is ready', () => {
  const runtime = {
    execution: {
      live: {
        configured: true,
        liveAdapterReady: false
      }
    }
  } as RuntimeState;
  const module = {
    id: 'execution',
    name: 'Execution Gateway',
    status: 'healthy',
    summary: 'Paper execution remains the only writer.'
  } satisfies RuntimeModule;

  assert.deepEqual(moduleBadge(module, runtime), { label: 'paper-only', tone: 'warning' });
  assert.deepEqual(moduleBadge({ ...module, status: 'blocked' }, runtime), { label: 'blocked', tone: 'short' });
});

test('live control watchlist badge reports scaffold-only truth without an adapter', () => {
  const runtime = {
    execution: {
      live: {
        configured: true,
        liveAdapterReady: false,
        armed: false,
        killSwitchActive: false
      }
    }
  } as RuntimeState;
  const entry = {
    id: 'live-control-plane',
    label: 'Live control plane',
    status: 'active',
    note: 'Configured but scaffold-only.'
  } satisfies WatchEntry;

  assert.deepEqual(watchEntryBadge(entry, runtime), { label: 'scaffold', tone: 'warning' });
  assert.deepEqual(liveControlBadge(runtime), { label: 'scaffold only', tone: 'warning' });
});
