import type { RuntimeModule, RuntimeState, WatchEntry } from '../../../packages/contracts/src/index';

export type BadgeTone = 'long' | 'warning' | 'short' | 'idle';

export type DashboardFreshness = {
  stale: boolean;
  reason: 'stream' | 'heartbeat' | null;
  ageMs: number;
  thresholdMs: number;
};

export const DASHBOARD_STALE_AFTER_MS = 45_000;

export function buildControlHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-phantom3-token': token
  };
}

export function deriveDashboardFreshness({
  now = Date.now(),
  lastRuntimeMessageAt,
  lastHeartbeatAt,
  staleAfterMs = DASHBOARD_STALE_AFTER_MS
}: {
  now?: number;
  lastRuntimeMessageAt: number | null;
  lastHeartbeatAt: string | null | undefined;
  staleAfterMs?: number;
}): DashboardFreshness {
  if (lastRuntimeMessageAt !== null && now - lastRuntimeMessageAt > staleAfterMs) {
    return {
      stale: true,
      reason: 'stream',
      ageMs: now - lastRuntimeMessageAt,
      thresholdMs: staleAfterMs
    };
  }

  const heartbeatAt = typeof lastHeartbeatAt === 'string' && lastHeartbeatAt.length > 0
    ? Date.parse(lastHeartbeatAt)
    : Number.NaN;

  if (Number.isFinite(heartbeatAt) && now - heartbeatAt > staleAfterMs) {
    return {
      stale: true,
      reason: 'heartbeat',
      ageMs: now - heartbeatAt,
      thresholdMs: staleAfterMs
    };
  }

  return {
    stale: false,
    reason: null,
    ageMs: 0,
    thresholdMs: staleAfterMs
  };
}

export function moduleBadge(module: RuntimeModule, runtime: RuntimeState | null): { label: string; tone: BadgeTone } {
  if (module.id === 'execution' && module.status === 'healthy' && runtime?.execution.live.configured && !runtime.execution.live.liveAdapterReady) {
    return { label: 'paper-only', tone: 'warning' };
  }

  return {
    label: module.status,
    tone: module.status === 'healthy'
      ? 'long'
      : module.status === 'warning'
        ? 'warning'
        : module.status === 'blocked'
          ? 'short'
          : 'idle'
  };
}

export function watchEntryBadge(entry: WatchEntry, runtime: RuntimeState | null): { label: string; tone: BadgeTone } {
  if (entry.id === 'live-control-plane' && runtime) {
    if (runtime.execution.live.killSwitchActive) {
      return { label: 'kill switch', tone: 'short' };
    }
    if (!runtime.execution.live.liveAdapterReady) {
      return runtime.execution.live.configured
        ? { label: 'scaffold', tone: 'warning' }
        : { label: 'not wired', tone: 'idle' };
    }
  }

  return {
    label: entry.status,
    tone: entry.status === 'active' ? 'long' : entry.status === 'planned' ? 'warning' : 'short'
  };
}

export function liveControlBadge(runtime: RuntimeState | null): { label: string; tone: BadgeTone } {
  if (!runtime) {
    return { label: '—', tone: 'idle' };
  }

  const live = runtime.execution.live;
  if (!live.liveAdapterReady) {
    return live.configured
      ? { label: 'scaffold only', tone: 'warning' }
      : { label: 'not wired', tone: 'idle' };
  }
  if (live.killSwitchActive) {
    return { label: 'kill switch', tone: 'short' };
  }
  if (live.armed) {
    return { label: 'armed', tone: 'short' };
  }
  if (live.configured) {
    return { label: 'ready', tone: 'long' };
  }
  return { label: 'disabled', tone: 'idle' };
}
