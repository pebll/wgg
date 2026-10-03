import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  getUserListing,
  storeListingDetails,
  updateListingEvaluation,
  queryListings,
} from '../../lib/services/listings/listingsStorage.js';
import { createLlmWorker } from '../../lib/llm/llmWorker.js';
import { LlmEvaluator } from '../../lib/evaluation/llmEvaluator.js';
import { RuleBasedEvaluator } from '../../lib/evaluation/ruleBasedEvaluator.js';
import { evaluateStoredListings } from '../../lib/evaluation/pipeline.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { LlmError } from '../../lib/llm/client.js';
import { PROMPT_VERSION } from '../../lib/llm/prompt.js';
import { giveQuery, setRow } from '../helpers/db.js';

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const KEY = 'sk-secret-key-xyz';
const U = 'alice';
const V = 'bob';
const config = { ...defaultEvaluationConfig(), llm: { ...defaultEvaluationConfig().llm, model: 'm', delaySeconds: 2 } };

const listing = (id, extra = {}) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 500,
  size: 15,
  onlineRaw: null,
  ...extra,
});
const page = (description) => ({ sections: [], description, costs: [], address: null, wgFacts: [], objectFacts: [] });
const reply = (o = {}) =>
  JSON.stringify({
    verbindungProbability: 0.1,
    verbindungSignals: [],
    fitScore: 9,
    summary: 'Nice.',
    positives: [],
    redFlags: [],
    ...o,
  });

const id = (p) => getListingByProviderId(String(p)).id;
/** A listing with details, in the view of `users` (default alice), with the rule evaluation of each of them. */
function seed(n, description = 'Ein nettes Zimmer in einer normalen WG.', users = [U]) {
  storeNewListings([listing(n)], SEARCH, NOW);
  storeListingDetails(id(n), page(description), NOW);
  const rule = new RuleBasedEvaluator(config);
  for (const user of users) {
    updateListingEvaluation(
      user,
      id(n),
      rule.evaluate({ title: `Room ${n}`, price: 500, size: 15, description }, { now: NOW }),
      NOW,
    );
  }
}

/** One user's wiring, as createLlmDeps does it; `profile` ends up in the prompt, `hash` is the settings hash. */
function userOf(client, userId, { profile = 'A student.', hash = 'h1', evaluatorConfig = config } = {}) {
  const llm = { ...evaluatorConfig.llm, profile };
  return {
    userId,
    ruleEvaluator: new RuleBasedEvaluator(evaluatorConfig),
    llmEvaluator: new LlmEvaluator({ client, config: llm }),
    settingsHash: hash,
    target: evaluatorConfig.target,
  };
}

function setup(replies, extra = {}, userIds = [U]) {
  const prompts = [];
  const sleeps = [];
  const client = {
    chat: async ({ messages }) => {
      prompts.push(messages);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { status: 200, content: r };
    },
  };
  const { users = () => userIds.map((u) => userOf(client, u)), ...rest } = extra;
  const worker = createLlmWorker({
    users: () => users(client),
    config: config.llm,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => NOW,
    log: { info() {}, warn() {}, error() {} },
    secrets: [KEY],
    ...rest,
  });
  return { worker, prompts, sleeps, client, ruleEvaluator: new RuleBasedEvaluator(config) };
}

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.reset());

