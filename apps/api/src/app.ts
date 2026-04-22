import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { updateTradingPreferenceRequestSchema } from '../../../packages/contracts/src/index.js';
import type { RuntimeStore } from './runtime-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTROL_TOKEN_COOKIE = 'phantom3-v2-control-token';

export const TRADING_PREFERENCE_ACCESS_NOTE = 'Health remains open, but runtime snapshots, paper strategy views, and the live WebSocket stream now require the control token. When `PHANTOM3_V2_REMOTE_DASHBOARD=false`, the server rejects non-loopback dashboard/API access instead of merely labeling it remote-disabled. Trading preference selection still routes through a paper-safe profile abstraction: current-v2-generic can emit new paper entries, while legacy profiles stay reference-only. The legacy early-exit live profile also keeps managed exits and session guards active for existing paper positions. `/api/control/flatten` only works on paper positions in this bootstrap, and `/api/control/live/*` stays scaffold-only until a real live adapter and startup reconciliation path are wired. Polymarket transport, if configured, is scoped to the market-data adapter only.';

export type CreateApiAppOptions = {
  logger?: boolean;
  store?: RuntimeStore;
  initStore?: boolean;
  registerStatic?: boolean;
  webRoot?: string;
  startHeartbeat?: boolean;
  startMarketRefresh?: boolean;
};

export function defaultWebRoot(): string {
  return join(__dirname, '../../web/dist');
}

function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string' || header.trim().length === 0) {
    return null;
  }

  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const cookieName = entry.slice(0, separator).trim();
    if (cookieName !== name) {
      continue;
    }

    const rawValue = entry.slice(separator + 1).trim();
    if (rawValue.length === 0) {
      return null;
    }

    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
}

export function isAuthorized(headers: Record<string, unknown>, controlToken: string): boolean {
  const bearer = typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
    ? headers.authorization.slice('Bearer '.length)
    : null;
  const headerToken = typeof headers['x-phantom3-token'] === 'string' ? headers['x-phantom3-token'] : null;
  const cookieToken = readCookie(headers.cookie, CONTROL_TOKEN_COOKIE);
  const supplied = bearer || headerToken || cookieToken;
  return typeof supplied === 'string' && supplied.length > 0 && supplied === controlToken;
}

