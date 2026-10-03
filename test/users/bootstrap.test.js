import { describe, it, expect, afterEach } from 'vitest';
import { bootstrapUsers } from '../../lib/users/bootstrap.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { parseConfig } from '../../lib/config.js';
import { listUserQueries } from '../../lib/services/queries/queriesStorage.js';
import { getStoredSettings } from '../../lib/services/settings/userSettingsStorage.js';
import { queryListings, getUserListing } from '../../lib/services/listings/listingsStorage.js';
import { llmSettingsHash } from '../../lib/llm/settingsHash.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { ALICE, BOB, SEARCH, NOW, openDb, openDbUpTo, Db } from '../helpers/db.js';

const SEARCHES = [{ name: 'Munich', url: SEARCH }];
const evaluation = () => ({
  ...defaultEvaluationConfig(),
  llm: { ...defaultEvaluationConfig().llm, profile: 'Leo: long-term room.' },
});
const notify = parseConfig({ searches: [{ url: SEARCH }] }).notify;
const user = (username, over = {}) => ({ username, passwordHash: 'x', admin: false, email: null, ...over });
const run = (users, searches = SEARCHES, extra = {}) =>
  bootstrapUsers({ users, searches, evaluation: evaluation(), notify, now: NOW, ...extra });

const count = (sql, ...params) => Db.query(sql, params)[0].n;

afterEach(() => Db.reset());

