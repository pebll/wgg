import { tierFor } from './tier.js';
import { composePriority, composeDigest } from './composer.js';
import { formatDryRun } from './mailer.js';
import { selectNotifyCandidates, notifyValues, claimNotified, releaseNotified } from './notifyStorage.js';
import { getLastSlot, claimSlot, releaseSlot } from './scheduleStorage.js';
import {
  DEFAULT_WINDOW,
  DEFAULT_INTERVAL_HOURS,
  inWindow,
  dueSlot,
  nextSlot,
  nextWindowStart,
  closedHours,
} from '../../ui/src/services/schedule.js';
import { selectNextPendingDetail, getLlmCounts, toApiListing } from '../services/listings/listingsStorage.js';
import logger from '../services/logger.js';

/**
 * Email alerts, per user and only after the AI assessment (see selectNotifyCandidates for who is eligible). Each user
 * has their own thresholds, age limit and address (their notification settings); a user's alerts only ever contain
 * that user's listings, scores and AI assessments.
 *
 *  - Priority: right after the LLM worker stored an assessment (`notifyPriority`), one email for a listing that
 *    matches the user's `priority.rules`.
 *    Both tiers have their own switch per user (`priority.enabled`, `bulk.enabled`): a tier that is off mails nothing and
 *    marks nothing (turning it on later announces what is still within `maxAgeHours`); the tiers themselves (filter) are
 *    unaffected.
 *  - Bulk: `notifyPending({idle: true})` sends ONE digest per user of the listings matching their `bulk.rules` that were
 *    not announced yet. Call it when the detail + AI queues have no work left; with `idle: false` only the priority
 *    catch-up runs.
 *
 * Send schedule (ui/src/services/schedule.js; local time of the server; per user `priority.window`, `bulk.window`,
 * `bulk.intervalHours`): Fantastic mails go out right away only inside their window; outside it the listings stay
 * unmarked and, once the window opens, the next trigger (the timer of `wgg run` checks every minute) sends ONE combined
 * morning mail for those that qualified while it was closed. The Good digest goes out only at a slot (window.from + k *
 * interval) and once per slot (the last slot is stored per user, claimed before sending); what arrives outside the
 * window waits for the first slot. Offers that wait are judged by their age at the AI assessment (see waitHours in
 * notifyStorage.js), so the night never drops them.
 *
 * Recipient: the user's notification email; the owner (first admin) falls back to MAIL_TO from .env; a user with no
 * address gets nothing (and nothing is marked as announced). Never twice: a listing is claimed (atomic UPDATE ... WHERE
 * notified_at IS NULL) before it is sent; a failed send releases it again with the error stored (up to 3 attempts, see
 * notifyStorage.js). A dry run (mailer or `notify.dryRun`) sends and marks nothing.
 *
 * @param {object} params
 * @param {{enabled: boolean, dryRun?: boolean}} params.config The global `notify` section (master switch, dry run).
 * @param {{dryRun: boolean, reason: string|null, send: Function}} params.mailer
 * @param {ReturnType<import('../users/directory.js').createUserDirectory>} params.directory Users and their settings.
 * @param {string} [params.appUrl] `server.publicUrl`: mails link back to the app with it.
 * @param {() => number} [params.now]
 * @param {{info: Function, warn: Function, error: Function}} [params.log]
 * @param {(text: string) => void} [params.print] Where a `notify.dryRun` email is printed (default: the logger).
 */
