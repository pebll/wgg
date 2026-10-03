import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { ConfigError } from '../errors.js';
import logger from '../services/logger.js';
import { SqliteSessionStore, sweepExpiredSessions } from '../services/storage/sessionStore.js';
import { verifyPassword, DUMMY_HASH } from './password.js';
import { createWindowLimiter, getClientIp } from './rateLimiter.js';

export const SESSION_COOKIE = 'wgg-session';

const MIN_SECRET_LENGTH = 32;
const HOUR_MS = 3_600_000;
const LOGIN_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_ADDRESS = 30;
const MAX_FAILURES_PER_ACCOUNT = 5;
const OPEN_API_PATHS = new Set(['/api/health', '/api/login']);

const GENERATE_HINT = 'generate one with: openssl rand -hex 32';

/** Reads the cookie-signing secret; the value itself never ends up in an error message. */
export function readSessionSecret(env) {
  const secret = env?.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new ConfigError(`SESSION_SECRET is not set; ${GENERATE_HINT}`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters; ${GENERATE_HINT}`);
  }
  return secret;
}

const pathOf = (url) => {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
};

const isGuarded = (path) => (path === '/api' || path.startsWith('/api/')) && !OPEN_API_PATHS.has(path);

function normalisePublicPath(value) {
  const trimmed = String(value ?? '/').replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', maxLength: 64 },
      password: { type: 'string', maxLength: 1024 },
    },
  },
};

/**
 * Installs cookie sessions, the /api guard and the login, logout and me routes.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{users: {username: string, passwordHash: string, admin: boolean, email: string|null}[],
 *          secret: string, publicPath?: string, sessionHours?: number,
 *          targetNameOf?: (username: string) => string}} options
 */
export async function registerAuth(app, { users, secret, publicPath = '/', sessionHours = 168, targetNameOf }) {
  /** The logged-in user as the UI sees it; `targetName` is the name of their scoring target (settings.scoring.target). */
  const publicUser = (user) => ({
    username: user.username,
    admin: user.admin,
    email: user.email,
    ...(targetNameOf ? { targetName: targetNameOf(user.username) } : {}),
  });
  const byName = new Map(users.map((u) => [u.username, u]));
  const cookiePath = normalisePublicPath(publicPath);
  const limiter = createWindowLimiter(LOGIN_WINDOW_MS);

  sweepExpiredSessions();

  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret,
    cookieName: SESSION_COOKIE,
    store: new SqliteSessionStore(),
    saveUninitialized: false,
    rolling: true,
    cookie: { path: '/', httpOnly: true, sameSite: 'strict', secure: 'auto', maxAge: sessionHours * HOUR_MS },
  });

  // The plugin scopes the cookie to "/" (so it matches /api/... behind a prefix-stripping proxy) and downgrades it
  // to SameSite=Lax over plain http. The browser must only send it for the public prefix, and strictly same-site,
  // so our own cookie is rewritten on the way out.
  const finishCookie = (line) =>
    String(line).startsWith(`${SESSION_COOKIE}=`)
      ? line
          .replace(/;\s*Path=[^;]*/i, '')
          .replace(/;\s*SameSite=[^;]*/i, '')
          .concat(`; Path=${cookiePath}; SameSite=Strict`)
      : line;

  app.addHook('onSend', async (request, reply, payload) => {
    const header = reply.getHeader('set-cookie');
    if (!header) return payload;
    reply.removeHeader('set-cookie');
    reply.header('set-cookie', [header].flat().map(finishCookie));
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!isGuarded(pathOf(request.url))) return;
    const user = byName.get(request.session?.get('username'));
    if (!user) return reply.code(401).send({ error: 'Not logged in' });
    request.user = user;
  });

  app.post('/api/login', { schema: loginSchema }, async (request, reply) => {
    const name = request.body.username.trim().toLowerCase();
    const ip = getClientIp(request);
    const addressKey = `ip|${ip}`;
    const accountKey = `${ip}|${name}`;

    // Evaluate both so each attempt is always counted against both.
    const addressOver = limiter.hit(addressKey, MAX_FAILURES_PER_ADDRESS);
    const accountOver = limiter.hit(accountKey, MAX_FAILURES_PER_ACCOUNT);
    if (addressOver || accountOver) {
      logger.warn(`Login rate limit exceeded from ${ip}`);
      const wait = limiter.retryAfterSeconds(accountOver ? accountKey : addressKey);
      return reply
        .code(429)
        .header('Retry-After', String(wait))
        .send({ error: 'Too many login attempts. Try again in a minute.' });
    }

    const user = byName.get(name);
    const ok = await verifyPassword(request.body.password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) {
      logger.warn(`Failed login for "${name.slice(0, 32)}" from ${ip}`);
      return reply.code(401).send({ error: 'Wrong username or password.' });
    }

    limiter.clear(accountKey);
    limiter.release(addressKey);
    sweepExpiredSessions();
    await request.session.regenerate();
    request.session.set('username', user.username);
    return publicUser(user);
  });

  app.post('/api/logout', async (request, reply) => {
    await request.session.destroy();
    reply.clearCookie(SESSION_COOKIE, { path: cookiePath, httpOnly: true, sameSite: 'strict' });
    return { ok: true };
  });

  app.get('/api/me', async (request) => publicUser(request.user));
}
