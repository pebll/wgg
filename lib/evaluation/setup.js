import fs from 'fs';
import { LlmEvaluator } from './llmEvaluator.js';
import { createLlmWorker } from '../llm/llmWorker.js';
import { createLlmClient, readLlmEnv, LlmError } from '../llm/client.js';
import { createNominatimGeocoder, buildUserAgent } from '../geocoding/nominatim.js';
import { createSqliteGeocodeCache } from '../geocoding/cache.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * The Nominatim geocoder with the SQLite cache (strictly serial, rate-limited). Requires the database to be initialized
 * and migrated.
 * @param {{regeocode?: boolean}} [options] `regeocode`: ask again for places the cache knows as "not found".
 */
export function createGeocoder({ regeocode = false } = {}) {
  return createNominatimGeocoder({
    userAgent: buildUserAgent(version),
    email: process.env.NOMINATIM_EMAIL || undefined,
    cache: createSqliteGeocodeCache(),
    retryNegatives: regeocode,
  });
}

/**
 * Wires the evaluation dependencies for all users: their contexts (own target, ranges, weights, keywords, profile) are
 * read from the database whenever the pipeline asks, and the one geocoder. `geocoder` is injectable for tests.
 *
 * @param {object} options
 * @param {ReturnType<import('../users/directory.js').createUserDirectory>} options.directory
 * @param {import('../geocoding/geocoder.js').Geocoder} [options.geocoder]
 * @param {boolean} [options.regeocode]
 */
export function createEvaluationDeps({ directory, geocoder, regeocode = false }) {
  return {
    contexts: () => directory.contexts(),
    geocoder: geocoder ?? createGeocoder({ regeocode }),
    regeocode,
  };
}

/**
 * Wires the LLM worker. Returns `{worker: null, reason}` when the LLM assessment is off (disabled in the config, no
 * model, or no gateway settings in the environment); never throws for those. The gateway URL and key come from the
 * environment (.env), the model from `LLM_MODEL` or `llm.model` of config/evaluation.yaml (the directory already holds
 * the model). The worker assesses every user's listings with that user's own profile.
 *
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   directory: ReturnType<import('../users/directory.js').createUserDirectory>,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   onAssessed?: (userId: string, providerId: string) => unknown}} options
 * @returns {{worker: ReturnType<typeof createLlmWorker>|null, reason?: string, config: object}}
 */
export function createLlmDeps({ env = process.env, fetchImpl, directory, sleep, onAssessed }) {
  const { model } = directory;
  const base = directory.evaluation;
  const config = { ...base, llm: { ...base.llm, model } };
  if (!config.llm.enabled)
    return { worker: null, reason: 'the LLM assessment is disabled (llm.enabled: false)', config };
  let settings;
  try {
    settings = readLlmEnv(env);
  } catch (e) {
    if (e instanceof LlmError) return { worker: null, reason: e.message, config };
    throw e;
  }
  if (!model) {
    return {
      worker: null,
      reason: 'no LLM model: set llm.model in config/evaluation.yaml or LLM_MODEL in .env',
      config,
    };
  }
  const client = createLlmClient({ ...settings, model, fetchImpl });
  return {
    worker: createLlmWorker({
      users: () =>
        directory.contexts().map((ctx) => ({
          userId: ctx.userId,
          ruleEvaluator: ctx.evaluator,
          llmEvaluator: new LlmEvaluator({ client, config: { ...ctx.config.llm, targetName: ctx.target.name } }),
          settingsHash: ctx.llmHash,
          target: ctx.target,
          notify: ctx.settings.notify,
        })),
      config: config.llm,
      secrets: [settings.apiKey],
      ...(onAssessed ? { onAssessed } : {}),
      ...(sleep ? { sleep } : {}),
    }),
    config,
  };
}
