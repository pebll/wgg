import {
  storeNewListings,
  getListingByProviderId,
  storeListingDetails,
  updateListingEvaluation,
  recordLlmResult,
} from '../../lib/services/listings/listingsStorage.js';
import Db from '../../lib/services/storage/Db.js';
import { PROMPT_VERSION } from '../../lib/llm/prompt.js';
import { giveQuery } from '../helpers/db.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { llmSettingsHash } from '../../lib/llm/settingsHash.js';
import { createUserDirectory } from '../../lib/users/directory.js';
import { parseConfig } from '../../lib/config.js';

export const SEARCH = 'https://www.wg-gesucht.de/x.html';
export const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
export const USER = 'alice';
export const MODEL = 'test-model';
/** The settings hash the seeded assessments carry: what a default user's settings hash to with MODEL. */
export const HASH = llmSettingsHash({ model: MODEL, profile: defaultEvaluationConfig().llm.profile });

/** A user directory over `users` (default: alice, the admin without email, who falls back to MAIL_TO). */
export function makeDirectory(notify = {}, users) {
  const parsed = parseConfig({ searches: [{ url: 'https://www.wg-gesucht.de/x.html' }], notify }).notify;
  return {
    directory: createUserDirectory({
      users: users ?? [{ username: USER, passwordHash: 'x', admin: true, email: null }],
      evaluation: defaultEvaluationConfig(),
      notify: parsed,
      model: MODEL,
    }),
    config: parsed,
  };
}

/**
 * Seeds one listing that is fully processed for `over.userId` (default alice, who gets a query for it): details,
 * evaluation and a finished AI assessment.
 * `over` can change: userId, overall, fit, price, size, distanceKm, verbindung, settingsHash, excluded, publishedAt,
 * assessed, assessedAt (when the AI result was stored; default NOW).
 */
export function seedAssessed(n, over = {}) {
  const o = { overall: 8, fit: 8, price: 650, verbindung: 0.1, assessed: true, userId: USER, ...over };
  giveQuery(o.userId, SEARCH);
  storeNewListings(
    [
      {
        providerId: String(n),
        link: `https://www.wg-gesucht.de/x.${n}.html`,
        title: `Room ${n}`,
        price: o.price,
        size: o.size ?? 18,
        district: 'Maxvorstadt',
      },
    ],
    SEARCH,
    NOW - 2 * 3_600_000,
  );
  const id = getListingByProviderId(String(n)).id;
  Db.execute('UPDATE listings SET published_at = @p WHERE id = @id', {
    id,
    p: o.publishedAt ?? NOW - 3_600_000,
  });
  storeListingDetails(
    id,
    { sections: [], description: 'Ein Zimmer', costs: [], address: null, wgFacts: [], objectFacts: [] },
    NOW,
  );
  updateListingEvaluation(
    o.userId,
    id,
    {
      overall: o.overall,
      scores: { rent: 8 },
      details: { rent: 'ok' },
      missing: [],
      excluded: o.excluded ?? null,
    },
    NOW,
    { distanceKm: o.distanceKm },
  );
  if (o.assessed) {
    recordLlmResult(
      o.userId,
      id,
      {
        verbindungProbability: o.verbindung,
        verbindungSignals: [],
        fitScore: o.fit,
        summary: 'Nice.',
        positives: [],
        redFlags: [],
        eligible: true,
        eligibilityReason: '',
        promptVersion: PROMPT_VERSION,
        settingsHash: o.settingsHash ?? HASH,
      },
      o.assessedAt ?? NOW,
    );
  }
  return id;
}
