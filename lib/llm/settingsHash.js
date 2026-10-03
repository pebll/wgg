import crypto from 'crypto';
import { PROMPT_VERSION } from './prompt.js';
import { defaultEvaluationConfig } from '../evaluation/config.js';

const DEFAULT_TARGET_NAME = defaultEvaluationConfig().target.name;

/**
 * Fingerprint of everything that makes an AI assessment valid: the prompt version, the user's profile text, the model
 * and the name of the user's scoring target (the prompt names it in the distance line). It is stored with every
 * assessment; when the current fingerprint of a user differs from the stored one, the assessment is queued again (a
 * changed profile, model or target name, a new prompt version).
 * The built-in default target and a blank name add nothing to it, so assessments made before the target name was part
 * of the prompt stay valid for those users; only a user who really changed the name is assessed again.
 * `hideIneligible` is not part of it: it only changes how a stored assessment is applied.
 *
 * @param {{model: string, profile: string, targetName?: string, promptVersion?: number}} parts
 * @returns {string} 16 hex characters
 */
export function llmSettingsHash({ model, profile, targetName, promptVersion = PROMPT_VERSION }) {
  const parts = [promptVersion, String(profile ?? '').trim(), String(model ?? '')];
  const name = String(targetName ?? '').trim();
  if (name && name !== DEFAULT_TARGET_NAME) parts.push(name);
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
