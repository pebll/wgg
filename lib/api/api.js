import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerAuth } from '../auth/session.js';
import logger from '../services/logger.js';
import { getFetchStatus } from '../services/status/fetchStatus.js';
import {
  dismissListing,
  getDetailCounts,
  getLlmCounts,
  HIDE_REASONS,
  queryListings,
  restoreListing,
} from '../services/listings/listingsStorage.js';
import { queryStats } from '../services/listings/listingsStats.js';
import { registerQueryRoutes } from './queryRoutes.js';
import { registerSettingsRoutes } from './settingsRoutes.js';

export const DEFAULT_UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');

const MIN_SECRET_LENGTH = 32;
const DEFAULT_DETAIL_MAX_AGE_DAYS = 7;
const DEFAULT_BADGE_THRESHOLD = 0.3;

const idParams = {
  type: 'object',
  properties: { id: { type: 'integer', minimum: 1 } },
  required: ['id'],
};

const dismissBody = {
  type: ['object', 'null'],
  properties: { reason: { type: 'string', enum: Object.keys(HIDE_REASONS) } },
  additionalProperties: false,
};

function assertAuthOptions(auth) {
  if (!Array.isArray(auth?.users) || auth.users.length === 0) {
    throw new Error('createApp needs auth.users (config/users.yaml).');
  }
  if (typeof auth.secret !== 'string' || auth.secret === '') {
    throw new Error('createApp needs auth.secret (SESSION_SECRET).');
  }
  if (auth.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`auth.secret (SESSION_SECRET) must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
}

function isApiPath(url) {
  const pathname = url.split('?')[0];
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Builds (without listening) the fastify app: JSON API plus the built single-page UI.
 *
 * @param {object} options see the option list below; `auth` is required.
 */
export async function createApp(options = {}) {
  const {
    auth,
    trustProxy = 'loopback',
    uiDir = DEFAULT_UI_DIR,
    coordinator,
    details = {},
    llm = {},
    directory,
    pipeline,
    geocoder,
    mailer,
    maxQueriesPerUser = 1,
  } = options;
  assertAuthOptions(auth);

  const app = Fastify({ logger: false, trustProxy });
  await registerAuth(app, {
    ...auth,
    targetNameOf: directory ? (userId) => directory.settings(userId).scoring.target.name : undefined,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: error.message });
    }
    const status = error.statusCode ?? error.status;
    if (status && status < 500) {
      return reply.code(status).send({ error: error.message });
    }
    logger.error(`${request.method} ${request.url} failed: ${error.stack ?? error.message}`);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  const reevaluate = (userId, all) => {
    try {
      Promise.resolve(pipeline?.reevaluate({ userId, all })).catch((error) => {
        logger.error(`Re-evaluating the listings of ${userId} failed: ${error.message}`);
      });
    } catch (error) {
      logger.error(`Re-evaluating the listings of ${userId} failed: ${error.message}`);
    }
  };
  const kickLlm = () => {
    try {
      pipeline?.kickLlm?.();
    } catch (error) {
      logger.error(`Waking the AI queue failed: ${error.message}`);
    }
  };

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/status', async (request) => {
    const userId = request.user.username;
    const workerState = details.worker?.state() ?? { running: false, nextAt: null };
    return {
      ...getFetchStatus(),
      manualFetch: coordinator?.manualFetchState?.() ?? null,
      details: {
        ...getDetailCounts({ userId, maxAgeDays: details.maxAgeDays ?? DEFAULT_DETAIL_MAX_AGE_DAYS }),
        running: workerState.running,
        nextAt: workerState.nextAt,
      },
      llm: {
        ...getLlmCounts(userId, directory?.context(userId).llmHash),
        badgeThreshold: llm.badgeThreshold ?? DEFAULT_BADGE_THRESHOLD,
      },
    };
  });

  app.get('/api/listings', async (request) => queryListings(request.user.username, request.query));
  app.get('/api/stats', async (request) => queryStats(request.user.username, request.query));

  app.post('/api/fetch', async (request, reply) => {
    if (!coordinator) {
      return reply.code(503).send({ error: 'Fetching is not available in this process.' });
    }
    const result = await coordinator.triggerNow();
    if (result.ok) {
      return reply.code(202).send({ status: 'started', mode: result.mode });
    }
    const body = { error: result.error };
    if (result.retryAfterSeconds !== undefined) {
      body.retryAfterSeconds = result.retryAfterSeconds;
      reply.header('Retry-After', String(result.retryAfterSeconds));
    }
    return reply.code(result.status).send(body);
  });

  app.post('/api/listings/:id/dismiss', { schema: { params: idParams, body: dismissBody } }, async (request, reply) => {
    const { id } = request.params;
    const reason = request.body?.reason ?? 'not_interested';
    if (!dismissListing(request.user.username, id, Date.now(), reason)) {
      return reply.code(404).send({ error: 'Listing not found' });
    }
    return { id, dismissed: true };
  });

  app.delete('/api/listings/:id/dismiss', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params;
    if (!restoreListing(request.user.username, id)) {
      return reply.code(404).send({ error: 'Listing not found' });
    }
    return { id, dismissed: false };
  });

  registerQueryRoutes(app, { reevaluate, maxPerUser: maxQueriesPerUser });
  registerSettingsRoutes(app, { directory, geocoder, mailer, reevaluate, kickLlm });

  const root = path.resolve(uiDir);
  const uiBuilt = fs.existsSync(path.join(root, 'index.html'));
  if (uiBuilt) {
    await app.register(fastifyStatic, { root });
  }

  app.setNotFoundHandler((request, reply) => {
    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    if (isApiPath(request.url) || !readOnly) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (uiBuilt) return reply.sendFile('index.html');
    return reply.code(404).type('text/plain').send('The UI is not built. Run "yarn build:frontend" and restart wgg.');
  });

  return app;
}

/** Creates the app and starts listening; `close()` shuts it down again. */
export async function startServer({ host, port, ...options }) {
  const app = await createApp(options);
  await app.listen({ host, port });
  const actualPort = app.server.address().port;
  logger.info(`wgg UI listening on http://${host}:${actualPort} (login required; use HTTPS when exposed).`);
  return { app, close: () => app.close() };
}
