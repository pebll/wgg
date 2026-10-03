import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations, MIGRATIONS_DIR } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  storeListingDetails,
  updateListingEvaluation,
  recordLlmResult,
} from '../../lib/services/listings/listingsStorage.js';
import { addUserQuery } from '../../lib/services/queries/queriesStorage.js';
import { PROMPT_VERSION } from '../../lib/llm/prompt.js';

export const ALICE = 'alice';
export const BOB = 'bob';
export const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
export const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();

/** Fresh in-memory database with every migration applied. */
export async function openDb() {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
}

/**
 * Fresh in-memory database migrated only up to migration `n` (to test an upgrade): a temp dir of wrapper files that
 * re-export the real migrations (they import siblings by relative path, so they cannot be copied).
 */
export async function openDbUpTo(n, file = ':memory:') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (Number.parseInt(f, 10) <= n) {
      fs.writeFileSync(
        path.join(dir, f),
        `export { up } from ${JSON.stringify(pathToFileURL(path.join(MIGRATIONS_DIR, f)).href)};\n`,
      );
    }
  }
  Db.reset();
  Db.init(file);
  await runMigrations({ dir });
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Gives `userId` an enabled query for `url` (the user then sees the listings that URL found). */
export function giveQuery(userId, url = SEARCH, over = {}) {
  return addUserQuery(userId, { name: over.name ?? '', url, enabled: over.enabled ?? true }, NOW);
}

export const card = (n, over = {}) => ({
  providerId: String(n),
  link: `https://www.wg-gesucht.de/x.${n}.html`,
  title: `Room ${n}`,
  price: 600,
  ...over,
});

/** Stores listing n as found by `url`; returns its row id. */
export function seedListing(n, url = SEARCH, over = {}) {
  storeNewListings([card(n, over)], url, NOW - 2 * 3_600_000);
  return getListingByProviderId(String(n)).id;
}

/** A finished, evaluated and AI-assessed listing for `userId` (details are global). */
export function seedAssessedFor(userId, id, { overall = 8, fit = 8, settingsHash = 'h1' } = {}) {
  storeListingDetails(
    id,
    { sections: [], description: 'Ein Zimmer', costs: [], address: null, wgFacts: [], objectFacts: [] },
    NOW,
  );
  updateListingEvaluation(
    userId,
    id,
    { overall, scores: { rent: 8 }, details: { rent: 'ok' }, missing: [], excluded: undefined },
    NOW,
    { distanceKm: 2 },
  );
  recordLlmResult(
    userId,
    id,
    {
      verbindungProbability: 0.1,
      verbindungSignals: [],
      fitScore: fit,
      summary: 'Nice.',
      positives: [],
      redFlags: [],
      eligible: true,
      eligibilityReason: '',
      promptVersion: PROMPT_VERSION,
      settingsHash,
    },
    NOW,
  );
}

const USER_COLUMNS = new Set([
  'overall_score',
  'scores_json',
  'details_json',
  'missing_json',
  'excluded_reason',
  'evaluated_at',
  'distance_km',
  'llm_status',
  'llm_json',
  'llm_model',
  'llm_evaluated_at',
  'llm_error',
  'llm_attempts',
  'llm_prompt_version',
  'llm_settings_hash',
  'hidden_at',
  'hidden_by',
  'hidden_reason',
  'hide_override',
  'messaged_at',
  'notified_at',
  'notified_kind',
  'notify_error',
  'notify_attempts',
]);

/**
 * Sets columns of a listing directly, global ones on `listings` and per-user ones (any of USER_COLUMNS; `dismissed_at`
 * is accepted for `hidden_at`) on the user's row. For tests that need exact stored values.
 */
export function setRow(userId, providerId, fields) {
  const global = {};
  const user = {};
  for (const [key, value] of Object.entries(fields)) {
    const name = key === 'dismissed_at' ? 'hidden_at' : key;
    (USER_COLUMNS.has(name) ? user : global)[name] = value;
  }
  if (Object.keys(global).length > 0) {
    const sets = Object.keys(global).map((c) => `${c} = @${c}`);
    Db.execute(`UPDATE listings SET ${sets.join(', ')} WHERE provider_id = @providerId`, {
      ...global,
      providerId: String(providerId),
    });
  }
  setUserState(userId, providerId, user);
}

/** Sets per-user columns of a listing directly (for tests that need exact stored values). Column names are the test's own. */
export function setUserState(userId, providerId, columns) {
  const listingId = getListingByProviderId(String(providerId)).id;
  Db.execute('INSERT OR IGNORE INTO user_listings (user_id, listing_id) VALUES (@userId, @listingId)', {
    userId,
    listingId,
  });
  const names = Object.keys(columns);
  if (names.length === 0) return;
  Db.execute(
    `UPDATE user_listings SET ${names.map((c) => `${c} = @${c}`).join(', ')} WHERE user_id = @userId AND listing_id = @listingId`,
    { ...columns, userId, listingId },
  );
}

export { Db };