/** A database as the single-user wgg left it (migrations 1-13), with one listing of every kind of state. */
async function legacyDb() {
  await openDbUpTo(13);
  const insert = (id, extra = {}) => {
    const cols = { provider_id: String(id), search_url: SEARCH, link: `https://x/${id}`, first_seen_at: NOW, ...extra };
    Db.execute(
      `INSERT INTO listings (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols)
        .map((k) => `@${k}`)
        .join(', ')})`,
      cols,
    );
  };
  insert(1, {
    overall_score: 8.5,
    scores_json: '{"rent":8}',
    details_json: '{"rent":"ok"}',
    missing_json: '[]',
    evaluated_at: NOW,
    distance_km: 2.5,
    llm_status: 'done',
    llm_json: '{"fitScore":9}',
    llm_model: 'm1',
    llm_evaluated_at: NOW,
    llm_attempts: 1,
    llm_prompt_version: 2,
    notified_at: NOW,
    notified_kind: 'priority',
  });
  insert(2, {
    dismissed_at: NOW,
    hidden_by: 'user',
    hidden_reason: 'Not interested',
    evaluated_at: NOW,
    overall_score: 4,
  });
  insert(3, { dismissed_at: NOW, hidden_by: 'user', hidden_reason: 'Messaged', messaged_at: NOW });
  insert(4, {
    dismissed_at: NOW,
    hidden_by: 'program',
    hidden_reason: 'excluded keyword "Corps"',
    excluded_reason: 'excluded keyword "Corps"',
    hide_override: 1,
    evaluated_at: NOW,
    overall_score: 1,
  });
  insert(5, { llm_status: 'failed', llm_error: 'boom', llm_attempts: 2, notify_attempts: 1, notify_error: 'smtp' });
  insert(6); // nothing known about it yet
  insert(7, { search_url: 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html' }); // an earlier search
  await runMigrations();
}

describe('#bootstrapUsers: upgrade from single-user data', () => {
  it('moves all per-listing state to the first admin, losing nothing', async () => {
    await legacyDb();
    const before = {
      listings: count('SELECT COUNT(*) AS n FROM listings'),
      done: count("SELECT COUNT(*) AS n FROM listings WHERE llm_status = 'done'"),
      hidden: count('SELECT COUNT(*) AS n FROM listings WHERE dismissed_at IS NOT NULL'),
      messaged: count('SELECT COUNT(*) AS n FROM listings WHERE messaged_at IS NOT NULL'),
      notified: count('SELECT COUNT(*) AS n FROM listings WHERE notified_at IS NOT NULL'),
      evaluated: count('SELECT COUNT(*) AS n FROM listings WHERE evaluated_at IS NOT NULL'),
    };

    const summary = run([user('zed'), user(ALICE, { admin: true }), user(BOB)]);

    expect(summary).toMatchObject({ adoptedBy: ALICE, newUsers: ['zed', ALICE, BOB] });
    const own = (where) => count(`SELECT COUNT(*) AS n FROM user_listings WHERE user_id = ? AND ${where}`, ALICE);
    expect(count('SELECT COUNT(*) AS n FROM listings')).toBe(before.listings); // listings untouched
    expect(own("llm_status = 'done'")).toBe(before.done);
    expect(own('hidden_at IS NOT NULL')).toBe(before.hidden);
    expect(own('messaged_at IS NOT NULL')).toBe(before.messaged);
    expect(own('notified_at IS NOT NULL')).toBe(before.notified);
    expect(own('evaluated_at IS NOT NULL')).toBe(before.evaluated);
    // nobody else got any of it
    expect(count('SELECT COUNT(*) AS n FROM user_listings WHERE user_id <> ?', ALICE)).toBe(0);
    // listings without any state are not copied (they are evaluated on demand)
    expect(count('SELECT COUNT(*) AS n FROM user_listings WHERE user_id = ?', ALICE)).toBe(5);

    const l1 = getUserListing(ALICE, '1');
    expect(l1).toMatchObject({
      overall_score: 8.5,
      scores_json: '{"rent":8}',
      distance_km: 2.5,
      llm_status: 'done',
      llm_model: 'm1',
      llm_attempts: 1,
      llm_prompt_version: 2,
      notified_kind: 'priority',
    });
    expect(getUserListing(ALICE, '2')).toMatchObject({ hidden_by: 'user', hidden_reason: 'Not interested' });
    expect(getUserListing(ALICE, '3')).toMatchObject({ hidden_reason: 'Messaged', messaged_at: NOW });
    expect(getUserListing(ALICE, '4')).toMatchObject({ hidden_by: 'program', hide_override: 1 });
    expect(getUserListing(ALICE, '5')).toMatchObject({ llm_status: 'failed', llm_error: 'boom', notify_attempts: 1 });
    expect(getUserListing(BOB, '1').llm_status).toBe('pending');
  });

  it('stamps adopted assessments with the settings hash of the admin profile, the stored model and prompt version', async () => {
    await legacyDb();
    run([user(ALICE, { admin: true })]);
    expect(getUserListing(ALICE, '1').llm_settings_hash).toBe(
      llmSettingsHash({ model: 'm1', profile: 'Leo: long-term room.', promptVersion: 2 }),
    );
  });

  it('the config searches become the admin queries; earlier search URLs are kept as disabled queries', async () => {
    await legacyDb();
    run([user(ALICE, { admin: true })]);
    const queries = listUserQueries(ALICE);
    expect(queries.map((q) => [q.name, q.url, q.enabled])).toEqual([
      ['Munich', SEARCH, true],
      ['Earlier search', 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html', false],
    ]);
  });

  it('records which search found each listing and the admin sees the same listings as before (visible ones)', async () => {
    await legacyDb();
    const visibleBefore = Db.query(
      'SELECT provider_id FROM listings WHERE dismissed_at IS NULL AND search_url = ? ORDER BY id',
      [SEARCH],
    ).map((r) => r.provider_id);
    run([user(ALICE, { admin: true })]);
    expect(count('SELECT COUNT(*) AS n FROM listing_queries')).toBe(7);
    const visibleAfter = queryListings(ALICE, {}, NOW)
      .items.map((i) => i.providerId)
      .sort();
    expect(visibleAfter).toEqual(visibleBefore.sort());
  });

  it('runs only once: a second start (even with another admin first) changes nothing', async () => {
    await legacyDb();
    run([user(ALICE, { admin: true })]);
    const rows = Db.query('SELECT * FROM user_listings ORDER BY user_id, listing_id');
    const summary = run([user(BOB, { admin: true }), user(ALICE, { admin: true })]);
    expect(summary.adoptedBy).toBeNull();
    expect(Db.query('SELECT * FROM user_listings ORDER BY user_id, listing_id')).toEqual(rows);
    expect(listUserQueries(BOB).map((q) => q.name)).toEqual(['Munich', 'Earlier search']); // bob is new: copy of the admin's
  });

  it('keeps the legacy per-listing columns untouched as a backup', async () => {
    await legacyDb();
    run([user(ALICE, { admin: true })]);
    expect(count("SELECT COUNT(*) AS n FROM listings WHERE llm_status = 'done'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM listings WHERE dismissed_at IS NOT NULL')).toBe(3);
  });
});

describe('#bootstrapUsers: users and defaults', () => {
  it("creates settings (defaults, the user's email) and gives new users a copy of the admin's queries", async () => {
    await openDb();
    const summary = run([user(ALICE, { admin: true, email: 'a@example.org' }), user(BOB, { email: 'b@example.org' })]);
    expect(summary).toMatchObject({ adoptedBy: ALICE, newUsers: [ALICE, BOB] });
    expect(listUserQueries(ALICE).map((q) => q.url)).toEqual([SEARCH]);
    expect(listUserQueries(BOB).map((q) => [q.name, q.url, q.enabled])).toEqual([['Munich', SEARCH, true]]);
    expect(listUserQueries(ALICE)[0].id).not.toBe(listUserQueries(BOB)[0].id); // a copy, not shared rows
    expect(getStoredSettings(ALICE).notify.email).toBe('a@example.org');
    expect(getStoredSettings(BOB).notify.email).toBe('b@example.org');
    expect(getStoredSettings(BOB).llm.profile).toBe('Leo: long-term room.');
    expect(getStoredSettings(BOB).scoring.rent).toEqual({ best: 450, worst: 750 });
  });

  it("new users get at most queries.maxPerUser of the owner's queries, enabled ones first", async () => {
    await openDb();
    run(
      [user(ALICE, { admin: true })],
      [
        { name: 'Munich', url: SEARCH },
        { name: 'Berlin', url: 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html' },
      ],
    );
    Db.execute("UPDATE user_queries SET enabled = 0 WHERE name = 'Munich'");
    run([user(ALICE, { admin: true }), user(BOB)], SEARCHES, { maxQueriesPerUser: 1 });
    expect(listUserQueries(BOB).map((q) => q.name)).toEqual(['Berlin']);
  });

  it('is idempotent and never overwrites settings or resurrects queries a user deleted', async () => {
    await openDb();
    run([user(ALICE, { admin: true }), user(BOB)]);
    Db.execute('DELETE FROM user_queries WHERE user_id = ?', [BOB]);
    Db.execute("UPDATE user_settings SET json = json_set(json, '$.llm.profile', 'Bob') WHERE user_id = ?", [BOB]);
    const summary = run([user(ALICE, { admin: true }), user(BOB)]);
    expect(summary.newUsers).toEqual([]);
    expect(listUserQueries(BOB)).toEqual([]);
    expect(getStoredSettings(BOB).llm.profile).toBe('Bob');
  });

  it("a user added later gets the admin's current queries and default settings", async () => {
    await openDb();
    run([user(ALICE, { admin: true })]);
    const summary = run([user(ALICE, { admin: true }), user('carol')]);
    expect(summary.newUsers).toEqual(['carol']);
    expect(listUserQueries('carol').map((q) => q.url)).toEqual([SEARCH]);
    expect(getStoredSettings('carol')).not.toBeNull();
  });

  it("a fresh install (no listings) just creates the admin's queries from the config searches", async () => {
    await openDb();
    run([user(ALICE, { admin: true })]);
    expect(listUserQueries(ALICE).map((q) => [q.name, q.url])).toEqual([['Munich', SEARCH]]);
    expect(count('SELECT COUNT(*) AS n FROM user_listings')).toBe(0);
  });

  it('normalizes search URLs the same way queries are stored (so listing_queries and queries match)', async () => {
    await openDb();
    run([user(ALICE, { admin: true })], [{ name: 'x', url: 'https://www.wg-gesucht.de/a b.html' }]);
    expect(listUserQueries(ALICE)[0].url).toBe('https://www.wg-gesucht.de/a%20b.html');
  });

  it('refuses to run without an admin (users.yaml validation prevents that, this is the backstop)', async () => {
    await openDb();
    expect(() => run([user(ALICE)])).toThrow(/admin/);
  });
});
