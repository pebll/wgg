import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations, MIGRATIONS_DIR } from '../../lib/services/storage/migrations/migrate.js';
import { storeNewListings, getListingByProviderId } from '../../lib/services/listings/listingsStorage.js';

afterEach(() => Db.reset());

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const FIRST_SEEN = new Date(2026, 9, 2, 12, 0, 0).getTime();

describe('#migration 3 (published_at + geo columns)', () => {
  it('adds the columns and backfills published_at for existing rows', async () => {
    // Apply only migrations 1 and 2, insert rows, then run everything.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-m3-'));
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
      if (/^[12]\./.test(f)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    }
    Db.reset();
    Db.init(':memory:');
    await runMigrations({ dir });
    const insert = (id, onlineRaw, onlineMinutes) =>
      Db.execute(
        `INSERT INTO listings (provider_id, search_url, link, online_raw, online_minutes, first_seen_at)
         VALUES (@id, 's', 'l', @onlineRaw, @onlineMinutes, @t)`,
        { id, onlineRaw, onlineMinutes, t: FIRST_SEEN },
      );
    insert('a', 'Online: 5 Minuten', 5);
    insert('b', 'Online: 27.08.2026', null);
    insert('c', null, null);
    fs.rmSync(dir, { recursive: true, force: true });

    await runMigrations();

    const cols = Db.query('PRAGMA table_info(listings)').map((c) => c.name);
    for (const c of ['published_at', 'lat', 'lng', 'geo_precision', 'distance_km', 'geocode_query']) {
      expect(cols).toContain(c);
    }
    expect(getListingByProviderId('a').published_at).toBe(FIRST_SEEN - 5 * 60_000);
    expect(getListingByProviderId('b').published_at).toBe(new Date(2026, 7, 27).getTime());
    expect(getListingByProviderId('c').published_at).toBeNull();
    expect(getListingByProviderId('a').lat).toBeNull();
  });

  it('computes published_at when storing new listings', async () => {
    Db.reset();
    Db.init(':memory:');
    await runMigrations();
    storeNewListings(
      [{ providerId: '1', link: 'l', title: 't', onlineRaw: 'Online: 1 Stunde', onlineMinutes: 60 }],
      SEARCH,
      FIRST_SEEN,
    );
    expect(getListingByProviderId('1').published_at).toBe(FIRST_SEEN - 3_600_000);
  });
});
