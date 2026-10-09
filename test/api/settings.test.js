import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { createApp } from '../../lib/api/api.js';
import { makeUsers, login, asUser, SECRET } from '../helpers/auth.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { createUserDirectory } from '../../lib/users/directory.js';
import { getStoredSettings } from '../../lib/services/settings/userSettingsStorage.js';
import { parseConfig } from '../../lib/config.js';
import { getUserListing } from '../../lib/services/listings/listingsStorage.js';
import { seedAssessed } from '../notify/helpers.js';

let users;
let raw;
let alice;
let bob;
let directory;
let geocoded;
let mails;
let events;
let geocodeResult;
let mailerOver;

beforeAll(async () => {
  users = await makeUsers();
});

async function build() {
  const notify = parseConfig({ searches: [{ url: 'https://www.wg-gesucht.de/x.html' }] }).notify;
  directory = createUserDirectory({ users, evaluation: defaultEvaluationConfig(), notify, model: 'm' });
  raw = await createApp({
    auth: { users, secret: SECRET },
    directory,
    geocoder: {
      geocode: async (q) => {
        geocoded.push(q);
        return geocodeResult(q);
      },
    },
    mailer: {
      dryRun: false,
      reason: null,
      send: async (mail) => void mails.push(mail),
      ...mailerOver,
    },
    pipeline: {
      reevaluate: async (opts) => void events.push(['reevaluate', opts]),
      kickLlm: () => void events.push(['kickLlm']),
    },
  });
  alice = asUser(raw, await login(raw, 'alice', '10.0.0.1'));
  bob = asUser(raw, await login(raw, 'bob', '10.0.0.2'));
}

beforeEach(async () => {
  Db.close();
  Db.init(':memory:');
  await runMigrations();
  geocoded = [];
  mails = [];
  events = [];
  mailerOver = {};
  geocodeResult = (q) => (q.includes('Garching') ? { lat: 48.2649, lng: 11.6711 } : null);
  await build();
});
afterEach(async () => {
  await raw.close();
  Db.close();
});

const get = (who) => who.inject({ method: 'GET', url: '/api/settings' });
const put = (who, payload) => who.inject({ method: 'PUT', url: '/api/settings', payload });

