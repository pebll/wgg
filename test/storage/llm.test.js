import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery, openDbUpTo, setRow } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  getUserListing,
  queryListings,
  storeListingDetails,
  recordDetailFailure,
  dismissListing,
  selectLlmQueue,
  recordLlmResult,
  recordLlmFailure,
  markLlmSkipped,
  getLlmCounts,
  requeueDetails,
  selectNextPendingDetail,
  updateListingEvaluation,
} from '../../lib/services/listings/listingsStorage.js';

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const U = 'alice';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const listing = (id) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 600,
});
const page = (description = 'Zimmer\nSchön') => ({
  sections: [],
  description,
  costs: [],
  address: null,
  wgFacts: [],
  objectFacts: [],
});
const assessment = {
  verbindungProbability: 0.2,
  verbindungSignals: [],
  fitScore: 7,
  summary: 'ok',
  positives: [],
  redFlags: [],
};

const idOf = (providerId) => getListingByProviderId(String(providerId)).id;
const fetched = (id) => storeListingDetails(idOf(id), page(), NOW);

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
  storeNewListings([1, 2, 3, 4, 5].map(listing), SEARCH, NOW);
});
afterEach(() => Db.reset());

describe('#llm storage', () => {
  it('new listings start with llm pending, no result', () => {
    const row = getUserListing(U, '1');
    expect(row).toMatchObject({
      llm_status: 'pending',
      llm_json: null,
      llm_model: null,
      llm_error: null,
      llm_attempts: 0,
    });
    expect(queryListings(U, {}, NOW).items[0].llm).toMatchObject({ status: 'pending', result: null, model: null });
  });

  it('queue holds fetched pending listings, newest first, not dismissed', () => {
    fetched(1);
    fetched(2);
    fetched(3);
    dismissListing(U, idOf(3));
    expect(selectLlmQueue({ userId: U }).map((r) => r.provider_id)).toEqual(['2', '1']);
  });

  it('orders the queue by rule score desc (unscored last), then newest first', () => {
    for (const n of [1, 2, 3, 4]) fetched(n);
    const score = (n, v) => setRow(U, String(n), { overall_score: v });
    score(1, 5);
    score(2, 8);
    score(3, 8);
    // 4: unscored. All stored at the same time, so the id (newest = highest) breaks the tie.
    expect(selectLlmQueue({ userId: U }).map((r) => r.provider_id)).toEqual(['3', '2', '1', '4']);
  });

  it('marks listings without usable details as skipped with the reason "no description"', () => {
    recordDetailFailure(idOf(1), 'x', { maxAttempts: 1 }); // failed
    storeListingDetails(idOf(2), page(''), NOW); // fetched, empty description
    fetched(3);
    expect(selectLlmQueue({ userId: U }).map((r) => r.provider_id)).toEqual(['3']);
    expect(getUserListing(U, '1')).toMatchObject({ llm_status: 'skipped', llm_error: 'no description' });
    expect(getUserListing(U, '2')).toMatchObject({ llm_status: 'skipped', llm_error: 'no description' });
  });

  it('stores a result and exposes it through the API', () => {
    fetched(1);
    recordLlmResult(U, idOf(1), { ...assessment, model: 'm1', truncated: false }, NOW);
    const row = getUserListing(U, '1');
    expect(row).toMatchObject({
      llm_status: 'done',
      llm_model: 'm1',
      llm_evaluated_at: NOW,
      llm_error: null,
      llm_attempts: 1,
    });
    const api = queryListings(U, { pageSize: 10 }, NOW).items.find((i) => i.providerId === '1');
    expect(api.llm).toMatchObject({
      status: 'done',
      model: 'm1',
      evaluatedAt: NOW,
      result: { fitScore: 7, truncated: false },
    });
    expect(selectLlmQueue({ userId: U }).map((r) => r.provider_id)).not.toContain('1');
  });

  it('a failure stores the error and retries until maxAttempts', () => {
    fetched(1);
    recordLlmFailure(U, idOf(1), 'HTTP 500');
    expect(getUserListing(U, '1')).toMatchObject({ llm_status: 'failed', llm_error: 'HTTP 500', llm_attempts: 1 });
    expect(selectLlmQueue({ userId: U, maxAttempts: 3 }).map((r) => r.provider_id)).toEqual(['1']);
    recordLlmFailure(U, idOf(1), 'HTTP 500');
    recordLlmFailure(U, idOf(1), 'HTTP 500');
    expect(selectLlmQueue({ userId: U, maxAttempts: 3 })).toEqual([]);
  });

  it('stores the prompt version and settings hash and re-queues done listings made with other settings', () => {
    fetched(1);
    fetched(2);
    recordLlmResult(U, idOf(1), { ...assessment, model: 'm', promptVersion: 3, settingsHash: 'h3' }, NOW);
    recordLlmResult(U, idOf(2), { ...assessment, model: 'm' }, NOW); // legacy: no version, no hash
    expect(getUserListing(U, '1')).toMatchObject({ llm_prompt_version: 3, llm_settings_hash: 'h3' });
    expect(getUserListing(U, '2')).toMatchObject({ llm_prompt_version: null, llm_settings_hash: null });
    expect(selectLlmQueue({ userId: U })).toEqual([]); // without a hash to compare nothing is outdated
    expect(selectLlmQueue({ userId: U, settingsHash: 'h3' }).map((r) => r.provider_id)).toEqual(['2']);
    expect(selectLlmQueue({ userId: U, settingsHash: 'h4' }).map((r) => r.provider_id)).toEqual(['2', '1']);
    expect(getLlmCounts(U, 'h4')).toMatchObject({ pending: 2, done: 2 });
    expect(getLlmCounts(U).pending).toBe(0);
  });

  it('markLlmSkipped records the reason', () => {
    fetched(1);
    markLlmSkipped(U, idOf(1), 'excluded by rules: keyword');
    expect(getUserListing(U, '1')).toMatchObject({
      llm_status: 'skipped',
      llm_error: 'excluded by rules: keyword',
    });
  });

  it('ids select by provider id or row id; force re-queues finished ones', () => {
    fetched(1);
    fetched(2);
    recordLlmResult(U, idOf(1), { ...assessment, model: 'm' }, NOW);
    expect(selectLlmQueue({ userId: U, ids: ['1', '2'] }).map((r) => r.provider_id)).toEqual(['2']);
    expect(
      selectLlmQueue({ userId: U, ids: ['1', '2'], force: true })
        .map((r) => r.provider_id)
        .sort(),
    ).toEqual(['1', '2']);
    expect(selectLlmQueue({ userId: U, ids: [String(idOf(2))] }).map((r) => r.provider_id)).toEqual(['2']);
    expect(selectLlmQueue({ userId: U, force: true })).toHaveLength(2);
    expect(selectLlmQueue({ userId: U, force: true, limit: 1 })).toHaveLength(1);
  });

  it('counts pending (fetched details only), done and failed', () => {
    fetched(1);
    fetched(2);
    fetched(3);
    recordLlmResult(U, idOf(1), { ...assessment, model: 'm' }, NOW);
    recordLlmFailure(U, idOf(2), 'x');
    expect(getLlmCounts(U)).toEqual({ pending: 1, done: 1, failed: 1 });
  });

  it('pending counts only what the worker will actually send: not hidden, not excluded by the rules', () => {
    fetched(1);
    fetched(2);
    fetched(3);
    expect(getLlmCounts(U).pending).toBe(3);
    setRow(U, '2', { excluded_reason: 'excluded keyword "Corps"' });
    expect(getLlmCounts(U).pending).toBe(2);
    dismissListing(U, idOf(3));
    expect(getLlmCounts(U).pending).toBe(1);
  });

  it('requeueDetails puts skipped/failed listings back to pending, ignoring age; ids bypass the age limit', () => {
    recordDetailFailure(idOf(1), 'x', { maxAttempts: 1 });
    expect(requeueDetails(['1', String(idOf(2))])).toBe(2 - 1 /* #2 is already pending */);
    expect(getListingByProviderId('1')).toMatchObject({ details_status: 'pending', details_attempts: 0 });
    const far = NOW + 60 * 86_400_000;
    expect(selectNextPendingDetail({ now: far, maxAgeDays: 7, ids: ['1'] }).provider_id).toBe('1');
    expect(getListingByProviderId('2').details_status).toBe('pending'); // not skipped: ids mode leaves others alone
    dismissListing(U, idOf(1));
    expect(selectNextPendingDetail({ now: far, maxAgeDays: 7, ids: ['1'] }).provider_id).toBe('1'); // explicit ids win
  });
});

