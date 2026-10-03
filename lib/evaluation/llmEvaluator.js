import { buildMessages, PROMPT_VERSION } from '../llm/prompt.js';
import { parseAssessment, LlmFormatError } from '../llm/parse.js';

const round1 = (n) => Math.round(n * 10) / 10;

/** "LLM: likely Studentenverbindung (p=0.82): "Bundesbrüder"; "Kneipe"" */
export function formatExclusion(probability, signals) {
  const head = `LLM: likely Studentenverbindung (p=${probability.toFixed(2)})`;
  return signals.length > 0 ? `${head}: ${signals.join('; ')}` : head;
}

/** "LLM: not eligible: only women wanted" */
export function formatIneligible(reason) {
  return reason ? `LLM: not eligible: ${reason}` : 'LLM: not eligible';
}

/**
 * The exclusion reasons an assessment causes under `config` (Verbindung threshold, ineligibility). The user's
 * `autoReject.verbindung` switches decide whether and from which probability a Verbindung excludes; without them the
 * global `llm.excludeThreshold` applies.
 */
function llmExclusions(assessment, { excludeThreshold, hideIneligible }, autoReject) {
  const reasons = [];
  const v = autoReject?.verbindung;
  const verbindungOn = v ? v.enabled && v.ai : true;
  const threshold = v ? v.aiThreshold : excludeThreshold;
  if (verbindungOn && assessment.verbindungProbability >= threshold) {
    reasons.push(formatExclusion(assessment.verbindungProbability, assessment.verbindungSignals));
  }
  if (hideIneligible && assessment.eligible === false) reasons.push(formatIneligible(assessment.eligibilityReason));
  return reasons;
}

/**
 * LLM evaluator: implements the Evaluator interface (`name`, `evaluate`), except that evaluation is asynchronous.
 * Its EvaluationResult holds only the `llm` parameter (the fit score); `mergeLlm` adds it to the rule-based result.
 * The validated answer (plus model, truncation info) is returned as `assessment` for storage.
 */
export class LlmEvaluator {
  name = 'llm';

  /**
   * @param {{client: {chat: Function}, config: ReturnType<import('./config.js').defaultEvaluationConfig>['llm']}} deps
   */
  constructor({ client, config }) {
    this.client = client;
    this.config = config;
  }

  /**
   * @param {Parameters<typeof buildMessages>[0]} listing
   * @returns {Promise<import('./ruleBasedEvaluator.js').EvaluationResult & {assessment: object}>}
   * @throws {import('../llm/client.js').LlmError|LlmFormatError}
   */
  async evaluate(listing, { now = Date.now() } = {}) {
    const { messages, truncated, descriptionChars } = buildMessages(listing, { ...this.config, now });
    let assessment;
    let lastError;
    for (let attempt = 0; attempt < 2 && !assessment; attempt++) {
      const { content } = await this.client.chat({ messages, temperature: 0, jsonMode: true });
      try {
        assessment = parseAssessment(content);
      } catch (e) {
        if (!(e instanceof LlmFormatError)) throw e;
        lastError = e;
      }
    }
    if (!assessment) throw new LlmFormatError(`the model's answer was invalid twice: ${lastError.message}`);

    const stored = {
      ...assessment,
      truncated,
      descriptionChars,
      model: this.config.model,
      promptVersion: PROMPT_VERSION,
    };
    const excluded = llmExclusions(assessment, this.config).join('; ') || undefined;
    return {
      scores: { llm: assessment.fitScore },
      overall: excluded ? 1 : assessment.fitScore,
      missing: [],
      details: { llm: assessment.summary },
      ...(excluded ? { excluded } : {}),
      assessment: stored,
    };
  }
}

/**
 * Merges a stored LLM assessment into a rule-based result: `scores.llm` becomes one more weighted parameter and the
 * overall average is recomputed; a Verbindung probability at or above the user's `autoReject.verbindung.aiThreshold` (with the switches on), or an ineligible
 * assessment while `llm.hideIneligible` is on, excludes the listing (overall 1, the signals / reason as reason). Without an assessment, or with the LLM disabled, the rule result is returned
 * unchanged. Needs the rule weights to recompute the average.
 *
 * @param {import('./ruleBasedEvaluator.js').EvaluationResult} rule
 * @param {{verbindungProbability: number, verbindungSignals: string[], fitScore: number, summary: string}|null|undefined} assessment
 * @param {{weights: Record<string, number>, llm: ReturnType<import('./config.js').defaultEvaluationConfig>['llm']}} config
 * @returns {import('./ruleBasedEvaluator.js').EvaluationResult}
 */
export function mergeLlm(rule, assessment, config) {
  if (!assessment || !config.llm.enabled) return rule;
  const { weight } = config.llm;

  let weighted = 0;
  let total = 0;
  for (const [param, score] of Object.entries(rule.scores)) {
    const w = config.weights[param] ?? 0;
    weighted += score * w;
    total += w;
  }
  weighted += assessment.fitScore * weight;
  total += weight;

  const merged = {
    ...rule,
    scores: { ...rule.scores, llm: assessment.fitScore },
    details: { ...rule.details, llm: assessment.summary },
    overall: total > 0 ? round1(weighted / total) : rule.overall,
  };
  const reason = llmExclusions(assessment, config.llm, config.autoReject).join('; ');
  if (reason) {
    merged.excluded = rule.excluded ? `${rule.excluded}; ${reason}` : reason;
    merged.overall = 1;
  } else if (rule.excluded) {
    merged.overall = 1;
  }
  return merged;
}
