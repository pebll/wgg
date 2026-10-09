import { describe, it, expect } from 'vitest';
import {
  publicReason,
  verbindungTone,
  verbindungBadge,
  llmStatusLabel,
  describeLlmModel,
  describeLlmQueue,
  breakdownRows,
  isVerbindung,
  scoreChip,
  deductionRows,
  deductionSummary,
} from '../../ui/src/services/format.js';

const done = (p, extra = {}) => ({
  status: 'done',
  model: 'google.claude-opus-5.5',
  evaluatedAt: 1_000_000,
  error: null,
  result: { verbindungProbability: p, verbindungSignals: [], fitScore: 7, summary: 's', positives: [], redFlags: [] },
  ...extra,
});

describe('#llm UI helpers', () => {
  it('publicReason drops the internal probability from an exclusion reason', () => {
    expect(publicReason('LLM: likely Studentenverbindung (p=0.82): "Bundesbrüder"; "Kneipe"')).toBe(
      'LLM: likely Studentenverbindung: "Bundesbrüder"; "Kneipe"',
    );
    expect(publicReason('LLM: likely Studentenverbindung (p=0.82)')).toBe('LLM: likely Studentenverbindung');
    expect(publicReason('excluded keyword "Corps"')).toBe('excluded keyword "Corps"');
    expect(publicReason(null)).toBeNull();
  });

  it('verbindungTone: low below the badge threshold, high from the exclude level', () => {
    expect(verbindungTone(0.1, 0.3)).toBe('low');
    expect(verbindungTone(0.3, 0.3)).toBe('mid');
    expect(verbindungTone(0.59, 0.3)).toBe('mid');
    expect(verbindungTone(0.6, 0.3)).toBe('high');
  });

  it('verbindungBadge shows "Verbindung !" without a number from the threshold on, never without a result', () => {
    expect(verbindungBadge(done(0.45), 0.3)).toEqual({ text: 'Verbindung !', tone: 'mid' });
    expect(verbindungBadge(done(0.3), 0.3)?.text).toBe('Verbindung !');
    expect(verbindungBadge(done(0.29), 0.3)).toBeNull();
    expect(verbindungBadge(done(0.9), 0.3)?.tone).toBe('high');
    expect(verbindungBadge({ status: 'pending', result: null }, 0.3)).toBeNull();
    expect(verbindungBadge(undefined, 0.3)).toBeNull();
    expect(verbindungBadge(done(0.4), undefined)?.text).toBe('Verbindung !'); // default threshold 0.3
    expect(JSON.stringify(verbindungBadge(done(0.45), 0.3))).not.toMatch(/[0-9]/);
  });

  it('llmStatusLabel explains pending / failed / skipped and is null when done or unknown', () => {
    expect(llmStatusLabel(done(0.1))).toBeNull();
    expect(llmStatusLabel(undefined)).toBeNull();
    expect(llmStatusLabel({ status: 'pending' })).toBe('AI assessment pending');
    expect(llmStatusLabel({ status: 'failed', error: 'HTTP 500', attempts: 2 })).toBe('AI assessment failed: HTTP 500');
    expect(llmStatusLabel({ status: 'failed', error: null })).toBe('AI assessment failed');
    expect(llmStatusLabel({ status: 'skipped', error: 'no description' })).toBe(
      'AI assessment skipped: no description',
    );
    expect(llmStatusLabel({ status: 'pending', error: 'x', attempts: 0 })).toBe('AI assessment pending');
  });

  it('describeLlmModel names the model and when it ran', () => {
    expect(describeLlmModel(done(0.1), 1_000_000 + 3 * 3_600_000)).toBe('google.claude-opus-5.5, evaluated 3 h ago');
    expect(describeLlmModel({ model: null, evaluatedAt: null })).toBeNull();
  });

  it('describeLlmQueue summarises the header numbers', () => {
    expect(describeLlmQueue({ pending: 4, done: 2, failed: 0 })).toBe('4 pending (~1 min)');
    expect(describeLlmQueue({ pending: 0, done: 2, failed: 1 })).toBe('up to date, 1 failed');
    expect(describeLlmQueue(undefined)).toBeNull();
    // the server's estimate (measured average, all users in turns) wins over the 8 s default
    expect(describeLlmQueue({ pending: 159, done: 0, failed: 0, etaSeconds: 1272 })).toBe('159 pending (~21 min)');
    expect(describeLlmQueue({ pending: 159, done: 0, failed: 0 })).toBe('159 pending (~21 min)');
    expect(describeLlmQueue({ pending: 2, done: 0, failed: 0, etaSeconds: 40 })).toBe('2 pending (~1 min)');
    expect(describeLlmQueue({ pending: 600, done: 0, failed: 0, etaSeconds: 7200 })).toBe('600 pending (~2 h)');
  });

  it('the llm parameter appears in the score breakdown like the others', () => {
    const { rows } = breakdownRows({
      overall: 7,
      scores: { rent: 9, llm: 7 },
      details: { llm: 'Nice room.' },
      missing: [],
    });
    expect(rows.find((r) => r.param === 'llm')).toEqual({ param: 'llm', score: 7, detail: 'Nice room.' });
  });
});