describe('#llm worker', () => {
  it('assesses queued listings serially, waits between calls, merges into the evaluation', async () => {
    seed(1);
    seed(2);
    const { worker, prompts, sleeps } = setup([reply({ fitScore: 9 }), reply({ fitScore: 3 })]);
    const r = await worker.drain();
    expect(r).toMatchObject({ done: 2, failed: 0, skipped: 0 });
    expect(prompts).toHaveLength(2);
    expect(sleeps).toEqual([2000]); // between the two calls, not after the last
    const row = getUserListing(U, '1');
    expect(row.llm_status).toBe('done');
    expect(JSON.parse(row.scores_json).llm).toBeDefined();
    expect(JSON.parse(row.details_json).llm).toBe('Nice.');
    expect(row.excluded_reason).toBeNull();
    const api = queryListings(U, { pageSize: 10 }, NOW).items.find((i) => i.providerId === '1');
    expect(api.evaluation.scores.llm).toBeGreaterThan(0);
  });

  it('stores the alert tier of the assessed listing from the user rules (after the merged evaluation)', async () => {
    seed(1);
    seed(2);
    const notify = {
      priority: { rules: [{ ai: { gt: 8 } }] },
      bulk: { rules: [{ ai: { gt: 2 } }] },
    };
    const { worker } = setup([reply({ fitScore: 9 }), reply({ fitScore: 3 })], {
      users: (client) => [{ ...userOf(client, U), notify }],
    });
    await worker.drain();
    // (the queue order is not the point: whichever got the 9 is fantastic, the other good)
    const tiers = ['1', '2'].map((p) => {
      const row = getUserListing(U, p);
      return [JSON.parse(row.llm_json).fitScore, row.tier];
    });
    expect(tiers.sort()).toEqual([
      [3, 'good'],
      [9, 'fantastic'],
    ]);
  });

  it('sends the description to the model', async () => {
    seed(1, 'Beschreibung mit Bundesbrüder-Hinweis? Nein, nur Test.');
    // keyword "Bundesbrüder" would exclude it by rules, so use another text for the prompt check
    seed(2, 'Sehr spezieller Beschreibungstext 4711.');
    const { worker, prompts } = setup([reply()]);
    await worker.drain({ ids: ['2'] });
    expect(prompts[0].find((m) => m.role === 'user').content).toContain('Sehr spezieller Beschreibungstext 4711.');
  });

  it('excludes a listing when the Verbindung probability reaches the threshold', async () => {
    seed(1);
    const { worker } = setup([reply({ verbindungProbability: 0.82, verbindungSignals: ['"Kneipe"'] })]);
    await worker.drain();
    const row = getUserListing(U, '1');
    expect(row.excluded_reason).toBe('LLM: likely Studentenverbindung (p=0.82): "Kneipe"');
    expect(row.overall_score).toBe(1);
  });

  it('skips listings already excluded by the rules without calling the model', async () => {
    seed(1, 'Wir sind eine Burschenschaft mit Haus.');
    const { worker, prompts } = setup([]);
    const r = await worker.drain({ ids: ['1'] }); // rule-excluded listings are hidden, so only an explicit id reaches the queue
    expect(r.skipped).toBe(1);
    expect(prompts).toHaveLength(0);
    expect(getUserListing(U, '1')).toMatchObject({ llm_status: 'skipped' });
    expect(getUserListing(U, '1').llm_error).toMatch(/excluded by rules/);
  });

  it('skips listings without a description', async () => {
    storeNewListings([listing(1)], SEARCH, NOW); // details still pending
    const { worker, prompts } = setup([]);
    await worker.drain();
    expect(prompts).toHaveLength(0);
    storeListingDetails(id(1), page(''), NOW);
    await worker.drain();
    expect(getUserListing(U, '1')).toMatchObject({ llm_status: 'skipped', llm_error: 'no description' });
  });

  it('keeps the rule-based result on failure, stores a redacted error, continues with the next', async () => {
    seed(1);
    seed(2);
    const before = getUserListing(U, '2').overall_score;
    const { worker } = setup([new LlmError(`HTTP 500 for Bearer ${KEY}`), reply()]);
    const r = await worker.drain();
    expect(r).toMatchObject({ done: 1, failed: 1 });
    const rows = [getUserListing(U, '1'), getUserListing(U, '2')];
    const bad = rows.find((x) => x.llm_status === 'failed');
    expect(bad.llm_error).toContain('HTTP 500');
    expect(bad.llm_error).not.toContain(KEY);
    expect(bad.overall_score).toBe(before);
    expect(JSON.parse(bad.scores_json).llm).toBeUndefined();
  });

  it('stores the truncation flag when the description was cut', async () => {
    seed(1, 'x '.repeat(10_000));
    const { worker } = setup([reply()]);
    await worker.drain();
    expect(JSON.parse(getUserListing(U, '1').llm_json)).toMatchObject({
      truncated: true,
      descriptionChars: 19999,
    });
  });

  it('--force re-assesses finished listings; limit and abort stop early', async () => {
    seed(1);
    seed(2);
    const first = setup([reply(), reply()]);
    await first.worker.drain({ limit: 1 });
    expect(getUserListing(U, '2').llm_status).toBe('done');
    expect(getUserListing(U, '1').llm_status).toBe('pending');
    const again = setup([reply()]);
    const r = await again.worker.drain({ ids: ['2'], force: true });
    expect(r.done).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect((await setup([]).worker.drain({ signal: controller.signal })).stopped).toBe('aborted');
  });

  it('a later rule-based re-evaluation keeps the stored LLM result', async () => {
    seed(1);
    const { worker, ruleEvaluator } = setup([reply({ verbindungProbability: 0.9, verbindungSignals: ['"Aktive"'] })]);
    await worker.drain();
    const geocoder = { geocode: async () => null };
    await evaluateStoredListings({
      all: true,
      contexts: [{ userId: U, evaluator: ruleEvaluator, target: config.target }],
      geocoder,
      now: NOW,
    });
    const row = getUserListing(U, '1');
    expect(JSON.parse(row.scores_json).llm).toBe(9);
    expect(row.excluded_reason).toMatch(/^LLM: likely/);
    expect(row.overall_score).toBe(1);
  });
});

