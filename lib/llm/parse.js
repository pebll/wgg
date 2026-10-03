import logger from '../services/logger.js';

export class LlmFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmFormatError';
  }
}

const MAX_ITEMS = 10;
const MAX_TEXT = 400;

/** Extracts the first JSON object from a model reply (plain, in a code fence, or inside prose). */
function extractJson(text) {
  const t = String(text ?? '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : t;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new LlmFormatError('invalid JSON: no JSON object in the reply');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new LlmFormatError(`invalid JSON: ${e.message}`);
  }
}

function strings(value, key) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new LlmFormatError(`invalid ${key}: expected a list of strings`);
  }
  return value
    .map((s) => s.trim().slice(0, MAX_TEXT))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function number(value, key, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new LlmFormatError(`invalid ${key}: expected a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * The score shown to the user must match its explanation, and models miscount: when deductions are listed,
 * fitScore = 10 - sum (rounded to 0.5, clamped to 1..10); an ineligible listing scores 1. Without deductions the
 * model's own score is kept (an empty list explains nothing).
 */
function deriveFitScore(modelScore, listed, eligible) {
  if (!eligible) return 1;
  if (listed.length === 0) return modelScore;
  const derived = Math.round((10 - listed.reduce((sum, d) => sum + d.points, 0)) * 2) / 2;
  return Math.min(10, Math.max(1, derived));
}

/** Validates the optional `deductions` list; a missing list (older answers) is []. */
function deductions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new LlmFormatError('invalid deductions: expected a list');
  return value
    .map((d) => {
      if (d === null || typeof d !== 'object' || Array.isArray(d)) {
        throw new LlmFormatError('invalid deductions: expected objects with points and reason');
      }
      const points = number(d.points, 'deductions.points', 0.5, 9);
      if (typeof d.reason !== 'string' || d.reason.trim() === '') {
        throw new LlmFormatError('invalid deductions.reason: expected a non-empty string');
      }
      return { points, reason: d.reason.trim().slice(0, MAX_TEXT) };
    })
    .slice(0, MAX_ITEMS);
}

/**
 * Parses and validates the model's answer.
 * @param {string} text
 * A missing or non-boolean `eligible` is treated as eligible (with a warning); it never fails the assessment.
 * @returns {{verbindungProbability: number, verbindungSignals: string[], fitScore: number, summary: string,
 *   positives: string[], redFlags: string[], deductions: {points: number, reason: string}[],
 *   modelFitScore?: number, eligible: boolean, eligibilityReason: string}}
 * @throws {LlmFormatError}
 */
export function parseAssessment(text) {
  const raw = extractJson(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LlmFormatError('invalid JSON: expected an object');
  }
  if (typeof raw.summary !== 'string' || raw.summary.trim() === '') {
    throw new LlmFormatError('invalid summary: expected a non-empty string');
  }
  let eligible = raw.eligible;
  if (typeof eligible !== 'boolean') {
    logger.warn('LLM answer without a boolean "eligible": treating the listing as eligible');
    eligible = true;
  }
  const reason = typeof raw.eligibilityReason === 'string' ? raw.eligibilityReason.trim().slice(0, MAX_TEXT) : '';
  const modelFitScore = number(raw.fitScore, 'fitScore', 1, 10);
  const listed = deductions(raw.deductions);
  const fitScore = deriveFitScore(modelFitScore, listed, eligible);
  return {
    verbindungProbability: number(raw.verbindungProbability, 'verbindungProbability', 0, 1),
    verbindungSignals: strings(raw.verbindungSignals, 'verbindungSignals'),
    fitScore,
    deductions: listed,
    ...(fitScore !== modelFitScore ? { modelFitScore } : {}),
    summary: raw.summary.trim().slice(0, 600),
    positives: strings(raw.positives, 'positives'),
    redFlags: strings(raw.redFlags, 'redFlags'),
    eligible,
    eligibilityReason: eligible ? '' : reason,
  };
}