describe('#api settings', () => {
  it("GET returns the user's settings (defaults until they save) and the defaults for a reset", async () => {
    const res = await get(alice);
    expect(res.statusCode).toBe(200);
    const { settings, defaults } = res.json();
    expect(settings.scoring.rent).toEqual({ best: 450, worst: 750 });
    expect(settings.scoring.target).toMatchObject({ lat: 49.0127803, lng: 8.4156386 });
    expect(settings.llm.hideIneligible).toBe(true);
    expect(settings.notify).toMatchObject({ email: 'alice@example.org', enabled: true, maxAgeHours: 24 });
    expect(settings.notify.priority.rules).toEqual([{ overall: { gt: 7 }, ai: { gt: 7 } }]);
    expect(defaults).toEqual(settings);
    expect((await get(bob)).json().settings.notify.email).toBeNull();
  });

  it('PUT saves a partial update and answers the complete new settings; GET and the directory see it', async () => {
    const res = await put(alice, {
      llm: { profile: 'Anna, 22, quiet.' },
      scoring: { rent: { best: 400 } },
      notify: { email: 'new@example.org' },
    });
    expect(res.statusCode).toBe(200);
    const { settings } = res.json();
    expect(settings.llm.profile).toBe('Anna, 22, quiet.');
    expect(settings.scoring.rent).toEqual({ best: 400, worst: 750 });
    expect(settings.notify.email).toBe('new@example.org');
    expect((await get(alice)).json().settings).toEqual(settings);
    expect(directory.settings('alice').llm.profile).toBe('Anna, 22, quiet.');
    expect(getStoredSettings('alice').scoring.rent.best).toBe(400);
  });

  it("settings are private: one user's update never shows for another", async () => {
    await put(alice, {
      llm: { profile: 'ALICE-ONLY' },
      notify: { email: 'alice-new@example.org' },
      scoring: { keywords: ['Corps'] },
    });
    const bobSettings = (await get(bob)).json().settings;
    expect(bobSettings.llm.profile).not.toBe('ALICE-ONLY');
    expect(bobSettings.notify.email).toBeNull();
    expect(bobSettings.scoring.keywords).toContain('Studentenverbindung');
    expect(getStoredSettings('bob')).toBeNull();
    await put(bob, { llm: { profile: 'BOB-ONLY' } });
    expect((await get(alice)).json().settings.llm.profile).toBe('ALICE-ONLY');
  });

  it('PUT cannot address another user: the session decides whose settings change', async () => {
    const res = await put(bob, { userId: 'alice', llm: { profile: 'mine' } });
    expect(res.statusCode).toBe(400); // there is no such setting
    expect(getStoredSettings('alice')).toBeNull();
    expect(getStoredSettings('bob')).toBeNull();
    await put(bob, { llm: { profile: 'mine' } });
    expect(getStoredSettings('alice')).toBeNull();
    expect(getStoredSettings('bob').llm.profile).toBe('mine');
  });

  it('PUT recomputes the tiers of the user (only theirs) when the alert rules change', async () => {
    const settingsHash = directory.context('alice').llmHash;
    seedAssessed(1, { userId: 'alice', overall: 8, fit: 8, settingsHash });
    seedAssessed(1, { userId: 'bob', overall: 8, fit: 8, settingsHash });
    await put(alice, { notify: { email: 'new@example.org' } });
    expect(getUserListing('alice', '1').tier).toBeNull(); // rules unchanged: nothing recomputed
    await put(alice, {
      notify: { priority: { rules: [{ overall: { gt: 9 } }] }, bulk: { rules: [{ overall: { gt: 7 } }] } },
    });
    expect(getUserListing('alice', '1').tier).toBe('good');
    expect(getUserListing('bob', '1').tier).toBeNull();
  });

  it.each([
    [{ scoring: { rent: { best: 5, worst: 5 } } }, /rent: best and worst must differ/],
    [{ scoring: { bogus: 1 } }, /unknown setting "scoring\.bogus"/],
    [{ notify: { email: 'nope' } }, /email/],
    [{ llm: { profile: 'x'.repeat(5000) } }, /at most 4000/],
    [{ notify: { priority: { rules: [{ foo: { gt: 1 } }] } } }, /unknown field/],
  ])('PUT rejects %j with 400 and a readable message, saving nothing', async (body, message) => {
    const res = await put(alice, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
    expect(getStoredSettings('alice')).toBeNull();
    expect(events).toEqual([]);
  });

  it('PUT rejects a body that is not an object', async () => {
    expect((await put(alice, [1, 2])).statusCode).toBe(400);
    expect(
      (
        await alice.inject({
          method: 'PUT',
          url: '/api/settings',
          payload: 'text',
          headers: { 'content-type': 'text/plain' },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  describe('the scoring target', () => {
    it('geocodes a changed address and stores the coordinates; the name follows when not given', async () => {
      const res = await put(alice, { scoring: { target: { address: 'Boltzmannstraße 15, Garching' } } });
      expect(res.statusCode).toBe(200);
      expect(geocoded).toEqual(['Boltzmannstraße 15, Garching']);
      expect(res.json().settings.scoring.target).toEqual({
        name: 'Boltzmannstraße 15, Garching',
        address: 'Boltzmannstraße 15, Garching',
        lat: 48.2649,
        lng: 11.6711,
      });
      expect(directory.context('alice').target).toMatchObject({ lat: 48.2649, lng: 11.6711 });
    });

    it('keeps a name that was sent with the address', async () => {
      const res = await put(alice, { scoring: { target: { name: 'Uni Garching', address: 'Garching bei München' } } });
      expect(res.json().settings.scoring.target).toMatchObject({
        name: 'Uni Garching',
        address: 'Garching bei München',
      });
    });

    it('does not geocode when the address is unchanged, and ignores coordinates sent by the client', async () => {
      const res = await put(alice, {
        scoring: { target: { lat: 1, lng: 2, address: 'Straße am Forum 1, 76131 Karlsruhe' } },
      });
      expect(res.statusCode).toBe(200);
      expect(geocoded).toEqual([]);
      expect(res.json().settings.scoring.target).toMatchObject({ lat: 49.0127803, lng: 8.4156386 });
    });

    it('answers 422 for an address nobody can find, and saves nothing', async () => {
      const res = await put(alice, { scoring: { target: { address: 'Nowhereville 1' }, rent: { best: 400 } } });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/Nowhereville 1/);
      expect(getStoredSettings('alice')).toBeNull();
      expect(events).toEqual([]);
    });

    it('rejects an empty address', async () => {
      expect((await put(alice, { scoring: { target: { address: '   ' } } })).statusCode).toBe(400);
    });

    it('limits address lookups per user (the geocoder is rate limited and shared)', async () => {
      let last;
      for (let i = 0; i < 11; i++) last = await put(alice, { scoring: { target: { address: `Garching ${i}` } } });
      expect(last.statusCode).toBe(429);
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
      expect((await put(bob, { scoring: { target: { address: 'Garching 1' } } })).statusCode).toBe(200); // other users unaffected
    });
  });

  describe('what a change sets in motion', () => {
    it("scoring changes re-run that user's rule evaluation (all listings)", async () => {
      await put(alice, { scoring: { rent: { best: 400 } } });
      expect(events).toEqual([['reevaluate', { userId: 'alice', all: true }]]);
    });

    it("auto-reject changes re-run that user's evaluation (all listings), and only that user's", async () => {
      await put(alice, { autoReject: { shortTerm: { enabled: true, minMonths: 3 } } });
      expect(events).toEqual([['reevaluate', { userId: 'alice', all: true }]]);
      expect(directory.settings('alice').autoReject.shortTerm).toEqual({ enabled: true, minMonths: 3 });
      expect(directory.settings('bob').autoReject.shortTerm).toEqual({ enabled: false, minMonths: 6 });
      events.length = 0;
      await put(alice, { autoReject: { shortTerm: { enabled: true, minMonths: 3 } } }); // unchanged
      expect(events).toEqual([]);
    });

    it('so does the hide-ineligible switch (it changes how a stored assessment is applied)', async () => {
      await put(bob, { llm: { hideIneligible: false } });
      expect(events).toEqual([['reevaluate', { userId: 'bob', all: true }]]);
    });

    it('a new AI profile wakes the AI queue (assessments made with the old profile are queued again by their hash)', async () => {
      await put(alice, { llm: { profile: 'A different profile.' } });
      expect(events).toEqual([['kickLlm']]);
    });

    it('notification-only changes trigger nothing', async () => {
      await put(alice, { notify: { enabled: false, email: 'x@example.org' } });
      expect(events).toEqual([]);
    });

    it('saving identical settings triggers nothing', async () => {
      const { settings } = (await get(alice)).json();
      await put(alice, settings);
      expect(events).toEqual([]);
    });

    it('a failing background job never fails the request', async () => {
      await raw.close();
      raw = await createApp({
        auth: { users, secret: SECRET },
        directory,
        pipeline: {
          reevaluate: async () => {
            throw new Error('boom');
          },
          kickLlm: () => {
            throw new Error('boom');
          },
        },
      });
      alice = asUser(raw, await login(raw, 'alice', '10.0.0.7'));
      expect((await put(alice, { scoring: { rent: { best: 400 } }, llm: { profile: 'x' } })).statusCode).toBe(200);
    });
  });
});

describe('#api test mail', () => {
  const send = (who) => who.inject({ method: 'POST', url: '/api/settings/test-mail' });

  it("sends one test email to the user's own notification address", async () => {
    const res = await send(alice);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true, to: 'alice@example.org' });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'alice@example.org', subject: expect.stringContaining('test email') });
    expect(mails[0].text).toContain('alice');
  });

  it("uses the address saved in the settings, never another user's", async () => {
    await put(bob, { notify: { email: 'bob@example.org' } });
    await send(bob);
    expect(mails.map((m) => m.to)).toEqual(['bob@example.org']);
  });

  it('answers 400 when the user has no address (only the admin falls back to MAIL_TO, via the mailer default)', async () => {
    const res = await send(bob);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/email address/);
    expect(mails).toEqual([]);
    await put(alice, { notify: { email: null } });
    const owner = await send(alice);
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({ sent: true, to: null });
    expect(mails[0].to).toBeUndefined(); // the mailer's default recipient (MAIL_TO)
  });

  it('answers 503 and says why when this server cannot send (SMTP not configured, dry run)', async () => {
    mailerOver = { dryRun: true, reason: 'SMTP is not configured (missing SMTP_HOST)' };
    await raw.close();
    await build();
    const res = await send(alice);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/SMTP is not configured/);
    expect(mails).toEqual([]);
  });

  it('answers 502 with the (already redacted) transport error when sending fails', async () => {
    mailerOver = {
      send: async () => {
        throw new Error('535 authentication failed');
      },
    };
    await raw.close();
    await build();
    const res = await send(alice);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('535 authentication failed');
  });

  it('is rate limited per user: 3 test mails per 10 minutes', async () => {
    for (let i = 0; i < 3; i++) expect((await send(alice)).statusCode).toBe(200);
    const blocked = await send(alice);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(mails).toHaveLength(3);
    await put(bob, { notify: { email: 'bob@example.org' } });
    expect((await send(bob)).statusCode).toBe(200);
  });

  it('needs a login', async () => {
    expect((await raw.inject({ method: 'POST', url: '/api/settings/test-mail' })).statusCode).toBe(401);
    expect((await raw.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
    expect((await raw.inject({ method: 'PUT', url: '/api/settings', payload: {} })).statusCode).toBe(401);
  });
});