describe('#llm worker settings hash', () => {
  it('stores the settings hash, and re-assesses done listings made with other settings (profile, model, prompt version)', async () => {
    seed(1);
    seed(2);
    const { worker } = setup([reply(), reply()]);
    await worker.drain();
    expect(getUserListing(U, '1')).toMatchObject({ llm_prompt_version: PROMPT_VERSION, llm_settings_hash: 'h1' });
    expect((await worker.drain()).done).toBe(0); // up to date
    // the user edited their profile: the hash differs, everything is assessed again with the new profile
    const changed = setup([reply(), reply()], {
      users: (client) => [userOf(client, U, { profile: 'A long-term tenant.', hash: 'h2' })],
    });
    const r = await changed.worker.drain();
    expect(r.done).toBe(2);
    expect(changed.prompts[0].find((m) => m.role === 'system').content).toContain('A long-term tenant.');
    expect(getUserListing(U, '1').llm_settings_hash).toBe('h2');
  });

  it('a profile that makes the user ineligible hides the listing for that user', async () => {
    seed(1);
    const { worker } = setup([reply({ eligible: false, eligibilityReason: 'only women wanted' })]);
    await worker.drain();
    expect(getUserListing(U, '1')).toMatchObject({ excluded_reason: 'LLM: not eligible: only women wanted' });
  });
});

