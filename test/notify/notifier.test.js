import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  getListingByProviderId,
  getUserListing,
  dismissListing,
  storeNewListings,
  storeListingDetails,
} from '../../lib/services/listings/listingsStorage.js';
import { createNotifier } from '../../lib/notify/notifier.js';
import { saveSettings } from '../../lib/services/settings/userSettingsStorage.js';
import { giveQuery } from '../helpers/db.js';
import { NOW, SEARCH, USER, makeDirectory, seedAssessed } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };
const BOB = 'bob';
const TWO_USERS = [
  { username: USER, passwordHash: 'x', admin: true, email: null },
  { username: BOB, passwordHash: 'x', admin: false, email: 'bob@example.org' },
];

function setup(notify = {}, mailerOver = {}, users) {
  const { directory, config } = makeDirectory(notify, users);
  const sent = [];
  const mailer = {
    dryRun: false,
    reason: null,
    send: async (mail) => void sent.push(mail),
    ...mailerOver,
  };
  const notifier = createNotifier({ config, mailer, directory, now: () => NOW, log: silent });
  return { notifier, sent, mailer };
}
const kind = (p, userId = USER) => getUserListing(userId, String(p)).notified_kind;

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(() => Db.reset());

describe('#priority alert', () => {
  it('sends one email for a listing that matches the priority rules and marks it', async () => {
    seedAssessed(1, { overall: 8.4, fit: 8 });
    const { notifier, sent } = setup();
    const r = await notifier.notifyPriority(USER, '1');
    expect(r).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('★ 8.4');
    expect(kind(1)).toBe('priority');
    expect(getUserListing(USER, '1').notified_at).toBe(NOW);
  });

  it('never sends the same listing twice', async () => {
    seedAssessed(1);
    const { notifier, sent } = setup();
    await notifier.notifyPriority(USER, '1');
    await notifier.notifyPriority(USER, '1');
    await Promise.all([notifier.notifyPriority(USER, '1'), notifier.notifyPending({ idle: true })]);
    expect(sent).toHaveLength(1);
  });

  it('ignores listings below the thresholds, unassessed, hidden or too old', async () => {
    seedAssessed(1, { overall: 7 }); // gt 7 is strict
    seedAssessed(2, { fit: 7 });
    seedAssessed(3, { assessed: false });
    seedAssessed(4);
    dismissListing(USER, getListingByProviderId('4').id, NOW, 'messaged');
    seedAssessed(5, { publishedAt: NOW - 48 * 3_600_000 });
    seedAssessed(6, { excluded: 'keyword' });
    const { notifier, sent } = setup();
    for (const n of [1, 2, 3, 4, 5, 6]) await notifier.notifyPriority(USER, String(n));
    expect(sent).toHaveLength(0);
  });

  it('honours extra rules (OR) from the config', async () => {
    seedAssessed(1, { overall: 6, fit: 2, price: 650 });
    seedAssessed(2, { overall: 6, fit: 2, price: 800 });
    const { notifier, sent } = setup({
      priority: {
        rules: [
          { overall: { gt: 7 }, ai: { gt: 7 } },
          { overall: { gt: 5 }, rent: { lt: 700 } },
        ],
      },
    });
    await notifier.notifyPriority(USER, '1');
    await notifier.notifyPriority(USER, '2');
    expect(sent).toHaveLength(1);
    expect(kind(1)).toBe('priority');
    expect(kind(2)).toBeNull();
  });

  it('does nothing when notify is disabled or the priority rule list is empty', async () => {
    seedAssessed(1);
    const off = setup({ enabled: false });
    await off.notifier.notifyPriority(USER, '1');
    const empty = setup({ priority: { rules: [] } });
    await empty.notifier.notifyPriority(USER, '1');
    expect(off.sent.length + empty.sent.length).toBe(0);
    expect(kind(1)).toBeNull();
  });
});

