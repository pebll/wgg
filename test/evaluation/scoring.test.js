import { describe, it, expect } from 'vitest';
import { RuleBasedEvaluator } from '../../lib/evaluation/ruleBasedEvaluator.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { extractNumber } from '../../lib/utils/extract-number.js';
import { parseAvailability } from '../../lib/provider/wgGesucht.js';

const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const HOUR = 3_600_000;

const config = defaultEvaluationConfig();
const evaluator = new RuleBasedEvaluator(config);
const evaluate = (listing, ctx = {}) => evaluator.evaluate(listing, { now: NOW, ...ctx });

const good = {
  title: 'Schönes WG-Zimmer',
  price: 450,
  size: 20,
  district: 'München Maxvorstadt',
  street: 'Königinstraße 49',
  distanceKm: 1.5,
  geoPrecision: 'address',
  publishedAt: NOW,
  firstSeenAt: NOW,
  availableFrom: '2026-10-02',
  availableUntil: null,
};

describe('RuleBasedEvaluator', () => {
  it('has the Evaluator shape', () => {
    expect(evaluator.name).toBe('rule-based');
    expect(typeof evaluator.evaluate).toBe('function');
  });

  it('gives a perfect listing 10 everywhere', () => {
    const r = evaluate(good);
    expect(r.scores).toEqual({ rent: 10, distance: 10, size: 10, recency: 10, stayLength: 10 });
    expect(r.overall).toBe(10);
    expect(r.missing).toEqual([]);
    expect(r.excluded).toBeUndefined();
    expect(Object.keys(r.details).sort()).toEqual(Object.keys(r.scores).sort());
  });

  it('scores rent linearly between best and worst and clamps', () => {
    expect(evaluate({ ...good, price: 600 }).scores.rent).toBe(5.5);
    expect(evaluate({ ...good, price: 750 }).scores.rent).toBe(1);
    expect(evaluate({ ...good, price: 800 }).scores.rent).toBe(1);
    expect(evaluate({ ...good, price: 200 }).scores.rent).toBe(10);
  });

  it('scores distance, size and recency linearly', () => {
    expect(evaluate({ ...good, distanceKm: 10 }).scores.distance).toBe(1);
    expect(evaluate({ ...good, distanceKm: 5.75 }).scores.distance).toBe(5.5);
    expect(evaluate({ ...good, size: 9 }).scores.size).toBe(1);
    expect(evaluate({ ...good, size: 14.5 }).scores.size).toBe(5.5);
    expect(evaluate({ ...good, publishedAt: NOW - 72 * HOUR }).scores.recency).toBe(1);
    expect(evaluate({ ...good, publishedAt: NOW - 36 * HOUR }).scores.recency).toBe(5.5);
    expect(evaluate({ ...good, publishedAt: NOW + HOUR }).scores.recency).toBe(10); // clock skew
  });

  it('falls back to first_seen_at for recency and says so', () => {
    const r = evaluate({ ...good, publishedAt: null, firstSeenAt: NOW - 36 * HOUR });
    expect(r.scores.recency).toBe(5.5);
    expect(r.details.recency).toMatch(/first seen/i);
  });

  it('computes the weighted overall with one decimal', () => {
    // rent 5.5 (w3) + all other 10: (3*5.5 + 3*10 + 2*10 + 1.5*10 + 1.5*10) / 11
    const r = evaluate({ ...good, price: 600 });
    expect(r.overall).toBe(Math.round(((3 * 5.5 + 30 + 20 + 15 + 15) / 11) * 10) / 10);
  });

  describe('missing data', () => {
    it('excludes a missing price from the average and lists it', () => {
      const r = evaluate({ ...good, price: null });
      expect(r.missing).toEqual(['rent']);
      expect(r.scores.rent).toBeUndefined();
      expect(r.overall).toBe(10);
      expect(r.excluded).toBeUndefined();
    });

    it('treats a missing address (no distance) as missing, not zero', () => {
      const r = evaluate({ ...good, distanceKm: null, geoPrecision: null, street: null });
      expect(r.missing).toEqual(['distance']);
      expect(r.details.distance).toBeUndefined();
    });

    it('notes district precision in the distance detail', () => {
      expect(evaluate({ ...good, geoPrecision: 'district' }).details.distance).toMatch(/district/);
    });

    it('returns overall null when nothing is scorable', () => {
      const r = evaluate({ title: 'x', availableUntil: 'garbage' });
      expect(r.overall).toBeNull();
      expect(r.scores).toEqual({});
      expect(r.missing.sort()).toEqual(['distance', 'recency', 'rent', 'size', 'stayLength']);
    });
  });

  describe('German formats and availability text', () => {
    it('handles "1.250 €": there is no rent cap, the rent just scores 1 (the search query limits the rent)', () => {
      const r = evaluate({ ...good, price: extractNumber('1.250 €') });
      expect(r.excluded).toBeUndefined();
      expect(r.scores.rent).toBe(1);
      expect(r.overall).toBeLessThan(10);
    });

    it('does not penalize any move-in date (no availability parameter)', () => {
      for (const availableFrom of [null, '2026-10-02', '2026-11-01', '2027-07-01', '2026-07-01']) {
        const r = evaluate({ ...good, availableFrom });
        expect(r.overall).toBe(10);
        expect(r.scores).not.toHaveProperty('availability');
      }
    });

    it('"ab sofort" and "ab 01.11.2026" without an end date are unbefristet', () => {
      const sofort = evaluate({ ...good, availableFrom: null, availabilityRaw: 'ab sofort' });
      expect(sofort.scores.stayLength).toBe(10);
      const ab = parseAvailability('ab 01.11.2026');
      const r = evaluate({ ...good, availableFrom: ab.from, availableUntil: ab.until });
      expect(r.scores.stayLength).toBe(10);
    });
  });

  describe('stayLength (temporary listings)', () => {
    const temp = (from, until) => evaluate({ ...good, availableFrom: from, availableUntil: until }).scores.stayLength;

    it('is 10 for stays of at least minStayDays', () => {
      expect(temp('2026-10-05', '2027-01-05')).toBe(10); // 92 days
    });
    it('is 1 for stays under 30 days', () => {
      expect(temp('2026-10-05', '2026-10-25')).toBe(1);
      expect(temp('2026-10-05', '2026-10-05')).toBe(1);
    });
    it('is linear in between', () => {
      // 60 days: halfway between 30 and 90 -> 1 + 9 * 0.5
      expect(temp('2026-10-05', '2026-12-04')).toBe(5.5);
    });
    it('counts from today when the start is in the past or unknown', () => {
      expect(temp(null, '2026-10-22')).toBe(1); // 20 days from 2026-10-02
      expect(temp('2026-09-01', '2026-12-01')).toBe(5.5); // 60 days from today
    });
  });

  describe('exclusions', () => {
    it('excludes keyword matches (case-insensitive, whole word) in the title', () => {
      for (const kw of [
        'Studentenverbindung',
        'Verbindungshaus',
        'Burschenschaft',
        'Corps',
        'Landsmannschaft',
        'Bundesbrüder',
        'Aktivitas',
      ]) {
        const r = evaluate({ ...good, title: `Zimmer in ${kw.toUpperCase()} Haus` });
        expect(r.excluded).toContain(kw);
        expect(r.overall).toBe(1);
      }
    });

    it('searches the raw details text too', () => {
      expect(evaluate({ ...good, detailsRaw: '2er WG | Burschenschaft' }).excluded).toMatch(/Burschenschaft/);
    });

    it('does not flag the ordinary word "Verbindung" (public transport) any more', () => {
      expect(evaluate({ ...good, title: 'Gute Verbindung zur U-Bahn' }).excluded).toBeUndefined();
      expect(evaluate({ ...good, description: 'Sehr gute Verbindung in die Stadt' }).excluded).toBeUndefined();
    });

    it('also searches the full description once it is known', () => {
      const r = evaluate({ ...good, description: 'Wir sind ein Verbindungshaus mit Tradition.' });
      expect(r.excluded).toMatch(/Verbindungshaus/);
      expect(r.overall).toBe(1);
    });

    it('does not match inside other words', () => {
      expect(evaluate({ ...good, title: 'Super Verkehrsverbindung und Corpsman' }).excluded).toBeUndefined();
    });

    it('names the keyword only; an expensive rent is no reason', () => {
      const r = evaluate({ ...good, price: 900, title: 'Burschenschaft Corps' });
      expect(r.excluded).toMatch(/Burschenschaft/);
      expect(r.excluded).not.toMatch(/rent/);
    });
  });

  it('a zero weight disables a parameter entirely', () => {
    const off = new RuleBasedEvaluator({ ...config, weights: { ...config.weights, size: 0 } });
    const r = off.evaluate({ ...good, size: null }, { now: NOW });
    expect(r.scores).not.toHaveProperty('size');
    expect(r.missing).not.toContain('size');
  });

  it('the WG size is a listing fact, not a scoring parameter', () => {
    const r = evaluate({ ...good, wgSize: 12 });
    expect(r.scores).not.toHaveProperty('wgSize');
    expect(r.overall).toBe(10);
    const odd = new RuleBasedEvaluator({ ...config, weights: { ...config.weights, wgSize: 5 } });
    expect(odd.evaluate({ ...good, wgSize: 12 }, { now: NOW }).scores).not.toHaveProperty('wgSize');
  });

  it('is pure: same input, same output', () => {
    expect(evaluate(good)).toEqual(evaluate(good));
  });
});