export function createNotifier({
  config,
  mailer,
  directory,
  appUrl,
  now = Date.now,
  log = logger,
  print = (text) => log.info(text),
}) {
  let tail = Promise.resolve();
  /** One notification run at a time in this process (the claim keeps other processes from double-sending). */
  const serialized = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const forceDry = config.dryRun === true;
  const none = () => ({ sent: 0, would: 0, failed: 0 });

  /**
   * What one user's alerts need, or null when they get none: alerts switched off (globally or by the user) or nobody to
   * send to. `to` undefined means "the mailer's default address" (MAIL_TO, only for the owner).
   */
  function recipientOf(userId) {
    if (!config.enabled) return null;
    const ctx = directory.context(userId);
    const n = ctx.settings.notify;
    if (!n.enabled) return null;
    const to = n.email || undefined;
    if (to === undefined && directory.owner()?.username !== userId) return null;
    return { ctx, notify: n, to };
  }

  const candidates = (r, providerId, waitHours = 0) =>
    selectNotifyCandidates({
      userId: r.ctx.userId,
      now: now(),
      maxAgeHours: r.notify.maxAgeHours,
      settingsHash: r.ctx.llmHash,
      providerId,
      waitHours,
    });

  /** The user's send schedule (a missing key counts as the default, like the other settings). */
  const scheduleOf = (r) => ({
    priorityWindow: r.notify.priority?.window ?? DEFAULT_WINDOW,
    bulkWindow: r.notify.bulk?.window ?? DEFAULT_WINDOW,
    interval: r.notify.bulk?.intervalHours ?? DEFAULT_INTERVAL_HOURS,
  });

  /** Sends or (dry) prints one mail for `rows`; returns how many listings went out / would go out / failed. */
  async function deliver(r, rows, kind, mail) {
    const userId = r.ctx.userId;
    const message = { ...mail, ...(r.to ? { to: r.to } : {}) };
    if (forceDry) {
      print(formatDryRun(mail, 'notify.dryRun'));
      return { sent: 0, would: rows.length, failed: 0 };
    }
    if (mailer.dryRun) {
      await mailer.send(message);
      return { sent: 0, would: rows.length, failed: 0 };
    }
    const claimed = rows.filter((row) => claimNotified(userId, row.id, kind, now()));
    if (claimed.length === 0) return none();
    try {
      await mailer.send(message);
    } catch (error) {
      releaseNotified(
        userId,
        claimed.map((row) => row.id),
        error.message,
      );
      log.warn(`Email alert (${kind}, ${claimed.length} listing(s), ${userId}) failed: ${error.message}`);
      return { sent: 0, would: 0, failed: claimed.length };
    }
    log.info(`Email alert sent to ${userId} (${kind}): ${mail.subject}`);
    return { sent: claimed.length, would: 0, failed: 0 };
  }

  /** The tier of a candidate row: the same function that fills the filter in the UI (see tier.js). */
  const tierOf = (r, row) => tierFor(r.notify, notifyValues(row));

  /**
   * The user's per-tier switch (`notify.priority.enabled` / `notify.bulk.enabled`); a missing key counts as on. A tier
   * that is off sends nothing and marks nothing, and its listings are never moved into the other tier's mail.
   */
  const tierEnabled = (r, section) => r.notify[section]?.enabled !== false;

  const addTo = (total, out) => {
    total.sent += out.sent;
    total.would += out.would;
    total.failed += out.failed;
  };

  /**
   * Fantastic mails for `rows` (the window is open). Offers that qualified while the window was closed go out together
   * (one mail, or the normal layout for a single one); the others get one mail each, as ever.
   */
  async function priorityRows(r, rows, window) {
    const total = none();
    const args = { now: now(), appUrl, targetName: r.ctx.target.name };
    const queued = rows.filter(
      (row) => typeof row.llm_evaluated_at === 'number' && !inWindow(window, row.llm_evaluated_at),
    );
    for (const row of rows.filter((x) => !queued.includes(x))) {
      addTo(total, await deliver(r, [row], 'priority', composePriority(toApiListing(row), args)));
    }
    if (queued.length === 1) {
      addTo(total, await deliver(r, queued, 'priority', composePriority(toApiListing(queued[0]), args)));
    } else if (queued.length > 1) {
      addTo(
        total,
        await deliver(r, queued, 'priority', composeDigest(queued.map(toApiListing), { ...args, tier: 'fantastic' })),
      );
    }
    return total;
  }

  return {
    /**
     * Priority alert for one listing of one user, called right after its assessment was stored.
     * @param {string} userId
     * @param {string} providerId
     */
    notifyPriority(userId, providerId) {
      return serialized(async () => {
        const r = recipientOf(userId);
        if (!r) return none();
        if (!tierEnabled(r, 'priority')) return none();
        const { priorityWindow } = scheduleOf(r);
        if (!inWindow(priorityWindow, now())) return none(); // stays pending: the morning mail sends it
        const rows = candidates(r, providerId).filter((row) => tierOf(r, row) === 'fantastic');
        return rows.length === 0 ? none() : priorityRows(r, rows, priorityWindow);
      });
    },

    /**
     * Catch-up priority mails for everything that matches and may go out now, then (with `idle`) the bulk digest when a
     * slot is due, for every user. What the schedule holds back is reported in `queued`.
     * @param {{idle?: boolean}} [options] `idle`: the detail + AI queues have no processable work left.
     * @returns {Promise<{priority: number, bulk: number, failed: number, dryRun: boolean,
     *   queued: {userId: string, tier: 'priority'|'bulk', count: number, until: number}[]}>} Listings announced (or
     *   that would be announced in a dry run), summed over all users, and per user and tier the offers waiting for the
     *   schedule with the time they go out.
     */
    notifyPending({ idle = false } = {}) {
      return serialized(async () => {
        const dryRun = forceDry || mailer.dryRun;
        const result = { priority: 0, bulk: 0, failed: 0, dryRun, queued: [] };
        for (const user of directory.users) {
          const r = recipientOf(user.username);
          if (!r) continue;
          const userId = r.ctx.userId;
          const { priorityWindow, bulkWindow, interval } = scheduleOf(r);
          if (tierEnabled(r, 'priority')) {
            const priority = candidates(r, undefined, closedHours(priorityWindow)).filter(
              (row) => tierOf(r, row) === 'fantastic',
            );
            if (!inWindow(priorityWindow, now())) {
              if (priority.length > 0) {
                const until = nextWindowStart(priorityWindow, now());
                result.queued.push({ userId, tier: 'priority', count: priority.length, until });
              }
            } else {
              const p = await priorityRows(r, priority, priorityWindow);
              result.priority += p.sent + p.would;
              result.failed += p.failed;
            }
          }
          if (!idle || !tierEnabled(r, 'bulk')) continue;

          // 'good' = matches the bulk rules and is not fantastic (a fantastic one is sent on its own above).
          const bulk = candidates(r, undefined, closedHours(bulkWindow) + interval).filter(
            (row) => tierOf(r, row) === 'good',
          );
          if (bulk.length === 0) continue;
          const slot = dueSlot(bulkWindow, interval, now());
          const last = getLastSlot(userId, 'bulk');
          if (slot === null || (last !== null && slot <= last)) {
            const until = nextSlot(bulkWindow, interval, now());
            result.queued.push({ userId, tier: 'bulk', count: bulk.length, until });
            continue;
          }
          // A dry run neither uses up the slot nor marks anything.
          const claim = dryRun ? null : claimSlot(userId, 'bulk', slot);
          if (claim && !claim.claimed) continue;
          const b = await deliver(
            r,
            bulk,
            'bulk',
            composeDigest(bulk.map(toApiListing), { now: now(), appUrl, targetName: r.ctx.target.name }),
          );
          if (claim && b.sent === 0) releaseSlot(userId, 'bulk', slot, claim.previous); // failed: retry at the next check
          result.bulk += b.sent + b.would;
          result.failed += b.failed;
        }
        return result;
      });
    },

    /**
     * True while the detail queue has pending pages or (with an LLM worker) some user's AI queue has pending
     * assessments. Failed assessments waiting for a retry do not count: they are retried on the next cycle.
     * @param {{detailMaxAgeDays: number, llmAvailable: boolean}} options
     */
    hasProcessableWork({ detailMaxAgeDays, llmAvailable }) {
      if (selectNextPendingDetail({ now: now(), maxAgeDays: detailMaxAgeDays })) return true;
      return (
        llmAvailable &&
        directory
          .contexts()
          .some(
            (ctx) => getLlmCounts(ctx.userId, ctx.llmHash, { maxAgeDays: detailMaxAgeDays, now: now() }).pending > 0,
          )
      );
    },

    /** The trigger for "the bulk is done": priority catch-up always, the digest only when no work is left. */
    notifyWhenIdle({ detailMaxAgeDays, llmAvailable }) {
      const idle = !this.hasProcessableWork({ detailMaxAgeDays, llmAvailable });
      return this.notifyPending({ idle });
    },
  };
}