describe('#bulk alert', () => {
  it('sends one digest of all bulk-matching listings, best first, and marks them bulk', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    seedAssessed(2, { overall: 7, fit: 6 });
    seedAssessed(3, { overall: 4, fit: 9 }); // below bulk threshold
    const { notifier, sent } = setup();
    const r = await notifier.notifyPending({ idle: true });
    expect(r).toMatchObject({ priority: 0, bulk: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('2 good offers — WG Gefunden!');
    expect(sent[0].text.indexOf('Room 2')).toBeLessThan(sent[0].text.indexOf('Room 1'));
    expect(kind(1)).toBe('bulk');
    expect(kind(2)).toBe('bulk');
    expect(kind(3)).toBeNull();
  });

  it('does not repeat listings already sent as priority and sends no empty digest', async () => {
    seedAssessed(1, { overall: 8, fit: 8 });
    const { notifier, sent } = setup();
    await notifier.notifyPriority(USER, '1');
    const r = await notifier.notifyPending({ idle: true });
    expect(r.bulk).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('catches up priority-matching listings first (one mail each), the rest goes into the digest', async () => {
    seedAssessed(1, { overall: 9, fit: 9 });
    seedAssessed(2, { overall: 6, fit: 6 });
    seedAssessed(3, { overall: 6, fit: 7 });
    const { notifier, sent } = setup();
    const r = await notifier.notifyPending({ idle: true });
    expect(r).toMatchObject({ priority: 1, bulk: 2 });
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining('★ 9'), '2 good offers — WG Gefunden!']);
    expect(kind(1)).toBe('priority');
  });

  it('holds the digest back while the queues still have work (idle false) but still sends priority mails', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    seedAssessed(2, { overall: 9, fit: 9 });
    const { notifier, sent } = setup();
    const r = await notifier.notifyPending({ idle: false });
    expect(r).toMatchObject({ priority: 1, bulk: 0 });
    expect(sent).toHaveLength(1);
    expect(kind(1)).toBeNull();
  });

  it('bulk rules can be switched off with an empty list', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    const { notifier, sent } = setup({ bulk: { rules: [] } });
    await notifier.notifyPending({ idle: true });
    expect(sent).toHaveLength(0);
  });
});

describe('#failures and dry run', () => {
  it('releases the listing when sending fails, stores the error, and retries on the next trigger', async () => {
    seedAssessed(1);
    let fail = true;
    const { notifier, sent } = setup(
      {},
      {
        send: async (mail) => {
          if (fail) throw new Error('connection refused');
          sent.push(mail);
        },
      },
    );
    const first = await notifier.notifyPriority(USER, '1');
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    let row = getUserListing(USER, '1');
    expect(row).toMatchObject({ notified_at: null, notify_error: 'connection refused', notify_attempts: 1 });
    fail = false;
    await notifier.notifyPending({ idle: true });
    row = getUserListing(USER, '1');
    expect(row).toMatchObject({ notified_kind: 'priority', notify_error: null });
    expect(sent).toHaveLength(1);
  });

  it('gives up after three failed attempts', async () => {
    seedAssessed(1);
    const { notifier } = setup(
      {},
      {
        send: async () => {
          throw new Error('nope');
        },
      },
    );
    for (let i = 0; i < 5; i++) await notifier.notifyPending({ idle: true });
    expect(getUserListing(USER, '1').notify_attempts).toBe(3);
  });

  it('a dry-run mailer sends and marks nothing, in both kinds', async () => {
    seedAssessed(1, { overall: 9, fit: 9 });
    seedAssessed(2, { overall: 6, fit: 6 });
    const logged = [];
    const { notifier } = setup({}, { dryRun: true, send: async (m) => void logged.push(m) });
    const r = await notifier.notifyPending({ idle: true });
    expect(r).toMatchObject({ priority: 1, bulk: 1, dryRun: true });
    expect(logged).toHaveLength(2);
    expect(kind(1)).toBeNull();
    expect(kind(2)).toBeNull();
    expect(getUserListing(USER, '1').notify_attempts).toBe(0);
  });

  it('notify.dryRun in the config forces a dry run even with a real mailer', async () => {
    seedAssessed(1);
    const sentReal = [];
    const { notifier } = setup({ dryRun: true }, { send: async (m) => void sentReal.push(m) });
    await notifier.notifyPriority(USER, '1');
    expect(kind(1)).toBeNull();
  });
});

describe('#idle check', () => {
  it('reports processable work: pending details or pending AI assessments', async () => {
    const { notifier } = setup();
    giveQuery(USER, SEARCH);
    expect(notifier.hasProcessableWork({ detailMaxAgeDays: 7, llmAvailable: true })).toBe(false);
    storeNewListings([{ providerId: '90', link: 'https://www.wg-gesucht.de/x.90.html', title: 't' }], SEARCH, NOW);
    expect(notifier.hasProcessableWork({ detailMaxAgeDays: 7, llmAvailable: true })).toBe(true); // details pending
    storeListingDetails(
      getListingByProviderId('90').id,
      { sections: [], description: 'Text', costs: [], address: null, wgFacts: [], objectFacts: [] },
      NOW,
    );
    expect(notifier.hasProcessableWork({ detailMaxAgeDays: 7, llmAvailable: true })).toBe(true); // AI pending
    expect(notifier.hasProcessableWork({ detailMaxAgeDays: 7, llmAvailable: false })).toBe(false);
  });
});

