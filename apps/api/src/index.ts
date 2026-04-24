import 'dotenv/config';

import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../../packages/config/src/index.js';
import { PolymarketLiveClient, PolymarketLiveGateway } from '../../../packages/live-execution/src/polymarket-client.js';
import { scanUpDownEdge } from '../../../packages/market-data/src/updown-edge.js';
import { RuntimeStore, type RuntimeStoreOptions } from './runtime-store.js';

const config = readConfig();
const app = fastify({ logger: true });
let store: RuntimeStore;
let liveSetupError: string | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webRoot = join(__dirname, '../../web/dist');


function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function walletReadiness() {
  const venue = config.liveExecution.polymarket;
  const auth = venue.auth;
  const simulation = config.runtimeMode === 'simulation';
  return {
    runtimeMode: config.runtimeMode,
    liveModeEnabled: config.liveModeEnabled,
    liveArmingEnabled: config.liveArmingEnabled,
    liveExecutionEnabled: config.liveExecution.enabled,
    venue: config.liveExecution.venue,
    clobHost: venue.host,
    chainId: venue.chainId,
    signatureType: auth.signatureType,
    funderAddressConfigured: auth.funderAddress !== null,
    funderAddress: auth.funderAddress,
    privateKeyConfigured: auth.hasPrivateKey,
    apiCredentialsConfigured: auth.hasApiCredentials,
    allowApiKeyDerivation: auth.allowApiKeyDerivation,
    needsApiKeyDerivation: auth.needsApiKeyDerivation,
    walletRequired: !simulation,
    orderPlacementDisabled: simulation,
    canAccessAuthenticatedApi: simulation ? false : auth.canAccessAuthenticatedApi,
    configCanPlaceOrders: simulation ? false : auth.canPlaceOrders,
    canPlaceOrders: simulation ? false : auth.canPlaceOrders,
    gatewayInstalled: simulation ? false : Boolean(store && store.getState().execution.live.liveAdapterReady),
    setupError: simulation ? null : liveSetupError,
    message: simulation
      ? 'Simulation mode is active. No wallet is required and this process cannot place orders.'
      : auth.canPlaceOrders
        ? 'Wallet/API config can access authenticated Polymarket APIs, but live arming still controls operator actions.'
        : 'Wallet/API config is incomplete for order placement.',
    safeToLog: true
  };
}

async function createRuntimeOptions(): Promise<RuntimeStoreOptions> {
  if (config.runtimeMode === 'simulation') {
    return {};
  }
  if (!config.liveModeEnabled || !config.liveExecution.enabled) {
    return {};
  }
  if (config.liveExecution.venue !== 'polymarket') {
    liveSetupError = `Unsupported live execution venue: ${config.liveExecution.venue}`;
    return { liveSetupError };
  }

  try {
    const client = await PolymarketLiveClient.fromConfig(config.liveExecution.polymarket);
    const gateway = new PolymarketLiveGateway(client, { postOnly: true });
    return {
      liveExchange: gateway,
      liveVenueSnapshot: () => gateway.fetchVenueStateSnapshot()
    };
  } catch (error) {
    liveSetupError = `Polymarket wallet/auth setup failed: ${describeError(error)}`;
    app.log.warn({ err: liveSetupError }, 'Live execution gateway disabled fail-closed.');
    return { liveSetupError };
  }
}

function isAuthorized(headers: Record<string, unknown>): boolean {
  const bearer = typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
    ? headers.authorization.slice('Bearer '.length)
    : null;
  const wraithHeaderToken = typeof headers['x-wraith-token'] === 'string' ? headers['x-wraith-token'] : null;
  const legacyHeaderToken = typeof headers['x-phantom3-token'] === 'string' ? headers['x-phantom3-token'] : null;
  const supplied = bearer || wraithHeaderToken || legacyHeaderToken;
  return typeof supplied === 'string' && supplied.length > 0 && supplied === config.controlToken;
}