describe('#hiddenLabel', () => {
  it('says who hid the offer and why', async () => {
    const { hiddenLabel } = await import('../../ui/src/services/format.js');
    expect(hiddenLabel({ hidden: { by: 'user', reason: 'Not interested', at: 1 } })).toBe('Hidden by you');
    expect(hiddenLabel({ hidden: { by: 'program', reason: 'excluded keyword "Corps"', at: 1 } })).toBe(
      'Removed automatically: excluded keyword "Corps"',
    );
    expect(hiddenLabel({ hidden: { by: 'program', reason: 'LLM: likely Studentenverbindung (p=0.82)', at: 1 } })).toBe(
      'Removed automatically: LLM: likely Studentenverbindung',
    );
    expect(hiddenLabel({ hidden: { by: 'program', reason: null, at: 1 } })).toBe('Removed automatically');
    expect(hiddenLabel({ hidden: null })).toBeNull();
    expect(hiddenLabel({ dismissed: true })).toBe('Hidden by you'); // an older server without `hidden`
    expect(hiddenLabel({})).toBeNull();
  });

  it('reads "Messaged on <date>" for an offer hidden as messaged', async () => {
    const { hiddenLabel, messagedLabel, formatDay } = await import('../../ui/src/services/format.js');
    const at = new Date(2026, 9, 2, 15, 30).getTime();
    expect(formatDay(at)).toBe('2 October 2026');
    expect(hiddenLabel({ messagedAt: at, hidden: { by: 'user', reason: 'Messaged', at } })).toBe(
      'Messaged on 2 October 2026',
    );
    expect(messagedLabel({ messagedAt: at })).toBe('Messaged on 2 October 2026');
    expect(messagedLabel({ messagedAt: null })).toBeNull();
    expect(messagedLabel({})).toBeNull();
  });
});

