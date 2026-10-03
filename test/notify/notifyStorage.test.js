import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  dismissListing,
  getListingByProviderId,
  getUserListing,
  markLlmSkipped,
} from '../../lib/services/listings/listingsStorage.js';
import {
  selectNotifyCandidates,
  claimNotified,
  releaseNotified,
  notifyValues,
  MAX_NOTIFY_ATTEMPTS,
} from '../../lib/notify/notifyStorage.js';
import { NOW, USER, HASH, seedAssessed } from './helpers.js';

const base = { userId: USER, now: NOW, maxAgeHours: 24, settingsHash: HASH };
const ids = (opts = {}) => selectNotifyCandidates({ ...base, ...opts }).map((r) => r.provider_id);

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(() => Db.reset());

describe('#notify candidates', () => {
  it('selects assessed, visible, recent, not yet notified listings', () => {
    seedAssessed(1);
    expect(ids()).toEqual(['1']);
  });

  it('skips listings without a finished assessment made with the current AI settings', () => {
    seedAssessed(1, { assessed: false });
    seedAssessed(2, { settingsHash: 'stale' });
    seedAssessed(3);
    markLlmSkipped(USER, getListingByProviderId('3').id, 'excluded by rules: x');
    expect(ids()).toEqual([]);
  });

  it('skips excluded listings and listings hidden by the user, by the program, or as messaged', () => {
    seedAssessed(1, { excluded: 'keyword' });
    seedAssessed(2);
    dismissListing(USER, getListingByProviderId('2').id, NOW, 'not_interested');
    seedAssessed(3);
    dismissListing(USER, getListingByProviderId('3').id, NOW, 'messaged');
    seedAssessed(4);
    Db.execute(
      `UPDATE user_listings SET hidden_at = @now, hidden_by = 'program', hidden_reason = 'low'
       WHERE listing_id = (SELECT id FROM listings WHERE provider_id = '4')`,
      { now: NOW },
    );
    seedAssessed(5);
    expect(ids()).toEqual(['5']);
  });

  it('skips listings older than maxAgeHours (posting time first, first seen as fallback)', () => {
    seedAssessed(1, { publishedAt: NOW - 30 * 3_600_000 });
    seedAssessed(2, { publishedAt: NOW - 23 * 3_600_000 });
    expect(ids()).toEqual(['2']);
    expect(ids({ maxAgeHours: 1 })).toEqual([]);
    Db.execute(`UPDATE listings SET published_at = NULL WHERE provider_id = '1'`);
    // first seen is 2 h before NOW
    expect(ids({ maxAgeHours: 3 })).toContain('1');
    expect(ids({ maxAgeHours: 1 })).not.toContain('1');
  });

  it('can be limited to one listing', () => {
    seedAssessed(1);
    seedAssessed(2);
    expect(ids({ providerId: '2' })).toEqual(['2']);
  });

  it('exposes the rule values of a row', () => {
    seedAssessed(1, { overall: 7.5, fit: 6, price: 640, size: 20, distanceKm: 2.5, verbindung: 0.3 });
    expect(notifyValues(selectNotifyCandidates({ ...base })[0])).toEqual({
      overall: 7.5,
      ai: 6,
      rent: 640,
      size: 20,
      distanceKm: 2.5,
      verbindungProbability: 0.3,
    });
  });
});

describe('#notify marking', () => {
  it('claims a listing exactly once', () => {
    seedAssessed(1);
    const id = getListingByProviderId('1').id;
    expect(claimNotified(USER, id, 'priority', NOW)).toBe(true);
    expect(claimNotified(USER, id, 'bulk', NOW + 1)).toBe(false);
    const row = getUserListing(USER, '1');
    expect(row).toMatchObject({ notified_at: NOW, notified_kind: 'priority', notify_error: null });
    expect(ids()).toEqual([]);
  });

  it('release makes a failed send retryable, with the error stored, up to the attempt limit', () => {
    seedAssessed(1);
    const id = getListingByProviderId('1').id;
    for (let i = 1; i <= MAX_NOTIFY_ATTEMPTS; i++) {
      expect(ids()).toEqual(['1']);
      expect(claimNotified(USER, id, 'bulk', NOW)).toBe(true);
      releaseNotified(USER, [id], `smtp down ${i}`);
      const row = getUserListing(USER, '1');
      expect(row).toMatchObject({ notified_at: null, notified_kind: null, notify_error: `smtp down ${i}` });
      expect(row.notify_attempts).toBe(i);
    }
    expect(ids()).toEqual([]);
  });
});
