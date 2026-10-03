import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import Db from '../../lib/services/storage/Db.js';
import { giveQuery } from '../helpers/db.js';
import { runMigrations, MIGRATIONS_DIR } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  getUserListing,
  queryListings,
  dismissListing,
  restoreListing,
  updateListingEvaluation,
} from '../../lib/services/listings/listingsStorage.js';

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const listing = (id) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 600,
});
const idOf = (p) => getListingByProviderId(String(p)).id;
const U = 'alice';
const row = (p) => getUserListing(U, String(p));
const legacyRow = (p) => Db.query('SELECT * FROM listings WHERE provider_id = ?', [String(p)])[0];
const result = (overall, excluded) => ({
  scores: {},
  overall,
  missing: [],
  details: {},
  ...(excluded ? { excluded } : {}),
});

describe('#migration 9 (hidden_by / hidden_reason / hide_override)', () => {
  afterEach(() => Db.reset());

  it('marks existing dismissed rows as hidden by the user and hides excluded rows as program-hidden', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-m9-'));
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
      // Wrappers re-exporting the real migrations (they import siblings by relative path, so they cannot be copied).
      if (/^[1-8]\./.test(f)) {
        fs.writeFileSync(
          path.join(dir, f),
          `export { up } from ${JSON.stringify(pathToFileURL(path.join(MIGRATIONS_DIR, f)).href)};\n`,
        );
      }
    }
    Db.reset();
    Db.init(':memory:');
    await runMigrations({ dir });
    fs.rmSync(dir, { recursive: true, force: true });
    const insert = (id, dismissedAt, excluded) =>
      Db.execute(
        `INSERT INTO listings (provider_id, search_url, link, first_seen_at, dismissed_at, excluded_reason, evaluated_at)
         VALUES (@id, 's', 'l', @t, @dismissedAt, @excluded, @t)`,
        { id, t: NOW, dismissedAt, excluded },
      );
    insert('user', 5000, null);
    insert('excluded', null, 'excluded keyword "Corps"');
    insert('both', 6000, 'rent too high');
    insert('plain', null, null);

    await runMigrations();

    expect(legacyRow('user')).toMatchObject({
      dismissed_at: 5000,
      hidden_by: 'user',
      hidden_reason: 'Not interested',
      hide_override: 0,
    });
    expect(legacyRow('excluded')).toMatchObject({
      hidden_by: 'program',
      hidden_reason: 'excluded keyword "Corps"',
      hide_override: 0,
    });
    expect(legacyRow('excluded').dismissed_at).toBeGreaterThan(0);
    expect(legacyRow('both')).toMatchObject({ dismissed_at: 6000, hidden_by: 'user', hidden_reason: 'Not interested' });
    expect(legacyRow('plain')).toMatchObject({ dismissed_at: null, hidden_by: null, hidden_reason: null });
  });
});

