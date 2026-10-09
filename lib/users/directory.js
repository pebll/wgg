import { RuleBasedEvaluator } from '../evaluation/ruleBasedEvaluator.js';
import { getStoredSettings } from '../services/settings/userSettingsStorage.js';
import { defaultUserSettings, mergeSettings, buildEvaluationConfig } from '../settings/defaults.js';
import { llmSettingsHash } from '../llm/settingsHash.js';

/**
 * The accounts of this process and everything derived from their settings, read fresh from the database on every call
 * (a user who saves new settings is served with them by the very next evaluation, assessment or alert).
 *
 * @typedef {object} UserContext What the pipelines need for one user.
 * @property {string} userId
 * @property {{username: string, admin: boolean, email: string|null}} user
 * @property {ReturnType<typeof defaultUserSettings>} settings Defaults with the user's saved settings laid over them.
 * @property {ReturnType<typeof buildEvaluationConfig>} config The user's evaluation config.
 * @property {RuleBasedEvaluator} evaluator Rule-based evaluator for that config (`evaluator.config` is the config).
 * @property {{lat: number, lng: number, name: string}} target
 * @property {string} llmHash Fingerprint of prompt version, profile, model and target name (see llmSettingsHash).
 *
 * @param {object} params
 * @param {{username: string, admin: boolean, email: string|null}[]} params.users
 * @param {ReturnType<import('../evaluation/config.js').defaultEvaluationConfig>} params.evaluation Global evaluation config.
 * @param {ReturnType<import('../config.js').parseConfig>['notify']} params.notify Global notify config (defaults).
 * @param {string} [params.model] The LLM model id (part of the settings hash).
 */
export function createUserDirectory({ users, evaluation, notify, model = '' }) {
  const byId = new Map(users.map((u) => [u.username, u]));

  function settings(userId) {
    const user = byId.get(userId);
    const defaults = defaultUserSettings({
      evaluation,
      notify,
      email: user?.email ?? null,
      isOwner: users.find((u) => u.admin)?.username === userId,
    });
    return mergeSettings(defaults, getStoredSettings(userId));
  }

  function context(userId) {
    const user = byId.get(userId);
    if (!user) throw new Error(`Unknown user "${userId}"`);
    const s = settings(userId);
    const config = buildEvaluationConfig(evaluation, s);
    config.llm.model = model;
    return {
      userId,
      user,
      settings: s,
      config,
      evaluator: new RuleBasedEvaluator(config),
      target: config.target,
      llmHash: llmSettingsHash({ model, profile: s.llm.profile, targetName: config.target.name }),
    };
  }

  return {
    users,
    model,
    evaluation,
    notifyDefaults: notify,
    get: (userId) => byId.get(userId),
    settings,
    context,
    contexts: () => users.map((u) => context(u.username)),
    /** The admin that owns the data from before accounts existed (first admin in users.yaml) as a notify fallback. */
    owner: () => users.find((u) => u.admin),
  };
}