function normalizeHost(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(`http://${value}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

function isLoopbackAddress(value: string | null | undefined): boolean {
  const normalized = normalizeAddress(value);
  return normalized === '::1' || normalized === '127.0.0.1' || Boolean(normalized?.startsWith('127.'));
}

function isLoopbackHost(value: string | null | undefined): boolean {
  const hostname = normalizeHostname(value);
  return hostname === 'localhost' || isLoopbackAddress(hostname);
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  return isLoopbackAddress(request.ip ?? request.socket.remoteAddress) && isLoopbackHost(request.headers.host);
}

function websocketOriginAllowed(request: FastifyRequest, config: AppConfig): boolean {
  const originHeader = typeof request.headers.origin === 'string' ? request.headers.origin : null;
  if (!originHeader) {
    return false;
  }

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }

  if (config.remoteDashboardEnabled) {
    const expected = new URL(config.publicBaseUrl);
    return origin.origin === expected.origin;
  }

  return isLoopbackHost(origin.host);
}

function websocketHostAllowed(request: FastifyRequest, config: AppConfig): boolean {
  const hostHeader = typeof request.headers.host === 'string' ? request.headers.host : null;
  if (!hostHeader) {
    return false;
  }

  if (config.remoteDashboardEnabled) {
    return normalizeHost(hostHeader) === new URL(config.publicBaseUrl).host.toLowerCase();
  }

  return isLoopbackHost(hostHeader) && isLoopbackRequest(request);
}

function pathWithoutQuery(url: string | undefined): string {
  if (!url) {
    return '/';
  }

  const separator = url.indexOf('?');
  return separator >= 0 ? url.slice(0, separator) : url;
}

async function requireAuthorizedAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig
) {
  if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

async function requireSafeWebsocketAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig
) {
  if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  if (!websocketHostAllowed(request, config)) {
    return reply.code(403).send({ error: 'WebSocket host rejected.' });
  }

  if (!websocketOriginAllowed(request, config)) {
    return reply.code(403).send({ error: 'WebSocket origin rejected.' });
  }
}

export function readLimit(query: unknown, fallback: number, maximum: number): number {
  if (!query || typeof query !== 'object') {
    return fallback;
  }

  const raw = (query as Record<string, unknown>).limit;
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim().length > 0
      ? Number(raw)
      : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), maximum);
}

export async function createApiApp(
  config: AppConfig,
  options: CreateApiAppOptions = {}
): Promise<{ app: FastifyInstance; store: RuntimeStore }> {
  const app = fastify({ logger: options.logger ?? true });
  const store = options.store ?? new (await import('./runtime-store.js')).RuntimeStore(config);
  const registerStatic = options.registerStatic !== false;

  if (options.initStore !== false) {
    await store.init();
  }

  app.addHook('onRequest', async (request, reply) => {
    if (config.remoteDashboardEnabled) {
      return;
    }

    if (pathWithoutQuery(request.raw.url) === '/api/health') {
      return;
    }

    if (!isLoopbackRequest(request)) {
      return reply.code(403).send({
        error: 'Remote dashboard access is disabled for this server. Use loopback access or enable PHANTOM3_V2_REMOTE_DASHBOARD.'
      });
    }
  });

  await app.register(fastifyWebsocket);

  if (registerStatic) {
    await app.register(fastifyStatic, {
      root: options.webRoot ?? defaultWebRoot(),
      prefix: '/'
    });
  }

  app.get('/api/health', async () => {
    const state = store.getState();
    return {
      ok: true,
      app: 'Phantom3 v2',
      mode: state.mode,
      markets: state.markets.length,
      marketDataStale: state.marketData.stale,
      strategyStatus: state.strategy.status,
      strategyCandidates: state.strategy.candidateCount
    };
  });

  app.get('/api/runtime', { preValidation: (request, reply) => requireAuthorizedAccess(request, reply, config) }, async () => store.getState());
  app.get('/api/runtime/strategy', { preValidation: (request, reply) => requireAuthorizedAccess(request, reply, config) }, async () => store.getStrategySummary());
  app.get('/api/runtime/execution', { preValidation: (request, reply) => requireAuthorizedAccess(request, reply, config) }, async () => store.getState().execution);

  app.get('/api/paper/strategy', { preValidation: (request, reply) => requireAuthorizedAccess(request, reply, config) }, async (request, reply) => {
    const paperStrategy = store.getPaperStrategyView(readLimit(request.query, 6, 12));
    if (!paperStrategy) {
      return reply.code(409).send({ error: 'Paper strategy data is only available while the runtime is in paper mode.' });
    }
    return paperStrategy;
  });

  app.get('/api/paper/strategy/snapshots', { preValidation: (request, reply) => requireAuthorizedAccess(request, reply, config) }, async (request, reply) => {
    const state = store.getState();
    if (state.mode !== 'paper') {
      return reply.code(409).send({ error: 'Paper strategy snapshots are only available while the runtime is in paper mode.' });
    }

    return {
      mode: 'paper',
      safeToExpose: true,
      snapshots: store.getStrategySnapshots(readLimit(request.query, 6, 12))
    };
  });

  app.get('/api/access', async () => ({
    publicBaseUrl: config.publicBaseUrl,
    remoteDashboardEnabled: config.remoteDashboardEnabled,
    controlTokenConfigured: true,
    transport: 'websocket',
    wsEndpoint: '/api/ws',
    strategySummaryEndpoint: '/api/runtime/strategy',
    executionSummaryEndpoint: '/api/runtime/execution',
    paperStrategyEndpoint: '/api/paper/strategy',
    paperStrategySnapshotsEndpoint: '/api/paper/strategy/snapshots',
    tradingPreferenceControlEndpoint: '/api/control/trading-preference',
    controlEndpoints: {
      pause: '/api/control/pause',
      resume: '/api/control/resume',
      armLive: '/api/control/live/arm',
      disarmLive: '/api/control/live/disarm',
      flatten: '/api/control/flatten',
      engageKillSwitch: '/api/control/kill-switch/engage',
      releaseKillSwitch: '/api/control/kill-switch/release'
    },
    note: TRADING_PREFERENCE_ACCESS_NOTE
  }));

  app.get('/api/ws', {
    websocket: true,
    preValidation: (request, reply) => requireSafeWebsocketAccess(request, reply, config)
  }, (socket) => {
    const unsubscribe = store.subscribe((state) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'runtime', data: state }));
      }
    });

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[] | string) => {
      let payload: unknown = null;
      try {
        const text = typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.isBuffer(raw)
              ? raw.toString('utf8')
              : Buffer.from(raw).toString('utf8');
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'ping') {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
        }
      }
    });

    socket.on('close', unsubscribe);
    socket.on('error', () => unsubscribe());
  });

  app.post('/api/control/pause', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      await store.setPaused(true);
      return { ok: true, paused: true };
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Unable to persist pause state.' });
    }
  });

  app.post('/api/control/resume', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      await store.setPaused(false);
      return { ok: true, paused: false };
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Unable to persist resume state.' });
    }
  });

  app.post('/api/control/trading-preference', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = updateTradingPreferenceRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid trading preference profile.' });
    }

    return {
      ok: true,
      tradingPreference: store.setTradingPreference(parsed.data.profile)
    };
  });

  app.post('/api/control/live/arm', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    try {
      return await store.armLive();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to arm live control plane.' });
    }
  });

  app.post('/api/control/live/disarm', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    try {
      return await store.disarmLive();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to disarm live control plane.' });
    }
  });

  app.post('/api/control/flatten', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    try {
      return await store.flattenOpenPositions();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to flatten positions.' });
    }
  });

  app.post('/api/control/kill-switch/engage', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    return store.engageKillSwitch();
  });

  app.post('/api/control/kill-switch/release', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    return store.releaseKillSwitch();
  });

  if (registerStatic) {
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler(async (request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not found' }));
  }

  const heartbeatTimer = options.startHeartbeat === false
    ? null
    : setInterval(() => store.heartbeat(), 15000);
  heartbeatTimer?.unref();

  const marketRefreshTimer = options.startMarketRefresh === false
    ? null
    : setInterval(() => {
      void store.refreshMarketData();
    }, config.marketRefreshMs);
  marketRefreshTimer?.unref();

  app.addHook('onClose', async (_instance) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (marketRefreshTimer) {
      clearInterval(marketRefreshTimer);
    }
  });

  return { app, store };
}