function readLimit(query: unknown, fallback: number, maximum: number): number {
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

async function main(): Promise<void> {
  store = new RuntimeStore(config, await createRuntimeOptions());
  await store.init();

  await app.register(fastifyWebsocket);

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/'
  });

  app.get('/api/health', async () => {
    const state = store.getState();
    return {
      ok: true,
      app: 'Wraith',
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
  app.get('/api/live/wallet', async () => walletReadiness());

  app.get('/api/paper/strategy', async (request, reply) => {
    const paperStrategy = store.getPaperStrategyView(readLimit(request.query, 6, 12));
    if (!paperStrategy) {
      return reply.code(409).send({ error: 'Strategy data is only available while the runtime is in paper or simulation mode.' });
    }
    return paperStrategy;
  });

  app.get('/api/paper/strategy/snapshots', async (request, reply) => {
    const state = store.getState();
    if (state.mode !== 'paper' && state.mode !== 'simulation') {
      return reply.code(409).send({ error: 'Strategy snapshots are only available while the runtime is in paper or simulation mode.' });
    }

    return {
      mode: state.mode,
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
    upDownScanEndpoint: '/api/updown-scan',
    liveWalletEndpoint: '/api/live/wallet',
    liveControlsAvailable: config.runtimeMode !== 'simulation',
    controlEndpoints: {
      pause: '/api/control/pause',
      resume: '/api/control/resume',
      armLive: config.runtimeMode === 'simulation' ? null : '/api/control/live/arm',
      disarmLive: config.runtimeMode === 'simulation' ? null : '/api/control/live/disarm',
      flatten: '/api/control/flatten',
      engageKillSwitch: '/api/control/kill-switch/engage',
      releaseKillSwitch: '/api/control/kill-switch/release'
    },
    note: config.runtimeMode === 'simulation'
      ? 'Simulation mode is active. Read endpoints are open, strategy routes are sanitized, and no live wallet/order gateway is installed.'
      : 'Read endpoints are open. Paper strategy routes are sanitized and read-only. Control routes require a token. Live arming remains fail-closed until venue-backed startup reconciliation is clean.'
  }));

  app.get('/api/updown-scan', async (_request, reply) => {
    try {
      return await scanUpDownEdge();
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'Unable to scan Up/Down markets.' });
    }
  });

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
    if (!isAuthorized(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    store.setPaused(true);
    return { ok: true, paused: true };
  });

  app.post('/api/control/resume', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    store.setPaused(false);
    return { ok: true, paused: false };
  });

  app.post('/api/control/live/arm', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (config.runtimeMode === 'simulation') {
      return reply.code(409).send({ error: 'Simulation mode cannot be armed for live trading. No live wallet or order gateway is installed.' });
    }

    try {
      return await store.armLive();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to arm live control plane.' });
    }
  });

  app.post('/api/control/live/disarm', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (config.runtimeMode === 'simulation') {
      return reply.code(409).send({ error: 'Simulation mode has no live trading path to disarm.' });
    }

    try {
      return await store.disarmLive();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to disarm live control plane.' });
    }
  });

  app.post('/api/control/flatten', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    try {
      return await store.flattenOpenPositions();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to flatten positions.' });
    }
  });

  app.post('/api/control/kill-switch/engage', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : null;
    const reason = body && typeof body.reason === 'string' && body.reason.trim().length > 0 ? body.reason.trim() : undefined;

    try {
      return await store.engageKillSwitch(reason);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to engage the kill switch.' });
    }
  });

  app.post('/api/control/kill-switch/release', async (request, reply) => {
    if (!isAuthorized(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    try {
      return await store.releaseKillSwitch();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Unable to release the kill switch.' });
    }
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.setNotFoundHandler(async (request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  setInterval(() => store.heartbeat(), 15000).unref();
  setInterval(() => {
    void store.refreshMarketData();
  }, config.marketRefreshMs).unref();

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Wraith listening on ${config.publicBaseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
