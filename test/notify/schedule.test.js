import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { getUserListing } from '../../lib/services/listings/listingsStorage.js';
import { saveSettings } from '../../lib/services/settings/userSettingsStorage.js';
import { createNotifier } from '../../lib/notify/notifier.js';
import { getLastSlot, claimSlot, releaseSlot } from '../../lib/notify/scheduleStorage.js';
import { USER, makeDirectory, seedAssessed } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };
const at = (h, m = 0, day = 2) => new Date(2026, 9, day, h, m, 0, 0).getTime();
const kind = (p) => getUserListing(USER, String(p)).notified_kind;

/** A notifier whose clock the test moves (`clock.t`); several notifiers over the same database model a restart. */
function setup(notify = {}, mailerOver = {}, t = at(12, 30)) {
  const { directory, config } = makeDirectory(notify);
  const clock = { t };
  const sent = [];
  const mailer = { dryRun: false, reason: null, send: async (mail) => void sent.push(mail), ...mailerOver };
  const make = () => createNotifier({ config, mailer, directory, now: () => clock.t, log: silent, print() {} });
  return { notifier: make(), make, sent, clock };
}

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(() => Db.reset());

describe('#schedule storage', () => {
  it('remembers the last slot per user and tier and never moves it back', () => {
    expect(getLastSlot(USER, 'bulk')).toBeNull();
    expect(claimSlot(USER, 'bulk', at(10))).toEqual({ claimed: true, previous: null });
    expect(claimSlot(USER, 'bulk', at(10))).toMatchObject({ claimed: false });
    expect(claimSlot(USER, 'bulk', at(9))).toMatchObject({ claimed: false });
    expect(claimSlot(USER, 'bulk', at(11))).toEqual({ claimed: true, previous: at(10) });
    expect(getLastSlot('bob', 'bulk')).toBeNull();
    expect(getLastSlot(USER, 'priority')).toBeNull();
  });

  it('releases a claim back to the previous slot', () => {
    claimSlot(USER, 'bulk', at(10));
    const { previous } = claimSlot(USER, 'bulk', at(11));
    releaseSlot(USER, 'bulk', at(11), previous);
    expect(getLastSlot(USER, 'bulk')).toBe(at(10));
    claimSlot(USER, 'bulk', at(12));
    releaseSlot(USER, 'bulk', at(11), at(10)); // not the current claim: ignored
    expect(getLastSlot(USER, 'bulk')).toBe(at(12));
  });
});

describe('#Fantastic outside the window', () => {
  it('is not mailed and stays pending, but is mailed instantly inside the window', async () => {
    seedAssessed(1, { overall: 9, fit: 9 });
    const night = setup({}, {}, at(23, 30));
    expect(await night.notifier.notifyPriority(USER, '1')).toMatchObject({ sent: 0, failed: 0 });
    expect(night.sent).toHaveLength(0);
    expect(getUserListing(USER, '1').notified_at).toBeNull();
    night.clock.t = at(12, 30);
    expect(await night.notifier.notifyPriority(USER, '1')).toMatchObject({ sent: 1 });
    expect(kind(1)).toBe('priority');
  });

  it('is sent as ONE combined morning email when the window opens', async () => {
    const wait = { assessedAt: at(2), publishedAt: at(1, 30, 3) };
    seedAssessed(1, { overall: 8.2, fit: 8, ...wait });
    seedAssessed(2, { overall: 9.1, fit: 9, ...wait, assessedAt: at(3, 0, 3) });
    seedAssessed(3, { overall: 8.7, fit: 8, ...wait, assessedAt: at(4, 0, 3) });
    const t = setup({}, {}, at(6, 59, 3));
    for (const n of [1, 2, 3]) await t.notifier.notifyPriority(USER, String(n));
    const before = await t.notifier.notifyPending({ idle: true });
    expect(before.priority).toBe(0);
    expect(t.sent).toHaveLength(0);
    t.clock.t = at(7, 0, 3);
    const r = await t.notifier.notifyPending({ idle: true });
    expect(r.priority).toBe(3);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].subject).toBe('✦ 3 Fantastic offers overnight — WG Gefunden!');
    expect(t.sent[0].text.indexOf('Room 2')).toBeLessThan(t.sent[0].text.indexOf('Room 3'));
    for (const n of [1, 2, 3]) expect(kind(n)).toBe('priority');
    await t.notifier.notifyPending({ idle: true });
    expect(t.sent).toHaveLength(1);
  });

  it('uses the normal single-offer layout when only one is waiting', async () => {
    seedAssessed(1, { overall: 9, fit: 9, assessedAt: at(2, 0, 3), publishedAt: at(1, 0, 3) });
    const t = setup({}, {}, at(7, 0, 3));
    await t.notifier.notifyPending({ idle: false });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].subject).toContain('✦ Fantastic: ★ 9');
  });

  it('reports what is queued and until when (for the dry run)', async () => {
    seedAssessed(1, { overall: 9, fit: 9 });
    seedAssessed(2, { overall: 9, fit: 9 });
    const t = setup({}, {}, at(23, 30));
    const r = await t.notifier.notifyPending({ idle: true });
    expect(r.queued).toEqual([{ userId: USER, tier: 'priority', count: 2, until: at(7, 0, 3) }]);
  });

  it('does not drop offers that qualified during the night to the age limit', async () => {
    // posted 23:30, assessed 23:40 (window closed since 23:00), maxAgeHours 2: at 07:00 it is 7.5 h old
    seedAssessed(1, { overall: 9, fit: 9, publishedAt: at(23, 30), assessedAt: at(23, 40) });
    // the same age, but assessed long before the waiting time can explain: stays dropped
    seedAssessed(2, { overall: 9, fit: 9, publishedAt: at(10), assessedAt: at(10, 30) });
    const t = setup({ maxAgeHours: 2 }, {}, at(7, 0, 3));
    const r = await t.notifier.notifyPending({ idle: false });
    expect(r.priority).toBe(1);
    expect(kind(1)).toBe('priority');
    expect(kind(2)).toBeNull();
  });

  it('honours a custom window per user', async () => {
    seedAssessed(1, { overall: 9, fit: 9 });
    const t = setup({ priority: { window: { from: 13, to: 20 } } }, {}, at(12, 30));
    expect(await t.notifier.notifyPriority(USER, '1')).toMatchObject({ sent: 0 });
    t.clock.t = at(13, 0);
    expect(await t.notifier.notifyPriority(USER, '1')).toMatchObject({ sent: 1 });
  });
});

