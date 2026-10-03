import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { dismissListing, getUserListing } from '../../lib/services/listings/listingsStorage.js';
import { tierFor } from '../../lib/notify/tier.js';
import { refreshTiers, backfillTiers } from '../../lib/notify/tierStorage.js';
import { llmSettingsHash } from '../../lib/llm/settingsHash.js';
import { saveSettings } from '../../lib/services/settings/userSettingsStorage.js';
import { NOW, USER, HASH, MODEL, makeDirectory, seedAssessed } from './helpers.js';

const BOB = 'bob';
const TWO_USERS = [
  { username: USER, passwordHash: 'x', admin: true, email: null },
  { username: BOB, passwordHash: 'x', admin: false, email: 'bob@example.org' },
];
const RULES = {
  priority: { rules: [{ overall: { gt: 7 }, ai: { gt: 7 } }] },
  bulk: { rules: [{ overall: { gt: 5 }, ai: { gt: 5 } }] },
};
const tierOf = (userId, n) => getUserListing(userId, String(n)).tier;
const ctxOf = (directory, userId) => directory.context(userId);
const refresh = (directory, userId, opts) => {
  const ctx = ctxOf(directory, userId);
  return refreshTiers(userId, { notify: ctx.settings.notify, llmHash: ctx.llmHash }, opts);
};

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(() => Db.reset());

describe('#tierFor', () => {
  const v = (overall, ai, extra = {}) => ({ overall, ai, rent: 600, ...extra });
  it('is fantastic when the priority rules match (even if bulk matches too)', () => {
    expect(tierFor(RULES, v(8, 8))).toBe('fantastic');
  });
  it('is good when only the bulk rules match', () => {
    expect(tierFor(RULES, v(6, 6))).toBe('good');
    expect(tierFor(RULES, v(8, 6))).toBe('good');
  });
  it('is null when no rule matches or a value is missing', () => {
    expect(tierFor(RULES, v(4, 9))).toBeNull();
    expect(tierFor(RULES, v(8, null))).toBeNull();
    expect(tierFor(RULES, {})).toBeNull();
  });
  it('treats missing or empty rule lists as never matching', () => {
    expect(tierFor({ priority: { rules: [] }, bulk: { rules: [] } }, v(10, 10))).toBeNull();
    expect(tierFor({}, v(10, 10))).toBeNull();
  });
});

describe('#refreshTiers', () => {
  it('stores fantastic / good / null from the user rules', () => {
    const { directory } = makeDirectory();
    seedAssessed(1, { overall: 8.4, fit: 8 });
    seedAssessed(2, { overall: 6, fit: 6 });
    seedAssessed(3, { overall: 3, fit: 9 });
    refresh(directory, USER);
    expect(tierOf(USER, 1)).toBe('fantastic');
    expect(tierOf(USER, 2)).toBe('good');
    expect(tierOf(USER, 3)).toBeNull();
  });

  it('needs the AI assessment done for the current settings hash', () => {
    const { directory } = makeDirectory();
    seedAssessed(1, { assessed: false });
    seedAssessed(2, { settingsHash: llmSettingsHash({ model: MODEL, profile: 'another profile' }) });
    seedAssessed(3);
    refresh(directory, USER);
    expect(tierOf(USER, 1)).toBeNull();
    expect(tierOf(USER, 2)).toBeNull();
    expect(tierOf(USER, 3)).toBe('fantastic');
    expect(HASH).toBe(directory.context(USER).llmHash);
  });

  it('is null for an excluded listing', () => {
    const { directory } = makeDirectory();
    seedAssessed(1, { excluded: 'keyword: Zwischenmiete' });
    refresh(directory, USER);
    expect(tierOf(USER, 1)).toBeNull();
  });

  it('ignores hidden state and the age limit (those only restrict alerts)', () => {
    const { directory } = makeDirectory({ maxAgeHours: 1 });
    seedAssessed(1, { publishedAt: NOW - 90 * 86_400_000 });
    seedAssessed(2);
    dismissListing(USER, getUserListing(USER, '2').id, NOW);
    refresh(directory, USER);
    expect(tierOf(USER, 1)).toBe('fantastic');
    expect(tierOf(USER, 2)).toBe('fantastic');
  });

  it('can refresh a single listing', () => {
    const { directory } = makeDirectory();
    const a = seedAssessed(1);
    seedAssessed(2);
    refresh(directory, USER, { listingId: a });
    expect(tierOf(USER, 1)).toBe('fantastic');
    expect(tierOf(USER, 2)).toBeNull();
  });

  it('recomputes every row of the user when their rules change, and clears tiers that no longer match', () => {
    const { directory } = makeDirectory();
    seedAssessed(1, { overall: 8, fit: 8 });
    seedAssessed(2, { overall: 6, fit: 6 });
    refresh(directory, USER);
    expect([tierOf(USER, 1), tierOf(USER, 2)]).toEqual(['fantastic', 'good']);

    saveSettings(USER, {
      notify: { priority: { rules: [{ overall: { gt: 5 } }] }, bulk: { rules: [{ overall: { gt: 9 } }] } },
    });
    refresh(directory, USER);
    expect([tierOf(USER, 1), tierOf(USER, 2)]).toEqual(['fantastic', 'fantastic']);

    saveSettings(USER, { notify: { priority: { rules: [] }, bulk: { rules: [{ overall: { gt: 7 } }] } } });
    refresh(directory, USER);
    expect([tierOf(USER, 1), tierOf(USER, 2)]).toEqual(['good', null]);
  });

  it('keeps users apart: the same listing has each user own tier', () => {
    const { directory } = makeDirectory({}, TWO_USERS);
    seedAssessed(1, { userId: USER, overall: 8, fit: 8 });
    seedAssessed(1, { userId: BOB, overall: 8, fit: 8 });
    saveSettings(BOB, { notify: { priority: { rules: [{ overall: { gt: 9.5 } }] } } });
    refresh(directory, USER);
    refresh(directory, BOB);
    expect(tierOf(USER, 1)).toBe('fantastic');
    expect(tierOf(BOB, 1)).toBe('good');
    // refreshing one user never touches the other
    saveSettings(USER, { notify: { priority: { rules: [] }, bulk: { rules: [] } } });
    refresh(directory, USER);
    expect(tierOf(USER, 1)).toBeNull();
    expect(tierOf(BOB, 1)).toBe('good');
  });
});