describe('#llm worker for several users', () => {
  beforeEach(() => giveQuery(V, SEARCH));

  it("assesses every user's listings with that user's own profile", async () => {
    seed(1, 'Zimmer in normaler WG.', [U, V]);
    const { worker, prompts } = setup([reply({ fitScore: 9 }), reply({ fitScore: 2 })], {
      users: (client) => [
        userOf(client, U, { profile: 'ALICE-PROFILE' }),
        userOf(client, V, { profile: 'BOB-PROFILE' }),
      ],
    });
    const r = await worker.drain();
    expect(r.done).toBe(2);
    expect(prompts[0].find((m) => m.role === 'system').content).toContain('ALICE-PROFILE');
    expect(prompts[0].find((m) => m.role === 'system').content).not.toContain('BOB-PROFILE');
    expect(prompts[1].find((m) => m.role === 'system').content).toContain('BOB-PROFILE');
    expect(JSON.parse(getUserListing(U, '1').llm_json).fitScore).toBe(9);
    expect(JSON.parse(getUserListing(V, '1').llm_json).fitScore).toBe(2);
  });

  it("takes the users' queues in turns, each ordered by that user's own score, so nobody starves", async () => {
    for (const n of [1, 2, 3]) seed(n, 'Zimmer in normaler WG.', [U, V]);
    setRow(U, '1', { overall_score: 9 });
    setRow(U, '2', { overall_score: 5 });
    setRow(U, '3', { overall_score: 1 });
    setRow(V, '3', { overall_score: 9 }); // bob likes 3 best
    setRow(V, '2', { overall_score: 5 });
    setRow(V, '1', { overall_score: 1 });
    const order = [];
    const { worker } = setup(Array(6).fill(reply()), {
      users: (client) => [userOf(client, U), userOf(client, V)],
      onAssessed: (userId, providerId) => void order.push(`${userId}:${providerId}`),
    });
    await worker.drain();
    expect(order).toEqual(['alice:1', 'bob:3', 'alice:2', 'bob:2', 'alice:3', 'bob:1']);
  });

  it("a failure or exclusion for one user does not touch the other's result", async () => {
    seed(1, 'Zimmer in normaler WG.', [U, V]);
    const { worker } = setup([new LlmError('boom'), reply({ fitScore: 8 })], {
      users: (client) => [userOf(client, U), userOf(client, V)],
    });
    const r = await worker.drain();
    expect(r).toMatchObject({ done: 1, failed: 1 });
    expect(getUserListing(U, '1')).toMatchObject({ llm_status: 'failed', llm_error: 'boom' });
    expect(getUserListing(V, '1')).toMatchObject({ llm_status: 'done', llm_error: null });
  });

  it('skips a listing only for the user whose own rules exclude it', async () => {
    seed(1, 'Zimmer in normaler WG.', [U, V]);
    const strict = { ...config, exclusions: { keywords: ['normaler'] } }; // alice's rules exclude this description
    const { worker, prompts } = setup([reply()], {
      users: (client) => [userOf(client, U, { evaluatorConfig: strict }), userOf(client, V)],
    });
    const r = await worker.drain({ ids: ['1'] });
    expect(r).toMatchObject({ done: 1, skipped: 1 });
    expect(prompts).toHaveLength(1);
    expect(getUserListing(U, '1').llm_status).toBe('skipped');
    expect(getUserListing(V, '1').llm_status).toBe('done');
  });

  it('a user without the listing in their view is not assessed for it', async () => {
    storeNewListings([listing(1)], 'https://www.wg-gesucht.de/other.html', NOW); // nobody's query finds it...
    storeListingDetails(id(1), page('Zimmer.'), NOW);
    giveQuery(V, 'https://www.wg-gesucht.de/other.html'); // ...but bob's
    const { worker } = setup([reply()], { users: (client) => [userOf(client, U), userOf(client, V)] });
    const r = await worker.drain();
    expect(r.done).toBe(1);
    expect(getUserListing(V, '1').llm_status).toBe('done');
    expect(getUserListing(U, '1').llm_status).toBe('pending');
  });

  it('limit applies to the merged queue', async () => {
    for (const n of [1, 2]) seed(n, 'Zimmer in normaler WG.', [U, V]);
    const { worker } = setup([reply(), reply(), reply()], {
      users: (client) => [userOf(client, U), userOf(client, V)],
    });
    expect((await worker.drain({ limit: 3 })).done).toBe(3);
  });
});

describe('#llm worker onAssessed hook', () => {
  it('is called with the user and provider id after the assessment is stored and merged, not for failures or skips', async () => {
    seed(1);
    seed(2);
    seed(3, '');
    const seen = [];
    const { worker } = setup([reply(), new LlmError('boom')], {
      onAssessed: async (userId, providerId) => {
        const row = getUserListing(userId, providerId);
        seen.push([userId, providerId, row.llm_status, JSON.parse(row.scores_json).llm !== undefined]);
      },
    });
    await worker.drain();
    expect(seen).toEqual([[U, '2', 'done', true]]); // the queue starts with the newest listing; listing 1 fails
  });

  it('a throwing hook never fails the assessment', async () => {
    seed(1);
    const { worker } = setup([reply()], {
      onAssessed: async () => {
        throw new Error('mail down');
      },
    });
    const r = await worker.drain();
    expect(r).toMatchObject({ done: 1, failed: 0 });
    expect(getUserListing(U, '1').llm_status).toBe('done');
  });
});
