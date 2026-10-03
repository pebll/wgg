import { describe, it, expect } from 'vitest';
import { parseAssessment, LlmFormatError } from '../../lib/llm/parse.js';

const valid = {
  verbindungProbability: 0.82,
  verbindungSignals: ['"Bundesbrüder"', '"Semesterprogramm"'],
  fitScore: 7,
  summary: 'Cheap room in a likely fraternity house.',
  positives: ['central'],
  redFlags: ['fraternity signals'],
  eligible: true,
  eligibilityReason: '',
};

describe('#llm parse', () => {
  it('parses plain JSON', () => {
    expect(parseAssessment(JSON.stringify(valid))).toEqual({ ...valid, deductions: [] });
  });

  it('strips code fences and surrounding prose', () => {
    expect(parseAssessment('```json\n' + JSON.stringify(valid) + '\n```')).toEqual({ ...valid, deductions: [] });
    expect(parseAssessment('Here you go:\n' + JSON.stringify(valid) + '\nThanks')).toEqual({
      ...valid,
      deductions: [],
    });
  });

  it('trims strings, drops empty ones and caps list length', () => {
    const r = parseAssessment(
      JSON.stringify({
        ...valid,
        positives: [' a ', '', 'b'],
        verbindungSignals: Array.from({ length: 30 }, (_, i) => `s${i}`),
      }),
    );
    expect(r.positives).toEqual(['a', 'b']);
    expect(r.verbindungSignals).toHaveLength(10);
  });

  it('parses eligibility and trims the reason', () => {
    const r = parseAssessment(JSON.stringify({ ...valid, eligible: false, eligibilityReason: ' only women wanted ' }));
    expect(r).toMatchObject({ eligible: false, eligibilityReason: 'only women wanted' });
  });

  it('a missing or non-boolean eligible counts as eligible (with a warning), it does not fail', () => {
    const { eligible: _e, eligibilityReason: _r, ...rest } = valid;
    expect(parseAssessment(JSON.stringify(rest))).toMatchObject({ eligible: true, eligibilityReason: '' });
    expect(parseAssessment(JSON.stringify({ ...rest, eligible: 'no' }))).toMatchObject({ eligible: true });
  });

  it('rejects invalid JSON and out-of-range or mistyped fields', () => {
    const bad = (obj) =>
      expect(() => parseAssessment(typeof obj === 'string' ? obj : JSON.stringify(obj))).toThrow(LlmFormatError);
    bad('not json at all');
    bad('');
    bad({ ...valid, verbindungProbability: 1.2 });
    bad({ ...valid, verbindungProbability: '0.5' });
    bad({ ...valid, fitScore: 0 });
    bad({ ...valid, fitScore: 11 });
    bad({ ...valid, fitScore: NaN });
    bad({ ...valid, summary: '' });
    bad({ ...valid, summary: 5 });
    bad({ ...valid, positives: 'x' });
    bad({ ...valid, redFlags: [1] });
    bad({ ...valid, verbindungSignals: undefined });
  });

  describe('deductions', () => {
    const ded = (deductions, fitScore = 7) => JSON.stringify({ ...valid, fitScore, deductions });

    it('parses deductions that add up to 10 - fitScore, without a warning flag', () => {
      const r = parseAssessment(
        ded([
          { points: 2, reason: 'Zweck-WG, little shared life' },
          { points: 1, reason: ' far from target ' },
        ]),
      );
      expect(r.deductions).toEqual([
        { points: 2, reason: 'Zweck-WG, little shared life' },
        { points: 1, reason: 'far from target' },
      ]);
      expect(r.modelFitScore).toBeUndefined();
    });

    it('missing deductions (older answers) become [] without failing or flagging', () => {
      const r = parseAssessment(JSON.stringify(valid));
      expect(r.deductions).toEqual([]);
      expect(r.modelFitScore).toBeUndefined();
    });

    it('accepts fitScore 10 with [] and keeps a consistent answer unchanged', () => {
      const perfect = parseAssessment(ded([], 10));
      expect(perfect.fitScore).toBe(10);
      expect(perfect.modelFitScore).toBeUndefined();
      expect(parseAssessment(ded([{ points: 2.5, reason: 'a' }], 7.5)).fitScore).toBe(7.5);
    });

    it('derives fitScore from the deductions (10 - sum) when the model miscounts, keeping its number for reference', () => {
      // live example: deductions sum to 7 but the model answered 5
      const r = parseAssessment(
        ded(
          [
            { points: 2, reason: 'Zweck-WG' },
            { points: 1.5, reason: 'high rent' },
            { points: 1, reason: 'deposit' },
            { points: 1, reason: 'thin ad' },
            { points: 1, reason: 'location' },
            { points: 0.5, reason: 'small room' },
          ],
          5,
        ),
      );
      expect(r.fitScore).toBe(3);
      expect(r.modelFitScore).toBe(5);
      // an empty list explains nothing: keep the model's score rather than inflating it to 10
      const unexplained = parseAssessment(ded([], 7));
      expect(unexplained.fitScore).toBe(7);
      expect(unexplained.modelFitScore).toBeUndefined();
    });

    it('clamps the derived score to 1..10', () => {
      const many = Array.from({ length: 5 }, () => ({ points: 3, reason: 'x' }));
      expect(parseAssessment(ded(many, 2)).fitScore).toBe(1);
    });

    it('an ineligible listing always scores 1', () => {
      const r = parseAssessment(
        JSON.stringify({
          ...valid,
          fitScore: 6,
          deductions: [{ points: 4, reason: 'women only' }],
          eligible: false,
          eligibilityReason: 'women only',
        }),
      );
      expect(r.fitScore).toBe(1);
    });

    it('rejects wrong types and out-of-range points', () => {
      for (const d of [
        'x',
        [null],
        [{ points: '2', reason: 'a' }],
        [{ points: 0.2, reason: 'a' }],
        [{ points: 10, reason: 'a' }],
        [{ points: 2, reason: '' }],
        [{ points: 2 }],
      ]) {
        expect(() => parseAssessment(ded(d))).toThrow(LlmFormatError);
      }
    });
  });
});
