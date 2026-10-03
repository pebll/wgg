import { describe, it, expect } from 'vitest';
import { LlmEvaluator, mergeLlm, formatExclusion } from '../../lib/evaluation/llmEvaluator.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { PROMPT_VERSION } from '../../lib/llm/prompt.js';
import { LlmError } from '../../lib/llm/client.js';

const cfg = defaultEvaluationConfig();
const llmCfg = { ...cfg.llm, model: 'm' };
const answer = (o = {}) =>
  JSON.stringify({
    verbindungProbability: 0.1,
    verbindungSignals: [],
    fitScore: 8,
    summary: 'Nice room.',
    positives: ['cheap'],
    redFlags: [],
    eligible: true,
    eligibilityReason: '',
    ...o,
  });

function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    chat: async (req) => {
      calls.push(req);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { status: 200, content: r };
    },
  };
}
const listing = { title: 'T', description: 'D'.repeat(50) };

describe('#llm evaluator', () => {
  it('assesses a listing (temperature 0, json mode) and returns an EvaluationResult with the llm payload', async () => {
    const client = fakeClient([answer()]);
    const ev = new LlmEvaluator({ client, config: llmCfg });
    const r = await ev.evaluate(listing);
    expect(client.calls[0]).toMatchObject({ temperature: 0, jsonMode: true });
    expect(r.scores).toEqual({ llm: 8 });
    expect(r.details.llm).toBe('Nice room.');
    expect(r.overall).toBe(8);
    expect(r.excluded).toBeUndefined();
    expect(r.assessment).toMatchObject({ fitScore: 8, truncated: false, model: 'm' });
  });

  it('retries once on invalid JSON, then succeeds', async () => {
    const client = fakeClient(['sorry, no json', answer()]);
    const r = await new LlmEvaluator({ client, config: llmCfg }).evaluate(listing);
    expect(client.calls).toHaveLength(2);
    expect(r.scores.llm).toBe(8);
  });

  it('fails after the retry also returns invalid JSON', async () => {
    const client = fakeClient(['x', 'y']);
    await expect(new LlmEvaluator({ client, config: llmCfg }).evaluate(listing)).rejects.toThrow(/invalid|JSON/i);
    expect(client.calls).toHaveLength(2);
  });

  it('does not retry transport errors', async () => {
    const client = fakeClient([new LlmError('boom')]);
    await expect(new LlmEvaluator({ client, config: llmCfg }).evaluate(listing)).rejects.toThrow('boom');
    expect(client.calls).toHaveLength(1);
  });

  it('marks truncation in the stored assessment', async () => {
    const client = fakeClient([answer()]);
    const ev = new LlmEvaluator({ client, config: { ...llmCfg, maxDescriptionChars: 1000 } });
    const r = await ev.evaluate({ ...listing, description: 'x'.repeat(3000) });
    expect(r.assessment.truncated).toBe(true);
    expect(r.assessment.descriptionChars).toBe(3000);
  });

  it('excludes at or above the threshold with the signals as reason', async () => {
    const client = fakeClient([
      answer({ verbindungProbability: 0.82, verbindungSignals: ['"Bundesbrüder"', '"Kneipe"'] }),
    ]);
    const r = await new LlmEvaluator({ client, config: llmCfg }).evaluate(listing);
    expect(r.excluded).toBe('LLM: likely Studentenverbindung (p=0.82): "Bundesbrüder"; "Kneipe"');
    expect(r.overall).toBe(1);
    const edge = await new LlmEvaluator({
      client: fakeClient([answer({ verbindungProbability: 0.6 })]),
      config: llmCfg,
    }).evaluate(listing);
    expect(edge.excluded).toMatch(/p=0\.60/);
  });

  it('excludes an ineligible listing with the reason when hideIneligible is on, stores the flag', async () => {
    const ans = answer({ eligible: false, eligibilityReason: 'only women wanted' });
    const r = await new LlmEvaluator({ client: fakeClient([ans]), config: llmCfg }).evaluate(listing);
    expect(r.excluded).toBe('LLM: not eligible: only women wanted');
    expect(r.overall).toBe(1);
    expect(r.assessment).toMatchObject({ eligible: false, promptVersion: PROMPT_VERSION });
    const off = await new LlmEvaluator({
      client: fakeClient([ans]),
      config: { ...llmCfg, hideIneligible: false },
    }).evaluate(listing);
    expect(off.excluded).toBeUndefined();
  });

  it('sends today and the profile to the model', async () => {
    const client = fakeClient([answer()]);
    const now = new Date(2026, 9, 2, 12).getTime();
    await new LlmEvaluator({ client, config: { ...llmCfg, profile: 'PROFILE-XYZ' } }).evaluate(listing, { now });
    const sys = client.calls[0].messages.find((m) => m.role === 'system').content;
    expect(sys).toContain('Today is 2 October 2026 (Friday).');
    expect(sys).toContain('PROFILE-XYZ');
  });

  it('formatExclusion handles empty signals', () => {
    expect(formatExclusion(0.7, [])).toBe('LLM: likely Studentenverbindung (p=0.70)');
  });
});