describe('#Good slots', () => {
  it('sends one digest per slot, the next one at the next slot', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    const t = setup({}, {}, at(12, 30));
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(1);
    seedAssessed(2, { overall: 6, fit: 6 });
    t.clock.t = at(12, 45);
    const waiting = await t.notifier.notifyPending({ idle: true });
    expect(waiting.bulk).toBe(0);
    expect(waiting.queued).toEqual([{ userId: USER, tier: 'bulk', count: 1, until: at(13) }]);
    t.clock.t = at(13, 0);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(1);
    expect(t.sent).toHaveLength(2);
  });

  it('follows the interval: 3 h means slots at 7, 10, 13, 16, 19, 22', async () => {
    const t = setup({ bulk: { intervalHours: 3 } }, {}, at(13, 30));
    seedAssessed(1, { overall: 6, fit: 6 });
    await t.notifier.notifyPending({ idle: true });
    seedAssessed(2, { overall: 6, fit: 6 });
    t.clock.t = at(15, 59);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(0);
    t.clock.t = at(16, 0);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(1);
  });

  it('collects what arrives outside the window into one morning digest', async () => {
    const t = setup({}, {}, at(23, 5));
    seedAssessed(1, { overall: 6, fit: 6 });
    await t.notifier.notifyPending({ idle: true }); // slot 23:00
    seedAssessed(2, { overall: 6, fit: 6 });
    seedAssessed(3, { overall: 7, fit: 6 });
    t.clock.t = at(23, 40);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(0);
    t.clock.t = at(6, 59, 3);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(0);
    t.clock.t = at(7, 0, 3);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(2);
    expect(t.sent.map((m) => m.subject)).toEqual(['1 good offer — WG Gefunden!', '2 good offers — WG Gefunden!']);
  });

  it('waits for the queues to be idle even when the slot is reached', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    const t = setup({}, {}, at(12, 30));
    expect((await t.notifier.notifyPending({ idle: false })).bulk).toBe(0);
    expect(t.sent).toHaveLength(0);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(1);
  });

  it('does not use up a slot without offers', async () => {
    const t = setup({}, {}, at(12, 30));
    await t.notifier.notifyPending({ idle: true });
    expect(getLastSlot(USER, 'bulk')).toBeNull();
    seedAssessed(1, { overall: 6, fit: 6 });
    t.clock.t = at(12, 50);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(1);
  });

  it('survives a restart: a new notifier knows the slot was used', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    const t = setup({}, {}, at(12, 30));
    await t.notifier.notifyPending({ idle: true });
    seedAssessed(2, { overall: 6, fit: 6 });
    t.clock.t = at(12, 50);
    expect((await t.make().notifyPending({ idle: true })).bulk).toBe(0);
    t.clock.t = at(13, 0);
    expect((await t.make().notifyPending({ idle: true })).bulk).toBe(1);
  });

  it('gives the slot back when the send fails, so the next check retries', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    let fail = true;
    const t = setup(
      {},
      {
        send: async function (mail) {
          if (fail) throw new Error('smtp down');
          t.sent.push(mail);
        },
      },
      at(12, 30),
    );
    expect((await t.notifier.notifyPending({ idle: true })).failed).toBe(1);
    expect(getLastSlot(USER, 'bulk')).toBeNull();
    fail = false;
    t.clock.t = at(12, 31);
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(1);
  });

  it('a dry run uses up no slot and marks nothing', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    const t = setup({}, { dryRun: true, send: async () => {} }, at(12, 30));
    const r = await t.notifier.notifyPending({ idle: true });
    expect(r).toMatchObject({ bulk: 1, dryRun: true });
    expect(getLastSlot(USER, 'bulk')).toBeNull();
    expect(kind(1)).toBeNull();
  });

  it('keeps Good offers of the night within the age limit', async () => {
    seedAssessed(1, { overall: 6, fit: 6, publishedAt: at(22, 30), assessedAt: at(22, 40) });
    const t = setup({ maxAgeHours: 2, bulk: { window: { from: 7, to: 22 } } }, {}, at(7, 0, 3));
    expect((await t.notifier.notifyPending({ idle: true })).bulk).toBe(1);
  });

  it('a switched-off Good tier uses no slot', async () => {
    seedAssessed(1, { overall: 6, fit: 6 });
    saveSettings(USER, { notify: { bulk: { enabled: false } } });
    const t = setup({}, {}, at(12, 30));
    await t.notifier.notifyPending({ idle: true });
    expect(getLastSlot(USER, 'bulk')).toBeNull();
  });
});
