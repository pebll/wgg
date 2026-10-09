import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { giveQuery } from '../helpers/db.js';
import { storeNewListings, storeListingDetails, recordLlmResult } from '../../lib/services/listings/listingsStorage.js';
import { getLlmAvgSeconds, estimateLlmEtaSeconds, DEFAULT_LLM_SECONDS } from '../../lib/llm/eta.js';

const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const SEARCH = 'https://www.wg-gesucht.de/x.html';

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery('alice', SEARCH);
});
afterEach(() => Db.reset());

function assess(n, at) {
  storeNewListings([{ providerId: String(n), link: `https://x/${n}`, title: 't', price: 1 }], SEARCH, NOW);
  const id = Db.getConnection().prepare('SELECT id FROM listings WHERE provider_id = ?').get(String(n)).id;
  storeListingDetails(
    id,
    { sections: [], description: 'd', costs: [], address: null, wgFacts: [], objectFacts: [] },
    NOW,
  );
  recordLlmResult('alice', id, { verbindungProbability: 0, fitScore: 5, model: 'm' }, at);
}

describe('#llm eta', () => {
  it('has no measurement without enough finished assessments', () => {
    expect(getLlmAvgSeconds()).toBeNull();
    assess(1, NOW - 20_000);
    assess(2, NOW - 10_000);
    expect(getLlmAvgSeconds()).toBeNull();
  });

  it('measures the average gap between consecutive assessments and ignores idle pauses', () => {
    [0, 10, 20, 30, 40].forEach((s, i) => assess(i + 1, NOW - 3_600_000 + s * 1000)); // 10 s apart
    assess(9, NOW); // an hour of idling in between is not a duration
    expect(getLlmAvgSeconds()).toBe(10);
  });

  it('estimates the wait for a user: own backlog plus what other users take in turns', () => {
    expect(estimateLlmEtaSeconds({ own: 10, others: [], avgSeconds: 8 })).toBe(80);
    expect(estimateLlmEtaSeconds({ own: 10, others: [3, 50], avgSeconds: 8 })).toBe((10 + 3 + 10) * 8);
    expect(estimateLlmEtaSeconds({ own: 0, others: [5], avgSeconds: 8 })).toBe(0);
    expect(estimateLlmEtaSeconds({ own: 10, others: [] })).toBe(10 * DEFAULT_LLM_SECONDS);
  });
});