describe('#eligibility label', () => {
  it('names the reason when the AI found the user not eligible, else nothing', async () => {
    const { eligibilityLabel } = await import('../../ui/src/services/format.js');
    expect(eligibilityLabel({ eligible: false, eligibilityReason: 'only women wanted' })).toBe(
      'Not eligible: only women wanted',
    );
    expect(eligibilityLabel({ eligible: false, eligibilityReason: '' })).toBe('Not eligible');
    expect(eligibilityLabel({ eligible: true })).toBeNull();
    expect(eligibilityLabel({})).toBeNull(); // assessed before eligibility existed
    expect(eligibilityLabel(null)).toBeNull();
  });

  it('isVerbindung: only flagged probabilities (from the badge threshold) count, unassessed never', () => {
    expect(isVerbindung(done(0.95), 0.3)).toBe(true);
    expect(isVerbindung(done(0.3), 0.3)).toBe(true);
    expect(isVerbindung(done(0.29), 0.3)).toBe(false);
    expect(isVerbindung(done(0), 0.3)).toBe(false);
    expect(isVerbindung({ status: 'pending' }, 0.3)).toBe(false);
    expect(isVerbindung(null, 0.3)).toBe(false);
  });

  it('scoreChip shows the metric of the current sort: base score, AI score or rent', () => {
    const item = {
      price: 650,
      evaluation: { overall: 8.4 },
      llm: done(0, { result: { ...done(0).result, fitScore: 6 } }),
    };
    expect(scoreChip(item, 'overall')).toEqual({ value: '8.4', label: '/ 10', bucket: 'good' });
    expect(scoreChip(item, 'ai')).toEqual({ value: '6', label: 'AI', bucket: 'ok' });
    expect(scoreChip(item, 'price')).toEqual({ value: '650 €', label: 'rent', bucket: 'neutral' });
    expect(scoreChip({ ...item, llm: { status: 'pending' } }, 'ai')).toEqual({
      value: '---',
      label: 'AI',
      bucket: 'none',
    });
    expect(scoreChip({ ...item, price: null }, 'price')).toEqual({ value: '---', label: 'rent', bucket: 'none' });
    // excluded listings stay grey in every mode
    const excluded = { ...item, evaluation: { overall: 1, excludedReason: 'x' } };
    expect(scoreChip(excluded, 'overall')).toEqual({ value: '1', label: 'excluded', bucket: 'excluded' });
    expect(scoreChip(excluded, 'ai').bucket).toBe('excluded');
    expect(scoreChip(excluded, 'price').bucket).toBe('excluded');
    // unknown sort falls back to the base score
    expect(scoreChip(item, 'whatever').label).toBe('/ 10');
  });

  describe('deductionRows', () => {
    const res = (fitScore, deductions) => ({ fitScore, deductions });

    it('sorts by points descending with a minus sign and drops fractions of zero', () => {
      expect(
        deductionRows(
          res(7, [
            { points: 1, reason: 'far from target (9 km)' },
            { points: 2, reason: 'Zweck-WG, little shared life' },
          ]),
        ),
      ).toEqual({
        perfect: false,
        rows: [
          {
            points: 2,
            label: '\u22122',
            reason: 'Zweck-WG, little shared life',
            text: '\u22122 Zweck-WG, little shared life',
          },
          { points: 1, label: '\u22121', reason: 'far from target (9 km)', text: '\u22121 far from target (9 km)' },
        ],
      });
      const half = deductionRows(res(9.5, [{ points: 0.5, reason: 'a' }])).rows[0];
      expect(half.text).toBe('\u22120.5 a');
      expect(half.label).toBe('\u22120.5'); // label = the bold red part, reason = the rest
    });

    it('summarises the collapsed list as count and total', () => {
      const rows = deductionRows(
        res(5.5, [
          { points: 2, reason: 'a' },
          { points: 1.5, reason: 'b' },
          { points: 1, reason: 'c' },
        ]),
      ).rows;
      expect(deductionSummary(rows)).toBe('3 points, −4.5');
      expect(deductionSummary(rows.slice(0, 1))).toBe('1 point, −2');
      expect(deductionSummary([])).toBe('');
    });

    it('is perfect for fitScore 10 without deductions, empty otherwise or without data', () => {
      expect(deductionRows(res(10, []))).toEqual({ perfect: true, rows: [] });
      expect(deductionRows(res(7, []))).toEqual({ perfect: false, rows: [] });
      expect(deductionRows({ fitScore: 7 })).toEqual({ perfect: false, rows: [] });
      expect(deductionRows(null)).toEqual({ perfect: false, rows: [] });
    });
  });
});
