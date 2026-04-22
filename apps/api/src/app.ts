import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { updateTradingPreferenceRequestSchema } from '../../../packages/contracts/src/index.js';
import { RuntimeStore } from './runtime-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TRADING_PREFERENCE_ACCESS_NOTE = 'Read endpoints are open. Paper strategy routes are sanitized and read-only. Control routes require a token. Trading preference selection now routes through a paper-safe profile abstraction: current-v2-generic can emit new paper entries, while legacy profiles stay reference-only. The legacy early-exit live profile also keeps managed exits and session guards active for existing paper positions. Polymarket transport, if configured, is scoped to the market-data adapter only.';

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

export function isAuthorized(headers: Record<string, unknown>, controlToken: string): boolean {
  const bearer = typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
    ? headers.authorization.slice('Bearer '.length)
    : null;
  const headerToken = typeof headers['x-phantom3-token'] === 'string' ? headers['x-phantom3-token'] : null;
  const supplied = bearer || headerToken;
  return typeof supplied === 'string' && supplied.length > 0 && supplied === controlToken;
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
  const store = options.store ?? new RuntimeStore(config);
  const registerStatic = options.registerStatic !== false;

  if (options.initStore !== false) {
    await store.init();
  }

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

  app.get('/api/runtime', async () => store.getState());
  app.get('/api/runtime/strategy', async () => store.getStrategySummary());
  app.get('/api/runtime/execution', async () => store.getState().execution);

  app.get('/api/paper/strategy', async (request, reply) => {
    const paperStrategy = store.getPaperStrategyView(readLimit(request.query, 6, 12));
    if (!paperStrategy) {
      return reply.code(409).send({ error: 'Paper strategy data is only available while the runtime is in paper mode.' });
    }
    return paperStrategy;
  });

  app.get('/api/paper/strategy/snapshots', async (request, reply) => {
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

  app.get('/api/ws', { websocket: true }, (socket) => {
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
    store.setPaused(true);
    return { ok: true, paused: true };
  });

  app.post('/api/control/resume', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>, config.controlToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    store.setPaused(false);
    return { ok: true, paused: false };
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
