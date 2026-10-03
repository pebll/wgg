import { tierFor } from './tier.js';
import { composePriority, composeDigest } from './composer.js';
import { formatDryRun } from './mailer.js';
import { selectNotifyCandidates, notifyValues, claimNotified, releaseNotified } from './notifyStorage.js';
import { selectNextPendingDetail, getLlmCounts, toApiListing } from '../services/listings/listingsStorage.js';
import logger from '../services/logger.js';

/**
 * Email alerts, per user and only after the AI assessment (see selectNotifyCandidates for who is eligible). Each user
 * has their own thresholds, age limit and address (their notification settings); a user's alerts only ever contain
 * that user's listings, scores and AI assessments.
 *
 *  - Priority: right after the LLM worker stored an assessment (`notifyPriority`), one email for a listing that
 *    matches the user's `priority.rules`.
 *  - Bulk: `notifyPending({idle: true})` sends ONE digest per user of the listings matching their `bulk.rules` that were
 *    not announced yet. Call it when the detail + AI queues have no work left; with `idle: false` only the priority
 *    catch-up runs.
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

  const candidates = (r, providerId) =>
    selectNotifyCandidates({
      userId: r.ctx.userId,
      now: now(),
      maxAgeHours: r.notify.maxAgeHours,
      settingsHash: r.ctx.llmHash,
      providerId,
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

  async function priorityRows(r, rows) {
    const total = none();
    for (const row of rows) {
      const out = await deliver(
        r,
        [row],
        'priority',
        composePriority(toApiListing(row), { now: now(), appUrl, targetName: r.ctx.target.name }),
      );
      total.sent += out.sent;
      total.would += out.would;
      total.failed += out.failed;
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
        const rows = candidates(r, providerId).filter((row) => tierOf(r, row) === 'fantastic');
        return rows.length === 0 ? none() : priorityRows(r, rows);
      });
    },

    /**
     * Catch-up priority mails for everything that matches, then (with `idle`) the bulk digest, for every user.
     * @param {{idle?: boolean}} [options] `idle`: the detail + AI queues have no processable work left.
     * @returns {Promise<{priority: number, bulk: number, failed: number, dryRun: boolean}>} Listings announced (or
     *   that would be announced in a dry run), summed over all users.
     */
    notifyPending({ idle = false } = {}) {
      return serialized(async () => {
        const dryRun = forceDry || mailer.dryRun;
        const result = { priority: 0, bulk: 0, failed: 0, dryRun };
        for (const user of directory.users) {
          const r = recipientOf(user.username);
          if (!r) continue;
          const priority = candidates(r).filter((row) => tierOf(r, row) === 'fantastic');
          const p = await priorityRows(r, priority);
          result.priority += p.sent + p.would;
          result.failed += p.failed;
          if (!idle) continue;

          // 'good' = matches the bulk rules and is not fantastic (a fantastic one was sent on its own above).
          const bulk = candidates(r).filter((row) => tierOf(r, row) === 'good');
          if (bulk.length === 0) continue;
          const b = await deliver(
            r,
            bulk,
            'bulk',
            composeDigest(bulk.map(toApiListing), { now: now(), appUrl, targetName: r.ctx.target.name }),
          );
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
      return llmAvailable && directory.contexts().some((ctx) => getLlmCounts(ctx.userId, ctx.llmHash).pending > 0);
    },

    /** The trigger for "the bulk is done": priority catch-up always, the digest only when no work is left. */
    notifyWhenIdle({ detailMaxAgeDays, llmAvailable }) {
      const idle = !this.hasProcessableWork({ detailMaxAgeDays, llmAvailable });
      return this.notifyPending({ idle });
    },
  };
}
