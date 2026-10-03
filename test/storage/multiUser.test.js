import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  queryListings,
  dismissListing,
  restoreListing,
  updateListingEvaluation,
  recordLlmFailure,
  markLlmSkipped,
  selectLlmQueue,
  getLlmCounts,
  getDetailCounts,
  selectNextPendingDetail,
  selectRowsForEvaluation,
  getUserListing,
  storeNewListings,
  getListingByProviderId,
} from '../../lib/services/listings/listingsStorage.js';
import { queryStats } from '../../lib/services/listings/listingsStats.js';
import { selectNotifyCandidates, claimNotified } from '../../lib/notify/notifyStorage.js';
import { ALICE, BOB, SEARCH, NOW, openDb, giveQuery, seedListing, seedAssessedFor, Db } from '../helpers/db.js';

const OTHER = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';
const CAROL = 'carol';
const ids = (userId, query = {}) =>
  queryListings(userId, query, NOW)
    .items.map((i) => i.providerId)
    .sort();
const result = (overall, excluded) => ({
  scores: {},
  overall,
  missing: [],
  details: {},
  ...(excluded ? { excluded } : {}),
});

describe('#multi-user storage: nobody sees or changes another user', () => {
  let id; // provider id -> row id
  beforeEach(async () => {
    await openDb();
    giveQuery(ALICE, SEARCH);
    giveQuery(BOB, OTHER);
    id = {
      1: seedListing(1, SEARCH),
      2: seedListing(2, SEARCH),
      3: seedListing(3, OTHER),
      4: seedListing(4, SEARCH),
    };
    storeNewListings([{ providerId: '4', link: 'https://www.wg-gesucht.de/x.4.html', title: 'Room 4' }], OTHER, NOW);
  });
  afterEach(() => Db.reset());

  it('a user sees exactly the listings found by their enabled queries', () => {
    expect(ids(ALICE)).toEqual(['1', '2', '4']);
    expect(ids(BOB)).toEqual(['3', '4']);
    expect(ids(CAROL)).toEqual([]);
  });

  it('records which query found a listing, also when another query stored it first', () => {
    const urls = Db.query('SELECT query_url FROM listing_queries WHERE listing_id = ? ORDER BY query_url', [id[4]]).map(
      (r) => r.query_url,
    );
    expect(urls).toEqual([OTHER, SEARCH].sort());
  });

  it('hiding is private: the other user still sees the listing, and a listing outside the view cannot be hidden', () => {
    expect(dismissListing(ALICE, id[4], NOW)).toBe(true);
    expect(ids(ALICE)).toEqual(['1', '2']);
    expect(ids(BOB)).toEqual(['3', '4']);
    expect(dismissListing(BOB, id[1], NOW)).toBe(false); // alice's listing, not in bob's view
    expect(ids(ALICE)).toEqual(['1', '2']);
    expect(Db.query('SELECT 1 FROM user_listings WHERE user_id = ?', [BOB])).toEqual([]);
    expect(restoreListing(BOB, id[1])).toBe(false);
    expect(restoreListing(ALICE, id[4])).toBe(true);
    expect(ids(ALICE)).toEqual(['1', '2', '4']);
  });

  it('messaged is private and keeps a listing visible for the user who messaged it, even without a query', () => {
    dismissListing(ALICE, id[1], NOW, 'messaged');
    expect(getUserListing(ALICE, '1').messaged_at).toBe(NOW);
    expect(getUserListing(BOB, '1').messaged_at).toBeNull();
    Db.execute('UPDATE user_queries SET enabled = 0 WHERE user_id = ?', [ALICE]);
    expect(ids(ALICE, { show: 'messaged' })).toEqual(['1']);
    expect(ids(ALICE, { show: 'messaged' }).includes('2')).toBe(false);
  });

  it('every user gets their own evaluation, score filter and sort over the same listing', () => {
    updateListingEvaluation(ALICE, id[4], result(9), NOW, { distanceKm: 1 });
    updateListingEvaluation(BOB, id[4], result(3), NOW, { distanceKm: 40 });
    const score = (user) => queryListings(user, {}, NOW).items.find((i) => i.providerId === '4').evaluation.overall;
    expect(score(ALICE)).toBe(9);
    expect(score(BOB)).toBe(3);
    expect(ids(ALICE, { minScore: 8 })).toEqual(['4']);
    expect(ids(BOB, { minScore: 8 })).toEqual([]);
    expect(queryListings(ALICE, {}, NOW).items.find((i) => i.providerId === '4').distanceKm).toBe(1);
    expect(queryListings(BOB, {}, NOW).items.find((i) => i.providerId === '4').distanceKm).toBe(40);
  });

  it('a program exclusion hides the listing only for the user whose rules excluded it', () => {
    updateListingEvaluation(ALICE, id[4], result(1, 'excluded keyword "Corps"'), NOW);
    updateListingEvaluation(BOB, id[4], result(7), NOW);
    expect(ids(ALICE)).toEqual(['1', '2']);
    expect(ids(BOB)).toEqual(['3', '4']);
    expect(queryListings(ALICE, {}, NOW).hiddenAutomatically).toBe(1);
    expect(queryListings(BOB, {}, NOW).hiddenAutomatically).toBe(0);
  });

  it("statistics count only the user's own view and scores", () => {
    updateListingEvaluation(ALICE, id[1], result(8), NOW, { distanceKm: 2 });
    updateListingEvaluation(BOB, id[3], result(5), NOW, { distanceKm: 3 });
    expect(queryStats(ALICE, {}, NOW).total).toBe(3);
    expect(queryStats(BOB, {}, NOW).total).toBe(2);
    expect(queryStats(ALICE, {}, NOW).score.bins.reduce((n, b) => n + b.count, 0)).toBe(1);
    expect(queryStats(CAROL, {}, NOW).total).toBe(0);
  });

  it('LLM state is per user: a result, failure or skip for one never shows for the other', () => {
    seedAssessedFor(ALICE, id[4], { fit: 9 });
    expect(getUserListing(ALICE, '4').llm_status).toBe('done');
    expect(getUserListing(BOB, '4').llm_status).toBe('pending');
    const bobItem = queryListings(BOB, {}, NOW).items.find((i) => i.providerId === '4');
    expect(bobItem.llm).toMatchObject({ status: 'pending', result: null });
    recordLlmFailure(BOB, id[4], 'boom');
    expect(getUserListing(ALICE, '4').llm_error).toBeNull();
    markLlmSkipped(ALICE, id[1], 'no description');
    expect(getUserListing(BOB, '1')?.llm_status ?? 'pending').toBe('pending');
    expect(getLlmCounts(ALICE, 'h1')).toEqual({ pending: 0, done: 1, failed: 0 });
    expect(getLlmCounts(BOB, 'h1')).toEqual({ pending: 0, done: 0, failed: 1 });
  });

  it("the LLM queue holds only the user's own listings, ordered by their own score, requeued per their settings hash", () => {
    for (const n of [1, 2, 4]) {
      seedAssessedFor(ALICE, id[n], { overall: n, settingsHash: 'old' });
    }
    Db.execute("UPDATE user_listings SET llm_status = 'pending' WHERE user_id = ?", [ALICE]);
    const queue = selectLlmQueue({ userId: ALICE });
    expect(queue.map((r) => r.provider_id)).toEqual(['4', '2', '1']); // highest ALICE score first
    // Details are global: listing 4 (shared) has them, so it is pending for bob too, with bob's own (empty) state.
    expect(selectLlmQueue({ userId: BOB }).map((r) => r.provider_id)).toEqual(['4']);
    // done with another settings hash (e.g. the profile changed) is queued again; the same hash is not
    Db.execute("UPDATE user_listings SET llm_status = 'done' WHERE user_id = ?", [ALICE]);
    expect(selectLlmQueue({ userId: ALICE, settingsHash: 'old' })).toEqual([]);
    expect(selectLlmQueue({ userId: ALICE, settingsHash: 'new' })).toHaveLength(3);
    expect(getLlmCounts(ALICE, 'new').pending).toBe(3);
    expect(getLlmCounts(BOB, 'new').pending).toBe(1);
  });

  it('alert candidates and the claim are per user: announcing to one user does not mark the listing for the other', () => {
    seedAssessedFor(ALICE, id[4], { overall: 9, fit: 9, settingsHash: 'h1' });
    seedAssessedFor(BOB, id[4], { overall: 9, fit: 9, settingsHash: 'h1' });
    const candidates = (userId) =>
      selectNotifyCandidates({ userId, now: NOW, maxAgeHours: 48, settingsHash: 'h1' }).map((r) => r.provider_id);
    expect(candidates(ALICE)).toEqual(['4']);
    expect(candidates(BOB)).toEqual(['4']);
    expect(claimNotified(ALICE, id[4], 'priority', NOW)).toBe(true);
    expect(claimNotified(ALICE, id[4], 'priority', NOW)).toBe(false);
    expect(candidates(ALICE)).toEqual([]);
    expect(candidates(BOB)).toEqual(['4']);
    expect(claimNotified(BOB, id[4], 'bulk', NOW)).toBe(true);
    expect(getUserListing(BOB, '4').notified_kind).toBe('bulk');
    expect(getUserListing(ALICE, '4').notified_kind).toBe('priority');
  });

  it('a wrong settings hash keeps a listing out of the alerts', () => {
    seedAssessedFor(ALICE, id[4], { settingsHash: 'old' });
    expect(selectNotifyCandidates({ userId: ALICE, now: NOW, maxAgeHours: 48, settingsHash: 'new' })).toEqual([]);
  });

  it('header counts are per user', () => {
    expect(getDetailCounts({ userId: ALICE, now: NOW, maxAgeDays: 7 })).toEqual({ pending: 3, fetched: 0, failed: 0 });
    expect(getDetailCounts({ userId: BOB, now: NOW, maxAgeDays: 7 })).toEqual({ pending: 2, fetched: 0, failed: 0 });
    expect(getDetailCounts({ userId: CAROL, now: NOW, maxAgeDays: 7 })).toEqual({ pending: 0, fetched: 0, failed: 0 });
  });

  it("selectRowsForEvaluation returns only the user's view with their own state", () => {
    updateListingEvaluation(ALICE, id[1], result(5), NOW);
    expect(selectRowsForEvaluation({ userId: ALICE }).map((r) => r.provider_id)).toEqual(['1', '2', '4']);
    expect(selectRowsForEvaluation({ userId: ALICE, onlyUnevaluated: true }).map((r) => r.provider_id)).toEqual([
      '2',
      '4',
    ]);
    expect(selectRowsForEvaluation({ userId: BOB, onlyUnevaluated: true }).map((r) => r.provider_id)).toEqual([
      '3',
      '4',
    ]);
  });

  it('the detail queue serves the listing the best-scoring user wants first, skips listings nobody wants', () => {
    updateListingEvaluation(ALICE, id[1], result(4), NOW);
    updateListingEvaluation(BOB, id[3], result(9), NOW); // best score of any user
    updateListingEvaluation(ALICE, id[2], result(6), NOW);
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }).provider_id).toBe('3');
    // bob hides 3 (and 4): nobody else wants 3 any more
    dismissListing(BOB, id[3], NOW);
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }).provider_id).toBe('2');
    dismissListing(ALICE, id[2], NOW);
    dismissListing(ALICE, id[1], NOW);
    // 4 is found by both; alice hid nothing of it, so it is still wanted
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }).provider_id).toBe('4');
    dismissListing(ALICE, id[4], NOW);
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 })?.provider_id).toBe('4'); // bob still wants it
    dismissListing(BOB, id[4], NOW);
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 })).toBeUndefined();
  });

  it('a listing only disabled queries find is not fetched', () => {
    Db.execute('UPDATE user_queries SET enabled = 0 WHERE user_id = ?', [BOB]);
    Db.execute('UPDATE user_queries SET enabled = 0 WHERE user_id = ?', [ALICE]);
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 })).toBeUndefined();
    expect(ids(ALICE)).toEqual([]);
  });

  it('global listing data is shared: the same row serves both users', () => {
    expect(getListingByProviderId('4').id).toBe(id[4]);
    expect(Db.query('SELECT COUNT(*) AS n FROM listings')[0].n).toBe(4);
  });
});
