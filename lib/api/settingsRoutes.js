import { SettingsError, validateSettingsUpdate } from '../settings/validate.js';
import { defaultUserSettings } from '../settings/defaults.js';
import { saveSettings } from '../services/settings/userSettingsStorage.js';
import { refreshTiers } from '../notify/tierStorage.js';
import { composeTestMail } from '../notify/composer.js';
import { createWindowLimiter } from '../auth/rateLimiter.js';

/** Address lookups per user and minute (Nominatim is shared, serial and limited to one request per second). */
const GEOCODES_PER_MINUTE = 10;
/** Test mails per user and ten minutes. */
const TEST_MAILS_PER_WINDOW = 3;
const TEST_MAIL_WINDOW_MS = 10 * 60_000;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/test-mail`: the logged-in user's own settings (scoring,
 * AI profile, notifications). The session decides whose settings; nothing in a request can name another user.
 *
 * PUT takes a partial document (see validateSettingsUpdate). A changed `scoring.target.address` is geocoded (rate
 * limited per user); the coordinates are never taken from the client. Afterwards the user's listings are evaluated
 * again when scoring, the auto-reject switches or the hide-ineligible switch changed (`reevaluate`), and the AI queue is woken when the profile
 * changed (`kickLlm`; assessments made with the old profile are queued again by their settings hash).
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} deps
 * @param {ReturnType<import('../users/directory.js').createUserDirectory>|undefined} deps.directory
 * @param {import('../geocoding/geocoder.js').Geocoder|undefined} deps.geocoder
 * @param {{dryRun: boolean, reason: string|null, send: Function}|undefined} deps.mailer
 * @param {(userId: string, all: boolean) => void} deps.reevaluate
 * @param {() => void} deps.kickLlm
 */
export function registerSettingsRoutes(app, { directory, geocoder, mailer, reevaluate, kickLlm }) {
  const geocodes = createWindowLimiter(60_000);
  const testMails = createWindowLimiter(TEST_MAIL_WINDOW_MS);

  const needDirectory = (reply) => {
    if (directory) return false;
    reply.code(503).send({ error: 'Settings are not available in this process.' });
    return true;
  };
  const defaultsOf = (userId) =>
    defaultUserSettings({
      evaluation: directory.evaluation,
      notify: directory.notifyDefaults,
      email: directory.get(userId)?.email ?? null,
    });

  app.get('/api/settings', async (request, reply) => {
    if (needDirectory(reply)) return reply;
    const userId = request.user.username;
    return { settings: directory.settings(userId), defaults: defaultsOf(userId) };
  });

  app.put('/api/settings', { schema: { body: { type: 'object' } } }, async (request, reply) => {
    if (needDirectory(reply)) return reply;
    const userId = request.user.username;
    const current = directory.settings(userId);

    // The coordinates of the target come from geocoding its address, never from the client.
    const body = structuredClone(request.body ?? {});
    if (body.scoring?.target && typeof body.scoring.target === 'object') {
      delete body.scoring.target.lat;
      delete body.scoring.target.lng;
    }

    let next;
    try {
      next = validateSettingsUpdate({ body, current, evaluation: directory.evaluation });
    } catch (e) {
      if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
      throw e;
    }

    const addressChanged = next.scoring.target.address !== current.scoring.target.address;
    if (addressChanged) {
      if (next.scoring.target.address === '') return reply.code(400).send({ error: 'Enter a target address.' });
      if (!geocoder) return reply.code(503).send({ error: 'Address lookup is not available in this process.' });
      if (geocodes.hit(userId, GEOCODES_PER_MINUTE)) {
        reply.header('Retry-After', String(geocodes.retryAfterSeconds(userId)));
        return reply.code(429).send({ error: 'Too many address lookups. Try again in a minute.' });
      }
      const point = await geocoder.geocode(next.scoring.target.address);
      if (!point) {
        return reply
          .code(422)
          .send({ error: `Could not find "${next.scoring.target.address}". Try a street and city.` });
      }
      next.scoring.target.lat = point.lat;
      next.scoring.target.lng = point.lng;
      // Without a name of its own the target is called by its address.
      if (body.scoring?.target?.name === undefined) next.scoring.target.name = next.scoring.target.address;
    }

    saveSettings(userId, next);

    const scoringChanged =
      !same(next.scoring, current.scoring) ||
      !same(next.autoReject, current.autoReject) ||
      next.llm.hideIneligible !== current.llm.hideIneligible;
    // The alert tiers follow the user's rules (and the AI settings hash, which a changed profile changes).
    if (
      !same(next.notify.priority, current.notify.priority) ||
      !same(next.notify.bulk, current.notify.bulk) ||
      next.llm.profile.trim() !== current.llm.profile.trim()
    ) {
      refreshTiers(userId, { notify: next.notify, llmHash: directory.context(userId).llmHash });
    }
    if (scoringChanged) reevaluate(userId, true);
    if (next.llm.profile.trim() !== current.llm.profile.trim()) kickLlm();
    return { settings: next };
  });

  app.post('/api/settings/test-mail', async (request, reply) => {
    if (needDirectory(reply)) return reply;
    const userId = request.user.username;
    if (!mailer) return reply.code(503).send({ error: 'Email is not available in this process.' });
    if (mailer.dryRun) {
      return reply.code(503).send({ error: `This server cannot send email: ${mailer.reason ?? 'dry run'}.` });
    }
    const { email } = directory.settings(userId).notify;
    if (!email && directory.owner()?.username !== userId) {
      return reply.code(400).send({ error: 'Set your notification email address first.' });
    }
    if (testMails.hit(userId, TEST_MAILS_PER_WINDOW)) {
      reply.header('Retry-After', String(testMails.retryAfterSeconds(userId)));
      return reply.code(429).send({ error: 'Too many test emails. Try again in a few minutes.' });
    }
    try {
      await mailer.send({ ...composeTestMail({ username: userId }), ...(email ? { to: email } : {}) });
    } catch (e) {
      return reply.code(502).send({ error: `Sending the test email failed: ${e.message}` });
    }
    return { sent: true, to: email ?? null };
  });
}