describe('#app link in alerts', () => {
  it('mails carry the absolute link of the app when one is configured', async () => {
    seedAssessed(1, { overall: 9, fit: 9 });
    const { directory, config } = makeDirectory();
    const sent = [];
    const notifier = createNotifier({
      config,
      directory,
      appUrl: 'https://xn--lo-bja.com/wgg',
      mailer: { dryRun: false, reason: null, send: async (m) => void sent.push(m) },
      now: () => NOW,
      log: silent,
    });
    await notifier.notifyPriority(USER, '1');
    expect(sent[0].text).toContain('https://xn--lo-bja.com/wgg/');
  });
});

describe('#alerts are per user', () => {
  const saveNotify = (userId, notify) => {
    const { directory } = makeDirectory({}, TWO_USERS);
    saveSettings(userId, {
      ...directory.settings(userId),
      notify: { ...directory.settings(userId).notify, ...notify },
    });
  };

  it('each user gets only their own listings, at their own address, with their own thresholds', async () => {
    seedAssessed(1, { overall: 9, fit: 9, userId: USER });
    seedAssessed(2, { overall: 9, fit: 9, userId: BOB });
    seedAssessed(3, { overall: 5.5, fit: 5.5, userId: BOB }); // bulk-only for the default rules
    saveNotify(BOB, { bulk: { rules: [] } });
    const { notifier, sent } = setup({}, {}, TWO_USERS);
    const r = await notifier.notifyPending({ idle: true });
    expect(r).toMatchObject({ priority: 2, bulk: 0 });
    expect(sent.map((m) => [m.to, m.subject.includes('Room')])).toEqual([
      [undefined, false],
      ['bob@example.org', false],
    ]);
    const alice = sent.find((m) => m.to === undefined);
    const bob = sent.find((m) => m.to === 'bob@example.org');
    expect(alice.text).toContain('Room 1');
    expect(alice.text).not.toContain('Room 2');
    expect(bob.text).toContain('Room 2');
    expect(bob.text).not.toContain('Room 1');
    expect(kind(1, USER)).toBe('priority');
    expect(kind(2, BOB)).toBe('priority');
    expect(kind(3, BOB)).toBeNull(); // bob switched his bulk digest off
  });

  it("one user's alert never marks the same listing for the other user", async () => {
    seedAssessed(1, { overall: 9, fit: 9, userId: USER });
    seedAssessed(1, { overall: 9, fit: 9, userId: BOB });
    const { notifier, sent } = setup({}, {}, TWO_USERS);
    await notifier.notifyPriority(USER, '1');
    expect(kind(1, USER)).toBe('priority');
    expect(kind(1, BOB)).toBeNull();
    await notifier.notifyPriority(BOB, '1');
    expect(sent).toHaveLength(2);
  });

  it('a user can switch their alerts off; a user without an address gets none (only the owner falls back to MAIL_TO)', async () => {
    seedAssessed(1, { overall: 9, fit: 9, userId: BOB });
    saveNotify(BOB, { enabled: false });
    const off = setup({}, {}, TWO_USERS);
    await off.notifier.notifyPending({ idle: true });
    expect(off.sent).toHaveLength(0);

    saveNotify(BOB, { enabled: true, email: null });
    const noAddress = setup({}, {}, TWO_USERS);
    await noAddress.notifier.notifyPending({ idle: true });
    expect(noAddress.sent).toHaveLength(0);
    expect(kind(1, BOB)).toBeNull(); // nothing was claimed: it goes out once an address is set
  });

  it('the global notify.enabled switch silences everybody', async () => {
    seedAssessed(1, { overall: 9, fit: 9, userId: BOB });
    const { notifier, sent } = setup({ enabled: false }, {}, TWO_USERS);
    await notifier.notifyPending({ idle: true });
    expect(sent).toHaveLength(0);
  });

  it("only assessments made with the user's current AI settings count (a changed profile holds alerts back)", async () => {
    seedAssessed(1, { overall: 9, fit: 9, userId: USER, settingsHash: 'made-with-an-older-profile' });
    const { notifier, sent } = setup({}, {}, TWO_USERS);
    await notifier.notifyPending({ idle: true });
    expect(sent).toHaveLength(0);
  });

  it("the idle check looks at every user's AI queue", () => {
    giveQuery(BOB, SEARCH);
    storeNewListings([{ providerId: '90', link: 'https://www.wg-gesucht.de/x.90.html', title: 't' }], SEARCH, NOW);
    storeListingDetails(
      getListingByProviderId('90').id,
      { sections: [], description: 'Text', costs: [], address: null, wgFacts: [], objectFacts: [] },
      NOW,
    );
    const { notifier } = setup({}, {}, TWO_USERS);
    expect(notifier.hasProcessableWork({ detailMaxAgeDays: 7, llmAvailable: true })).toBe(true);
  });
});