describe('#hiding (user and program)', () => {
  beforeEach(async () => {
    Db.reset();
    Db.init(':memory:');
    await runMigrations();
    giveQuery(U, SEARCH);
    storeNewListings([1, 2, 3].map(listing), SEARCH, NOW);
  });
  afterEach(() => Db.reset());

  it('"Not interested" hides by the user with the reason "Not interested"', () => {
    dismissListing(U, idOf(1), 5000);
    expect(row(1)).toMatchObject({ dismissed_at: 5000, hidden_by: 'user', hidden_reason: 'Not interested' });
    const api = queryListings(U, { includeHidden: '1' }).items.find((i) => i.providerId === '1');
    expect(api.hidden).toEqual({ by: 'user', reason: 'Not interested', at: 5000 });
    expect(api.dismissed).toBe(true);
  });

  it('visible listings have hidden: null', () => {
    expect(queryListings(U).items.every((i) => i.hidden === null)).toBe(true);
  });

  it('an exclusion hides the listing by the program with the exclusion as reason', () => {
    updateListingEvaluation(U, idOf(1), result(1, 'excluded keyword "Corps"'), NOW);
    expect(row(1)).toMatchObject({ hidden_by: 'program', hidden_reason: 'excluded keyword "Corps"' });
    expect(row(1).dismissed_at).not.toBeNull();
    expect(queryListings(U).items.map((i) => i.providerId)).not.toContain('1');
    expect(queryListings(U, { includeHidden: '1' }).items.map((i) => i.providerId)).toContain('1');
  });

  it('includeDismissed stays accepted as an alias of includeHidden', () => {
    updateListingEvaluation(U, idOf(1), result(1, 'x'), NOW);
    expect(queryListings(U, { includeDismissed: '1' }).items.map((i) => i.providerId)).toContain('1');
    expect(queryListings(U, { includeDismissed: 'true' }).total).toBe(3);
  });

  it('a later evaluation that no longer excludes un-hides a program-hidden listing', () => {
    updateListingEvaluation(U, idOf(1), result(1, 'excluded keyword "Corps"'), NOW);
    updateListingEvaluation(U, idOf(1), result(7), NOW + 1);
    expect(row(1)).toMatchObject({ dismissed_at: null, hidden_by: null, hidden_reason: null });
  });

  it('the reason follows a changed exclusion, the hidden time stays', () => {
    updateListingEvaluation(U, idOf(1), result(1, 'first'), NOW);
    const at = row(1).dismissed_at;
    updateListingEvaluation(U, idOf(1), result(1, 'second'), NOW + 5);
    expect(row(1)).toMatchObject({ hidden_by: 'program', hidden_reason: 'second', dismissed_at: at });
  });

  it('never touches a listing the user hid, and the user hiding takes over a program hide', () => {
    dismissListing(U, idOf(1), 5000);
    updateListingEvaluation(U, idOf(1), result(7), NOW);
    expect(row(1)).toMatchObject({ dismissed_at: 5000, hidden_by: 'user' });
    updateListingEvaluation(U, idOf(2), result(1, 'excluded'), NOW);
    dismissListing(U, idOf(2), 9000);
    expect(row(2)).toMatchObject({ hidden_by: 'user', hidden_reason: 'Not interested' });
    updateListingEvaluation(U, idOf(2), result(7), NOW);
    expect(row(2).hidden_by).toBe('user');
  });

  it('restoring a program-hidden listing wins: later evaluations never hide it again', () => {
    updateListingEvaluation(U, idOf(1), result(1, 'excluded'), NOW);
    expect(restoreListing(U, idOf(1))).toBe(true);
    expect(row(1)).toMatchObject({ dismissed_at: null, hidden_by: null, hidden_reason: null, hide_override: 1 });
    updateListingEvaluation(U, idOf(1), result(1, 'excluded again'), NOW + 1);
    expect(row(1)).toMatchObject({ dismissed_at: null, hidden_by: null });
    expect(row(1).excluded_reason).toBe('excluded again'); // still shown as excluded, just not hidden
    dismissListing(U, idOf(1), 7000); // the user may still hide it themselves
    expect(row(1).hidden_by).toBe('user');
  });

  it('autoHide.belowOverall hides low scores with "Score 2.3 below 3" and leaves others', () => {
    updateListingEvaluation(U, idOf(1), result(2.3), NOW, { autoHideBelow: 3 });
    expect(row(1)).toMatchObject({ hidden_by: 'program', hidden_reason: 'Score 2.3 below 3' });
    updateListingEvaluation(U, idOf(2), result(3), NOW, { autoHideBelow: 3 });
    expect(row(2).dismissed_at).toBeNull();
    updateListingEvaluation(U, idOf(3), result(null), NOW, { autoHideBelow: 3 }); // not scorable: not a low score
    expect(row(3).dismissed_at).toBeNull();
    updateListingEvaluation(U, idOf(1), result(2.3), NOW + 1); // option off (null/undefined): un-hidden again
    expect(row(1).dismissed_at).toBeNull();
  });

  it('an exclusion reason wins over the score reason', () => {
    updateListingEvaluation(U, idOf(1), result(1, 'excluded keyword'), NOW, { autoHideBelow: 3 });
    expect(row(1).hidden_reason).toBe('excluded keyword');
  });

  it('"Messaged" hides by the user with the reason "Messaged" and remembers messaged_at', () => {
    dismissListing(U, idOf(1), 7000, 'messaged');
    expect(row(1)).toMatchObject({
      dismissed_at: 7000,
      hidden_by: 'user',
      hidden_reason: 'Messaged',
      messaged_at: 7000,
    });
    const api = queryListings(U, { includeHidden: '1' }).items.find((i) => i.providerId === '1');
    expect(api).toMatchObject({ messagedAt: 7000, hidden: { by: 'user', reason: 'Messaged', at: 7000 } });
    expect(queryListings(U, {}).items.map((i) => i.providerId)).not.toContain('1');
  });

  it('restore clears the hidden state but keeps messaged_at; an unmessaged listing has messagedAt null', () => {
    dismissListing(U, idOf(1), 7000, 'messaged');
    restoreListing(U, idOf(1));
    expect(row(1)).toMatchObject({ dismissed_at: null, hidden_by: null, hidden_reason: null, messaged_at: 7000 });
    const items = queryListings(U, {}).items;
    expect(items.find((i) => i.providerId === '1').messagedAt).toBe(7000);
    expect(items.find((i) => i.providerId === '2').messagedAt).toBeNull();
  });

  it('keeps the first messaged_at when repeated, and "Not interested" afterwards keeps it too', () => {
    dismissListing(U, idOf(1), 7000, 'messaged');
    dismissListing(U, idOf(1), 8000, 'messaged');
    expect(row(1).messaged_at).toBe(7000);
    dismissListing(U, idOf(1), 9000, 'not_interested');
    expect(row(1)).toMatchObject({ hidden_reason: 'Not interested', messaged_at: 7000 });
  });
});