describe('#llm status of listings without a description', () => {
  const llm = (userId, pid) => {
    const r = getUserListing(userId, String(pid));
    return [r.llm_status, r.llm_error];
  };
  const evaluation = { overall: 5, scores: {}, details: {}, missing: [] };

  it('a detail failure that gives up marks every user\'s pending AI row skipped "no description"', () => {
    giveQuery('bob', SEARCH);
    getUserListing(U, '1');
    markPending(U, 1);
    markPending('bob', 1);
    recordDetailFailure(idOf(1), 'x', { maxAttempts: 2 }); // still pending: retry later
    expect(llm(U, 1)).toEqual(['pending', null]);
    recordDetailFailure(idOf(1), 'x', { maxAttempts: 2 }); // failed
    expect(llm(U, 1)).toEqual(['skipped', 'no description']);
    expect(llm('bob', 1)).toEqual(['skipped', 'no description']);
  });

  it('a too-old listing whose details are skipped never keeps the AI status pending', () => {
    markPending(U, 1);
    selectNextPendingDetail({ now: NOW + 60 * 86_400_000, maxAgeDays: 7 });
    expect(getListingByProviderId('1').details_status).toBe('skipped');
    expect(llm(U, 1)).toEqual(['skipped', 'no description']);
  });

  it('a row created for a user later (evaluation) is born skipped when the details are skipped or failed', () => {
    recordDetailFailure(idOf(1), 'x', { maxAttempts: 1 });
    updateListingEvaluation('bob', idOf(1), evaluation, NOW);
    expect(llm('bob', 1)).toEqual(['skipped', 'no description']);
    updateListingEvaluation('bob', idOf(2), evaluation, NOW); // details still pending: stays pending
    expect(llm('bob', 2)).toEqual(['pending', null]);
  });

  it('never counts them as pending, and re-queues them when the details arrive later', () => {
    markPending(U, 1);
    recordDetailFailure(idOf(1), 'x', { maxAttempts: 1 });
    expect(getLlmCounts(U).pending).toBe(0);
    requeueDetails(['1']);
    fetched(1);
    expect(llm(U, 1)).toEqual(['pending', null]);
    expect(getLlmCounts(U).pending).toBe(1);
  });

  it('does not touch rows skipped for another reason, nor finished ones, when details arrive', () => {
    markLlmSkipped(U, idOf(1), 'excluded by rules: x');
    fetched(1);
    expect(llm(U, 1)).toEqual(['skipped', 'excluded by rules: x']);
  });

  it('migration 16 fixes existing rows once', async () => {
    await openDbUpTo(15);
    for (const id of [1, 2, 3]) {
      Db.execute('INSERT INTO listings (provider_id, search_url, link, first_seen_at) VALUES (?, ?, ?, ?)', [
        String(id),
        SEARCH,
        `https://www.wg-gesucht.de/x.${id}.html`,
        NOW,
      ]);
    }
    Db.execute(`UPDATE listings SET details_status = 'skipped' WHERE provider_id = '1'`);
    Db.execute(`UPDATE listings SET details_status = 'failed' WHERE provider_id = '2'`);
    for (const id of [1, 2, 3]) {
      Db.execute(
        `INSERT INTO user_listings (user_id, listing_id) SELECT 'alice', id FROM listings WHERE provider_id = ?`,
        [String(id)],
      );
    }
    await runMigrations();
    expect(llm('alice', 1)).toEqual(['skipped', 'no description']);
    expect(llm('alice', 2)).toEqual(['skipped', 'no description']);
    expect(llm('alice', 3)).toEqual(['pending', null]);
  });
});

function markPending(userId, providerId) {
  Db.execute(`INSERT OR IGNORE INTO user_listings (user_id, listing_id) VALUES (@userId, @id)`, {
    userId,
    id: idOf(providerId),
  });
}
