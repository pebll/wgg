import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  addUserQuery,
  getUserQuery,
  listUserQueries,
  countUserQueries,
  updateUserQuery,
  deleteUserQuery,
  listEnabledSearches,
  markQueryFetched,
  selectSearchesForCycle,
} from '../../lib/services/queries/queriesStorage.js';
import { ALICE, BOB, openDb, Db } from '../helpers/db.js';

const A = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const B = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';
const C = 'https://www.wg-gesucht.de/wg-zimmer-in-Hamburg.55.0.1.0.html';

beforeEach(openDb);
afterEach(() => Db.reset());

describe('#user queries', () => {
  it("adds, lists (oldest first) and counts a user's own queries", () => {
    const q = addUserQuery(ALICE, { name: 'Munich', url: A }, 1000);
    addUserQuery(ALICE, { url: B, enabled: false }, 2000);
    addUserQuery(BOB, { url: C }, 3000);
    expect(q).toEqual({ id: expect.any(Number), name: 'Munich', url: A, enabled: true, createdAt: 1000 });
    expect(listUserQueries(ALICE).map((x) => [x.name, x.url, x.enabled])).toEqual([
      ['Munich', A, true],
      ['', B, false],
    ]);
    expect(countUserQueries(ALICE)).toBe(2);
    expect(countUserQueries(BOB)).toBe(1);
    expect(listUserQueries('nobody')).toEqual([]);
  });

  it('refuses the same URL twice for one user (null) but lets two users have it', () => {
    expect(addUserQuery(ALICE, { url: A })).not.toBeNull();
    expect(addUserQuery(ALICE, { url: A })).toBeNull();
    expect(addUserQuery(BOB, { url: A })).not.toBeNull();
  });

  it("updates name, url and enabled; only the owner can, and a URL cannot collide with the owner's other query", () => {
    const q = addUserQuery(ALICE, { name: 'a', url: A });
    const other = addUserQuery(ALICE, { name: 'b', url: B });
    expect(updateUserQuery(ALICE, q.id, { name: 'Munich', enabled: false })).toMatchObject({
      name: 'Munich',
      url: A,
      enabled: false,
    });
    expect(updateUserQuery(ALICE, q.id, { url: C })).toMatchObject({ url: C });
    expect(updateUserQuery(ALICE, q.id, {})).toMatchObject({ url: C }); // nothing to change
    expect(updateUserQuery(BOB, q.id, { name: 'hijacked' })).toBeNull();
    expect(getUserQuery(ALICE, q.id).name).toBe('Munich');
    expect(() => updateUserQuery(ALICE, q.id, { url: B })).toThrow(/already/);
    expect(getUserQuery(ALICE, other.id).url).toBe(B);
    expect(updateUserQuery(ALICE, 9999, { name: 'x' })).toBeNull();
  });

  it("deletes only the owner's query", () => {
    const q = addUserQuery(ALICE, { url: A });
    expect(deleteUserQuery(BOB, q.id)).toBe(false);
    expect(getUserQuery(ALICE, q.id)).not.toBeNull();
    expect(deleteUserQuery(ALICE, q.id)).toBe(true);
    expect(deleteUserQuery(ALICE, q.id)).toBe(false);
    expect(listUserQueries(ALICE)).toEqual([]);
  });

  it("getUserQuery never returns another user's query", () => {
    const q = addUserQuery(ALICE, { url: A });
    expect(getUserQuery(BOB, q.id)).toBeNull();
  });
});

describe('#listEnabledSearches (what the scheduler fetches)', () => {
  it('is the distinct set of enabled URLs of all users, oldest first', () => {
    addUserQuery(ALICE, { name: 'Munich', url: A }, 1);
    addUserQuery(BOB, { name: 'Muc (bob)', url: A }, 2); // same search: fetched once
    addUserQuery(BOB, { url: B }, 3);
    addUserQuery(ALICE, { name: 'off', url: C, enabled: false }, 4);
    expect(listEnabledSearches()).toEqual([
      { name: 'Munich', url: A },
      { name: B, url: B }, // unnamed: the URL stands in for the name in logs
    ]);
  });

  it('a URL stays in the set while any user still has it enabled, and drops out when nobody does', () => {
    const a = addUserQuery(ALICE, { url: A });
    const b = addUserQuery(BOB, { url: A });
    updateUserQuery(ALICE, a.id, { enabled: false });
    expect(listEnabledSearches().map((s) => s.url)).toEqual([A]);
    deleteUserQuery(BOB, b.id);
    expect(listEnabledSearches()).toEqual([]);
  });
});

describe('#selectSearchesForCycle (the cap on requests per cycle)', () => {
  const D = 'https://www.wg-gesucht.de/wg-zimmer-in-Koeln.73.0.1.0.html';
  beforeEach(() => {
    addUserQuery(ALICE, { url: A }, 1);
    addUserQuery(ALICE, { url: B }, 2);
    addUserQuery(BOB, { url: C }, 3);
    addUserQuery(BOB, { url: D }, 4);
  });

  it('returns everything when under the cap', () => {
    const r = selectSearchesForCycle(5);
    expect(r.searches.map((s) => s.url)).toEqual([A, B, C, D]);
    expect(r.skipped).toBe(0);
  });

  it('caps the number of distinct URLs and says how many wait', () => {
    const r = selectSearchesForCycle(2);
    expect(r.searches.map((s) => s.url)).toEqual([A, B]);
    expect(r.skipped).toBe(2);
  });

  it('round robin: the URLs that waited longest go first, so every URL gets its turn across cycles', () => {
    const turns = [];
    for (let cycle = 1; cycle <= 4; cycle++) {
      const { searches } = selectSearchesForCycle(2);
      searches.forEach((s, i) => markQueryFetched(s.url, cycle * 100 + i));
      turns.push(searches.map((s) => s.url));
    }
    expect(turns).toEqual([
      [A, B],
      [C, D],
      [A, B],
      [C, D],
    ]);
  });

  it('a URL nobody has enabled any more is not in the rotation', () => {
    Db.execute('UPDATE user_queries SET enabled = 0 WHERE url = ?', [A]);
    expect(selectSearchesForCycle(5).searches.map((s) => s.url)).toEqual([B, C, D]);
  });
});
