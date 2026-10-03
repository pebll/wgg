import { describe, it, expect } from 'vitest';
import { demoListings, demoStats, demoWeights, DEMO_PARAMETERS, demoEmail } from '../../ui/src/services/demo.js';
import {
  aiScore,
  hiddenLabel,
  isNewListing,
  isVerbindung,
  safeLink,
  scoreBucket,
  verbindungBadge,
} from '../../ui/src/services/format.js';
import { pieSlices } from '../../ui/src/services/pie.js';
import { barGeometry, describeHistogram } from '../../ui/src/services/histogram.js';

const NOW = Date.UTC(2026, 9, 2, 12, 0);

describe('#ui presentation demo data', () => {
  const { scoring, verbindung } = demoListings(NOW);

  it('is fictional: no photo, no link, no real id', () => {
    for (const item of [scoring, verbindung]) {
      expect(item.id).toBeLessThan(0);
      expect(safeLink(item.image)).toBeNull();
      expect(JSON.stringify(item)).not.toMatch(/https?:|wg-gesucht/i);
    }
  });

  it('has a fantastic, brand-new, well-scored example for the scoring section', () => {
    expect(scoring.tier).toBe('fantastic');
    expect(isNewListing(scoring, NOW)).toBe(true);
    expect(scoreBucket(scoring.evaluation)).toBe('good');
    expect(aiScore(scoring.llm)).toBeGreaterThanOrEqual(8);
    expect(scoring.distanceKm).toBeGreaterThan(0);
    expect(scoring.llm.result.positives.length).toBeGreaterThan(0);
    expect(scoring.llm.result.redFlags.length).toBeGreaterThan(0);
    expect(scoring.llm.result.eligible).toBe(true);
  });

  it('has a Verbindung example flagged (no percentage) with quoted signals, removed automatically', () => {
    expect(isVerbindung(verbindung.llm, 0.3)).toBe(true);
    expect(verbindungBadge(verbindung.llm, 0.3)).toMatchObject({ text: 'Verbindung !', tone: 'high' });
    expect(verbindung.llm.result.verbindungSignals.length).toBeGreaterThanOrEqual(2);
    expect(hiddenLabel(verbindung)).toMatch(/^Removed automatically: .*Studentenverbindung/);
  });

  it('has no flatmates example and no stored percentage in the removal reason', () => {
    expect(demoListings(NOW).flat).toBeUndefined();
    expect(verbindung.hidden.reason).not.toMatch(/[0-9]/);
  });

  it('is relative to now, so the NEW tag never goes stale', () => {
    const later = demoListings(NOW + 5 * 3_600_000);
    expect(isNewListing(later.scoring, NOW + 5 * 3_600_000)).toBe(true);
  });
});

describe('#ui presentation demo charts', () => {
  const stats = demoStats();
  it('has four charts of contiguous, non-empty bins', () => {
    expect(Object.keys(stats)).toEqual(['score', 'ai', 'rent', 'distance']);
    for (const { bins } of Object.values(stats)) {
      expect(bins.length).toBeGreaterThan(3);
      bins.forEach((bin, i) => {
        expect(bin.to).toBeGreaterThan(bin.from);
        if (i > 0) expect(bin.from).toBe(bins[i - 1].to);
      });
      expect(bins.some((b) => b.count > 0)).toBe(true);
      expect(barGeometry(bins, { width: 240, height: 96 }).bars).toHaveLength(bins.length);
    }
    expect(describeHistogram('Rent', stats.rent.bins, 'rent')).toMatch(/offers/);
  });
});

describe('#ui presentation demo settings', () => {
  it('has one positive weight per parameter, in the order of the parameter list', () => {
    const weights = demoWeights();
    expect(DEMO_PARAMETERS.map(([key]) => key)).toEqual(Object.keys(weights));
    expect(pieSlices(DEMO_PARAMETERS.map(([key]) => ({ key, value: weights[key] })))).toHaveLength(
      DEMO_PARAMETERS.length,
    );
  });
  it('has an email preview for each alert kind', () => {
    const fantastic = demoEmail('fantastic');
    const good = demoEmail('good');
    expect(fantastic.subject).toMatch(/^✦ Fantastic:/);
    expect(good.subject).toMatch(/good offers? — WG Gefunden!$/);
    expect(good.items.length).toBeGreaterThan(1);
    expect(fantastic.items).toHaveLength(1);
  });
});
