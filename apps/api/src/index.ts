import 'dotenv/config';

import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readConfig } from '../../../packages/config/src/index.js';
import { RuntimeStore } from './runtime-store.js';

const config = readConfig();
const app = fastify({ logger: true });
const store = new RuntimeStore(config);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webRoot = join(__dirname, '../../web/dist');

function isAuthorized(headers: Record<string, unknown>): boolean {
  const bearer = typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
    ? headers.authorization.slice('Bearer '.length)
    : null;
  const headerToken = typeof headers['x-phantom3-token'] === 'string' ? headers['x-phantom3-token'] : null;
  const supplied = bearer || headerToken;
  return typeof supplied === 'string' && supplied.length > 0 && supplied === config.controlToken;
}

async function main(): Promise<void> {
  await store.init();

  await app.register(fastifyWebsocket);

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/'
  });

  app.get('/api/health', async () => ({ ok: true, app: 'Phantom3 v2', mode: store.getState().mode }));
  app.get('/api/runtime', async () => store.getState());
  app.get('/api/access', async () => ({
    publicBaseUrl: config.publicBaseUrl,
    remoteDashboardEnabled: config.remoteDashboardEnabled,
    controlTokenConfigured: true,
    transport: 'websocket',
    wsEndpoint: '/api/ws',
    note: 'Read endpoints are open. Control routes require a token.'
  }));

  app.get('/api/ws', { websocket: true }, (socket) => {
    const sendRuntime = () => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'runtime', data: store.getState() }));
      }
    };

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

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.setNotFoundHandler(async (request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  setInterval(() => store.heartbeat(), 15000).unref();

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Phantom3 v2 listening on ${config.publicBaseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