describe('#llm merge', () => {
  const rule = { scores: { rent: 10, distance: 6 }, overall: 8, missing: [], details: { rent: 'r', distance: 'd' } };
  const assessment = (o = {}) => ({
    verbindungProbability: 0.1,
    verbindungSignals: [],
    fitScore: 4,
    summary: 'Meh.',
    positives: [],
    redFlags: [],
    ...o,
  });

  it('adds llm as a weighted parameter and recomputes the average', () => {
    const r = mergeLlm(rule, assessment(), cfg);
    expect(r.scores).toEqual({ rent: 10, distance: 6, llm: 4 });
    expect(r.details.llm).toBe('Meh.');
    // (10*3 + 6*3 + 4*2) / (3+3+2) = 56/8 = 7
    expect(r.overall).toBe(7);
    expect(r.excluded).toBeUndefined();
  });

  it('weight 0 shows the llm score but leaves the average alone', () => {
    const r = mergeLlm(rule, assessment(), { ...cfg, llm: { ...cfg.llm, weight: 0 } });
    expect(r.scores.llm).toBe(4);
    expect(r.overall).toBe(8);
  });

  it('exclusion sets overall 1 and the reason, keeping the scores', () => {
    const r = mergeLlm(rule, assessment({ verbindungProbability: 0.9, verbindungSignals: ['"Aktivitas"'] }), cfg);
    expect(r.overall).toBe(1);
    expect(r.excluded).toContain('p=0.90');
    expect(r.scores.llm).toBe(4);
  });

  it('merge excludes an ineligible assessment (only with hideIneligible); old assessments count as eligible', () => {
    const inel = assessment({ eligible: false, eligibilityReason: 'age range 30+' });
    const r = mergeLlm(rule, inel, cfg);
    expect(r.excluded).toBe('LLM: not eligible: age range 30+');
    expect(r.overall).toBe(1);
    expect(mergeLlm(rule, inel, { ...cfg, llm: { ...cfg.llm, hideIneligible: false } }).excluded).toBeUndefined();
    const { eligible: _e, ...old } = assessment();
    expect(mergeLlm(rule, old, cfg).excluded).toBeUndefined();
  });

  it('keeps a rule exclusion and appends the llm one', () => {
    const r = mergeLlm(
      { ...rule, overall: 1, excluded: 'rent too high' },
      assessment({ verbindungProbability: 0.9 }),
      cfg,
    );
    expect(r.excluded).toMatch(/^rent too high; LLM: likely/);
  });

  it('does not touch the rule result when the llm is disabled or has no assessment', () => {
    expect(mergeLlm(rule, null, cfg)).toEqual(rule);
    expect(mergeLlm(rule, assessment(), { ...cfg, llm: { ...cfg.llm, enabled: false } })).toEqual(rule);
  });
});