describe('#backfillTiers', () => {
  it('fills the tier of every user from their current settings', () => {
    const { directory } = makeDirectory({}, TWO_USERS);
    seedAssessed(1, { userId: USER, overall: 8, fit: 8 });
    seedAssessed(2, { userId: BOB, overall: 6, fit: 6 });
    expect(tierOf(USER, 1)).toBeNull();
    backfillTiers(directory);
    expect(tierOf(USER, 1)).toBe('fantastic');
    expect(tierOf(BOB, 2)).toBe('good');
  });
});

describe('#tier filter (API, listings and stats)', () => {
  const hashOf = (directory, userId) => directory.context(userId).llmHash;
  async function seedThree() {
    const { directory } = makeDirectory({}, TWO_USERS);
    seedAssessed(1, { overall: 8, fit: 8 }); // fantastic
    seedAssessed(2, { overall: 6, fit: 6 }); // good
    seedAssessed(3, { overall: 3, fit: 3 }); // none
    seedAssessed(4, { overall: 9, fit: 9 }); // fantastic, hidden below
    dismissListing(USER, getUserListing(USER, '4').id, NOW);
    backfillTiers(directory);
    return directory;
  }
  const ids = (res) => res.items.map((i) => i.providerId).sort();

  it('/listings?tier= keeps only that tier and reports it on each item', async () => {
    const { queryListings } = await import('../../lib/services/listings/listingsStorage.js');
    await seedThree();
    const all = queryListings(USER, {}, NOW);
    expect(all.items.find((i) => i.providerId === '1').tier).toBe('fantastic');
    expect(all.items.find((i) => i.providerId === '3').tier).toBeNull();
    expect(ids(queryListings(USER, { tier: 'fantastic' }, NOW))).toEqual(['1']);
    expect(ids(queryListings(USER, { tier: 'good' }, NOW))).toEqual(['2']);
    expect(queryListings(USER, { tier: 'good' }, NOW).total).toBe(1);
  });

  it('stacks with the hidden switches and the recency window', async () => {
    const { queryListings } = await import('../../lib/services/listings/listingsStorage.js');
    await seedThree();
    expect(ids(queryListings(USER, { tier: 'fantastic', show: 'not_interested' }, NOW))).toEqual(['1', '4']);
    expect(ids(queryListings(USER, { tier: 'fantastic', show: 'not_interested', maxAgeHours: 0.01 }, NOW))).toEqual([]);
  });

  it('ignores an unknown tier value (no filter), like the other query parameters', async () => {
    const { queryListings } = await import('../../lib/services/listings/listingsStorage.js');
    await seedThree();
    expect(queryListings(USER, { tier: 'bogus' }, NOW).total).toBe(3);
    expect(queryListings(USER, { tier: '' }, NOW).total).toBe(3);
  });

  it('/stats?tier= counts exactly the rows /listings?tier= lists', async () => {
    const { queryListings } = await import('../../lib/services/listings/listingsStorage.js');
    const { queryStats } = await import('../../lib/services/listings/listingsStats.js');
    await seedThree();
    for (const tier of ['good', 'fantastic']) {
      expect(queryStats(USER, { tier }, NOW).total).toBe(queryListings(USER, { tier }, NOW).total);
    }
    expect(queryStats(USER, { tier: 'fantastic' }, NOW).total).toBe(1);
    expect(queryStats(USER, {}, NOW).total).toBe(3);
  });

  it("only looks at the asking user's tier", async () => {
    const { queryListings } = await import('../../lib/services/listings/listingsStorage.js');
    const directory = await seedThree();
    seedAssessed(1, { userId: BOB, overall: 8, fit: 8, settingsHash: hashOf(directory, BOB) });
    saveSettings(BOB, { notify: { priority: { rules: [] } } });
    backfillTiers(directory);
    expect(ids(queryListings(BOB, { tier: 'good' }, NOW))).toEqual(['1']);
    expect(ids(queryListings(BOB, { tier: 'fantastic' }, NOW))).toEqual([]);
    expect(ids(queryListings(USER, { tier: 'fantastic' }, NOW))).toEqual(['1']);
  });
});
