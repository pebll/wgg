import fs from 'fs';
import { parseArgs } from 'util';
import path from 'path';
import { loadConfig, ConfigError, DEFAULT_CONFIG_PATH } from '../config.js';
import { loadUsers } from '../auth/users.js';
import { hashPassword } from '../auth/password.js';
import { readSessionSecret } from '../auth/session.js';
import { readPasswordInteractive } from './password.js';
import Db from '../services/storage/Db.js';
import { runMigrations } from '../services/storage/migrations/migrate.js';
import { runCycleWithFetcher } from '../scraper/scrapeCycle.js';
import { createFetchCoordinator } from '../scheduler/fetchCoordinator.js';
import { withBrowserFetcher } from '../services/browserFetcher.js';
import { startServer } from '../api/api.js';
import { runScheduler } from '../scheduler/scheduler.js';
import { formatListing } from './format.js';
import { createDetailWorker } from '../details/detailWorker.js';
import { applyDetails } from '../details/applyDetails.js';
import { createEvaluationDeps, createLlmDeps } from '../evaluation/setup.js';
import { evaluateForUsers, evaluatePending, evaluateStoredListings } from '../evaluation/pipeline.js';
import { loadEvaluationConfig } from '../evaluation/config.js';
import { createUserDirectory } from '../users/directory.js';
import { bootstrapUsers } from '../users/bootstrap.js';
import { backupBeforeMultiUser } from '../services/storage/backup.js';
import { listEnabledSearches, markQueryFetched, selectSearchesForCycle } from '../services/queries/queriesStorage.js';
import { createLlmClient, readLlmEnv, LlmError, redact } from '../llm/client.js';
import { setNextFetch, clearNextFetch } from '../services/status/fetchStatus.js';
import { createMailer, readSmtpEnv } from '../notify/mailer.js';
import { createNotifier } from '../notify/notifier.js';
import { backfillTiers } from '../notify/tierStorage.js';
import { formatTime } from '../../ui/src/services/schedule.js';
import { composeTestMail } from '../notify/composer.js';
import logger from '../services/logger.js';

const HELP = `wgg - private WG-Gesucht monitor

Usage: wgg <command> [options]

Commands:
  scrape-once   Run one scrape cycle over all configured searches and print new listings
  run           Run continuously on the configured interval (with jitter and backoff) and serve the web UI
  serve         Serve the web UI and API only (no scraping)
  details       Fetch the detail pages of pending listings once (one page at a time, politely spaced, bot-aware).
                Options: --limit N (stop after N listings), --ids 1,2 (only these listings; provider or row ids)
  llm           Assess listings with fetched details using the LLM (serial, never touches WG-Gesucht).
                Options: --limit N, --ids 1,2, --force (assess finished listings again)
  llm-check     Probe the LLM gateway (LLM_BASE_URL / LLM_API_KEY from .env): prints HTTP status, working path and
                model ids. Options: --chat (one tiny completion), --model <id>
  notify        Send the pending email alerts now (Fantastic mails, then one Good digest for the rest).
                Options: --dry-run (print what would be sent, mark nothing)
  test-mail     Send one test email through the SMTP settings from .env, or name the missing variables
  hash-password Ask for a password (hidden; or read it from stdin) and print its scrypt hash for config/users.yaml
  evaluate      (Re)evaluate stored listings; geocodes rows without location. Options: --all (also
                already evaluated rows), --regeocode (geocode every row again, retry unknown places)

Options:
  -c, --config <file>   Config file (default: ${DEFAULT_CONFIG_PATH})
      --users <file>    Accounts file for run/serve (default: users.yaml next to the config file)
  -h, --help            Show this help
      --all             evaluate: include already evaluated listings
      --regeocode       evaluate: geocode all selected listings again
      --limit <n>       details, llm: handle at most n listings
      --ids <list>      details, llm: only these listings (comma separated provider or row ids)
      --force           llm: also re-assess listings that already have a result
      --dry-run         run, notify: print the email alerts instead of sending them (nothing is marked as sent)

Secrets (SESSION_SECRET, LLM key, SMTP) are read from the environment / .env (see .env.example).`;

/** Email alerts: the mailer (SMTP from the environment; a dry run when incomplete or asked for) and the notifier. */
function makeNotifier(config, { env, io, dryRun = false, print }) {
  const mailer = createMailer({
    env,
    dryRun: dryRun || config.notify.dryRun,
    ...(print ? { print } : {}),
    ...(io.createTransport ? { createTransport: io.createTransport } : {}),
  });
  const notifier = createNotifier({
    config: config.notify,
    mailer,
    directory: config.directory,
    ...(config.server.publicUrl ? { appUrl: config.server.publicUrl } : {}),
    ...(io.now ? { now: io.now } : {}),
    ...(print ? { print } : {}),
  });
  return { notifier, mailer };
}

/** "alice: 2 fantastic queued until 07:00 (tomorrow)": what the send schedule holds back (see notifyPending). */
function describeQueued(queued, now) {
  const today = new Date(now).toDateString();
  return queued.map((q) => {
    const day = new Date(q.until).toDateString() === today ? '' : ' (tomorrow)';
    const what = q.tier === 'priority' ? 'fantastic' : 'good';
    return `${q.userId}: ${q.count} ${what} queued until ${formatTime(q.until)}${day}`;
  });
}

/** @param {{queued?: boolean, now?: number}} [options] `queued`: also list what the schedule holds back. */
function describeAlerts(r, { queued = false, now = Date.now() } = {}) {
  const parts = [];
  if (r.priority > 0) parts.push(`${r.priority} fantastic`);
  if (r.bulk > 0) parts.push(`${r.bulk} good in the digest`);
  if (r.failed > 0) parts.push(`${r.failed} failed (retried next time)`);
  const lines = [];
  if (parts.length > 0) {
    lines.push(`Alerts: ${parts.join(', ')}${r.dryRun ? ' (dry run: nothing was sent or marked)' : ''}.`);
  }
  if (queued) lines.push(...describeQueued(r.queued ?? [], now));
  return lines.length === 0 ? null : lines.join('\n');
}

/** `wgg notify [--dry-run]`: sends (or, as a dry run, prints) everything pending, digest included. */
async function notifyCommand(boot, { dryRun }, { out, env, io }) {
  const config = await boot();
  const { notifier, mailer } = makeNotifier(config, { env, io, dryRun, print: out });
  if (!config.notify.enabled) {
    out('Email alerts are switched off (notify.enabled: false).');
    return 0;
  }
  const r = await notifier.notifyPending({ idle: true });
  out(describeAlerts(r, { queued: true, now: (io.now ?? Date.now)() }) ?? 'No alerts pending.');
  if (mailer.dryRun && !dryRun && mailer.reason) out(`Nothing was sent: ${mailer.reason}.`);
  return r.failed > 0 ? 1 : 0;
}

/** `wgg test-mail`: names missing SMTP variables (never values) or sends one test email. */
async function testMailCommand({ out, err, env, io }) {
  const { missing, invalid } = readSmtpEnv(env);
  if (missing.length > 0 || invalid.length > 0) {
    if (missing.length > 0) err(`SMTP is not configured. Missing in .env: ${missing.join(', ')}.`);
    if (invalid.length > 0) err(`Invalid value in .env: ${invalid.join(', ')}.`);
    return 1;
  }
  if (!readSmtpEnv(env).settings.to) {
    err('MAIL_TO is not set: "wgg test-mail" sends to MAIL_TO. (Alerts go to the address each user saved in Options.)');
    return 1;
  }
  const mailer = createMailer({ env, ...(io.createTransport ? { createTransport: io.createTransport } : {}) });
  try {
    await mailer.send(composeTestMail());
  } catch (e) {
    err(`Sending the test email failed: ${e.message}`);
    return 1;
  }
  out('Test email sent. Check the inbox of MAIL_TO.');
  return 0;
}

/**
 * The login of run/serve: the accounts (already loaded by setup) and the cookie secret from SESSION_SECRET. Fails fast,
 * before anything starts, with a message that says what to do.
 */
function loginOf(config, env, io, mailer) {
  const secret = readSessionSecret(env);
  const deps = createEvaluationDeps({ directory: config.directory, geocoder: io.geocoder });
  return {
    geocoder: deps.geocoder, // the same (rate limited) instance the pipeline uses: address lookups for the scoring target
    mailer, // test emails from Options
    // What the web app asks for after a user changed queries or settings: evaluate that user's view in the background.
    pipeline: {
      reevaluate: ({ userId, all }) => evaluateForUsers({ ...deps, userIds: [userId], onlyUnevaluated: !all }),
    },
    auth: {
      users: config.users,
      secret,
      publicPath: config.server.publicPath,
      sessionHours: config.server.sessionHours,
    },
    trustProxy: config.server.trustProxy,
    directory: config.directory,
    maxQueriesPerUser: config.queries.maxPerUser,
  };
}

/** `wgg hash-password`: prints one hash line on stdout (prompts go to stderr), exit 1 for an unusable password. */
async function hashPasswordCommand({ out, err, io }) {
  try {
    const password = await (io.readPassword ?? readPasswordInteractive)();
    out(await hashPassword(password));
    return 0;
  } catch (e) {
    err(e.message);
    return 1;
  }
}

/**
 * Everything a command that touches the database needs: the config, the accounts (config/users.yaml, required) and
 * the per-user directory. The order matters: accounts are validated first (a missing users.yaml stops here, before
 * the database is touched), then the database is backed up once and migrated, and the users are set up (the
 * single-user data goes to the first admin, new users get default settings and queries).
 */
async function setup(configPath, { usersPath, env }) {
  const config = loadConfig(configPath);
  const users = loadUsers(usersPath ?? path.join(path.dirname(configPath), 'users.yaml'));
  Db.init(config.dbPath);
  backupBeforeMultiUser(config.dbPath);
  await runMigrations();
  const evaluation = loadEvaluationConfig();
  bootstrapUsers({
    users,
    searches: config.searches,
    evaluation,
    notify: config.notify,
    maxQueriesPerUser: config.queries.maxPerUser,
  });
  const model = env.LLM_MODEL || evaluation.llm.model;
  const directory = createUserDirectory({ users, evaluation, notify: config.notify, model });
  backfillTiers(directory); // fills the alert tier of rows from before tiers existed, follows a changed AI model
  return { ...config, users, directory };
}

/**
 * The scrape cycle's searches: the distinct enabled URLs of all users, capped at `queries.maxDistinctPerCycle` (longest
 * waiting first), so many users can never multiply the requests to WG-Gesucht. Skipped ones come first next time.
 */
function cycleOptions(config) {
  return {
    searches: () => {
      const { searches, skipped } = selectSearchesForCycle(config.queries.maxDistinctPerCycle);
      if (skipped > 0) {
        logger.warn(
          `${skipped} more search URL(s) than queries.maxDistinctPerCycle (${config.queries.maxDistinctPerCycle}): they are fetched in the following cycles (longest waiting first).`,
        );
      }
      return searches;
    },
    onSearched: (search) => markQueryFetched(search.url),
  };
}

/** Geocoding + evaluation of new listings, wired to the scrape cycle. */
function makeEnrich(config, io) {
  const deps = createEvaluationDeps({ directory: config.directory, geocoder: io.geocoder });
  // Not only the listings just stored: everything some user has no evaluation for (a query a user just added too).
  return async () => {
    const stats = await evaluatePending(deps);
    logger.info(`Evaluated ${stats.evaluated} listing(s) (${stats.geocoded} geocoded, ${stats.failed} failed).`);
  };
}

async function evaluateCommand(boot, { all, regeocode }, { out, geocoder }) {
  const config = await boot();
  const deps = createEvaluationDeps({ directory: config.directory, geocoder, regeocode });
  const stats = await evaluateStoredListings({ ...deps, all: all || regeocode });
  out(`Evaluated ${stats.evaluated} listing(s), geocoded ${stats.geocoded}, ${stats.failed} failed.`);
  return stats.failed > 0 ? 1 : 0;
}

/** `wgg llm-check`: probes the gateway and prints only the HTTP status, the working path and model ids (never secrets). */
async function llmCheckCommand({ chat, model }, { out, err, env, llmFetch }) {
  let settings;
  try {
    settings = readLlmEnv(env);
  } catch (e) {
    err(e.message);
    return 1;
  }
  const client = createLlmClient({ ...settings, model: model ?? settings.model, fetchImpl: llmFetch });
  try {
    const r = await client.listModels();
    out(`models: HTTP ${r.status} via ${r.path}`);
    for (const id of r.models) out(`  ${id}`);
    if (chat) {
      const chosen = model ?? settings.model;
      if (!chosen) {
        err('--chat needs a model: pass --model <id> or set LLM_MODEL.');
        return 1;
      }
      const c = await client.chat({ messages: [{ role: 'user', content: 'Reply with the single word: pong' }] });
      out(`chat: HTTP ${c.status} model ${chosen} reply: ${c.content.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
    }
    return 0;
  } catch (e) {
    err(e instanceof LlmError ? e.message : `LLM check failed: ${redact(e.message, [settings.apiKey])}`);
    return 1;
  }
}

async function scrapeOnce(boot, { out, err, withFetcher, io }) {
  const config = await boot();
  const enrich = makeEnrich(config, io);
  const result = await runCycleWithFetcher({ config, ...cycleOptions(config), withFetcher, enrich });

  let current = null;
  for (const { search, listing } of result.newListings) {
    if (current !== search) {
      current = search;
      const n = result.newListings.filter((r) => r.search === search).length;
      out(`\n${search.name}: ${n} new`);
    }
    out(formatListing(listing));
  }
  out(`\n${result.newListings.length} new listing(s) in total, ${result.errors.length} error(s).`);

  if (result.botDetected) {
    err('Bot detection / human verification triggered. Wait a while before trying again.');
    return 1;
  }
  return result.errors.length > 0 ? 1 : 0;
}

/**
 * The detail queue worker: fetches detail pages through the coordinator's lock and backoff, stores them and
 * re-evaluates (geocoding + rules, same dependencies as the search cycle's enrichment).
 */
function makeDetailWorker(config, coordinator, { withFetcher, io, onStored }) {
  const deps = createEvaluationDeps({ directory: config.directory, geocoder: io.geocoder });
  return createDetailWorker({
    config,
    coordinator,
    withFetcher,
    apply: (row, page) => applyDetails(row, page, deps),
    ...(onStored ? { onStored } : {}),
    ...(io.detailSleep ? { sleep: io.detailSleep } : {}),
  });
}

function describeDrain(r) {
  const parts = [`${r.fetched} fetched`];
  if (r.failed > 0) parts.push(`${r.failed} failed`);
  if (r.retried > 0) parts.push(`${r.retried} to retry`);
  return parts.join(', ');
}

async function detailsCommand(boot, { limit, ids }, { out, err, withFetcher, signal, io, env }) {
  const config = await boot();
  // No scheduler in this process: the coordinator only provides the lock and the backoff check (from the database).
  const coordinator = createFetchCoordinator({ config, runCycle: async () => ({}) });
  const worker = makeDetailWorker(config, coordinator, { withFetcher, io });
  const r = await worker.drain({ signal, limit, ids });
  if (r.stopped === 'backoff') {
    err('Bot backoff: the last fetch ran into bot detection; not fetching detail pages now. Try again later.');
    return 1;
  }
  out(`Detail pages: ${describeDrain(r)}.`);
  // The bulk may be done now (nothing left to fetch or assess): send the digest. Priority mails are catch-up only.
  const alerts = await notifyWhenIdle(config, {
    env,
    io,
    out,
    llmAvailable: createLlmDeps({ env, directory: config.directory }).worker !== null,
  });
  if (alerts) out(alerts);
  if (r.botDetected) {
    err('Bot detection / human verification triggered on a detail page. Wait a while before trying again.');
    return 1;
  }
  return r.failed > 0 ? 1 : 0;
}

/** The "bulk is done" trigger for the one-off CLI commands. Never throws: alerts must not fail the command. */
async function notifyWhenIdle(config, { env, io, out, llmAvailable }) {
  if (!config.notify.enabled) return null;
  try {
    const { notifier } = makeNotifier(config, { env, io, print: out });
    const r = await notifier.notifyWhenIdle({ detailMaxAgeDays: config.details.maxAgeDays, llmAvailable });
    return describeAlerts(r);
  } catch (e) {
    logger.error(`Email alerts failed: ${e.message}`);
    return null;
  }
}

function describeLlm(r) {
  const parts = [`${r.done} assessed`];
  if (r.failed > 0) parts.push(`${r.failed} failed`);
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
  return parts.join(', ');
}

async function llmCommand(boot, { limit, ids, force, dryRun }, { out, err, signal, env, io }) {
  const config = await boot();
  const { notifier } = makeNotifier(config, { env, io, dryRun, print: out });
  const { worker, reason } = createLlmDeps({
    env,
    fetchImpl: io.llmFetch,
    sleep: io.llmSleep,
    directory: config.directory,
    onAssessed: (userId, providerId) => notifier.notifyPriority(userId, providerId),
  });
  if (!worker) {
    err(`LLM assessment unavailable: ${reason}`);
    return 1;
  }
  const r = await worker.drain({ signal, limit, ids, force });
  out(`LLM: ${describeLlm(r)}.`);
  if (!signal.aborted && r.stopped === 'idle') {
    const alerts = await notifyWhenIdle(config, { env, io, out, llmAvailable: true });
    if (alerts) out(alerts);
  }
  return r.failed > 0 ? 1 : 0;
}

/** The coordinator behind POST /api/fetch: one cycle = browser launch + scrape + enrichment, as in scrape-once. */
function makeCoordinator(config, { withFetcher, io }) {
  const enrich = makeEnrich(config, io);
  return createFetchCoordinator({
    config,
    runCycle: () => runCycleWithFetcher({ config, ...cycleOptions(config), withFetcher, enrich }),
  });
}

async function run(boot, { out, withFetcher, signal, io, env, dryRun }) {
  const config = await boot();
  const coordinator = makeCoordinator(config, { withFetcher, io });
  coordinator.attachScheduler();
  // The AI queue is kicked whenever a detail page was stored (and once at startup); it needs the worker below.
  let kickLlm = () => {};
  const worker = makeDetailWorker(config, coordinator, { withFetcher, io, onStored: () => kickLlm() });
  const { notifier, mailer } = makeNotifier(config, { env, io, dryRun });
  const llm = createLlmDeps({
    env,
    fetchImpl: io.llmFetch,
    sleep: io.llmSleep,
    directory: config.directory,
    onAssessed: (userId, providerId) => notifier.notifyPriority(userId, providerId),
  });
  const login = loginOf(config, env, io, mailer);
  login.pipeline.kickLlm = () => kickLlm();
  if (!llm.worker) logger.info(`LLM assessment is off: ${llm.reason}.`);
  if (config.notify.enabled && mailer.dryRun) {
    logger.info(`Email alerts are only logged, not sent: ${mailer.reason}.`);
  }
  const server = await startServer({
    ...config.server,
    ...login,
    coordinator,
    details: { maxAgeDays: config.details.maxAgeDays, worker },
    llm: { badgeThreshold: llm.config.llm.badgeThreshold },
  });
  // Two independent background queues. Detail pages are drained after each search cycle (30-90 s apart, one request at a
  // time, under the fetch lock). The AI queue never touches WG-Gesucht and holds no lock, so it must not wait for the
  // detail queue: it is kicked as soon as a page was stored, and drains serially until nothing new is pending.
  const drains = new Set();
  const track = (promise) => {
    const tracked = promise.finally(() => drains.delete(tracked));
    drains.add(tracked);
  };
  // "The bulk is done": detail + AI queues have no processable work left -> one digest email (see lib/notify). Called
  // whenever either queue ran dry; it only sends when BOTH have nothing left.
  const alertWhenIdle = async () => {
    if (signal.aborted) return;
    try {
      const r = await notifier.notifyWhenIdle({
        detailMaxAgeDays: config.details.maxAgeDays,
        llmAvailable: llm.worker !== null,
      });
      const text = describeAlerts(r);
      if (text) logger.info(text);
    } catch (e) {
      logger.error(`Email alerts crashed: ${e.message}`);
    }
  };
  const drainLlm = async () => {
    // A drain works on the queue as it was when it started; pages stored meanwhile are picked up by the next round.
    for (;;) {
      if (!llm.worker || signal.aborted || llm.worker.state().running) return;
      let r;
      try {
        r = await llm.worker.drain({ signal });
      } catch (e) {
        logger.error(`LLM queue crashed: ${e.message}`);
        return;
      }
      if (r.done + r.failed + r.skipped > 0) logger.info(`LLM queue: ${describeLlm(r)}.`);
      if (r.done + r.skipped === 0) return; // idle, or only failures (those are retried with the next cycle)
    }
  };
  kickLlm = () => {
    if (!llm.worker || signal.aborted || llm.worker.state().running) return;
    track(drainLlm().then(alertWhenIdle));
  };
  const startDrain = () => {
    if (signal.aborted || worker.state().running) return;
    track(
      worker
        .drain({ signal })
        .then((r) => logger.info(`Detail queue: ${describeDrain(r)} (${r.stopped}).`))
        .catch((e) => logger.error(`Detail queue crashed: ${e.message}`))
        .then(alertWhenIdle),
    );
  };
  kickLlm(); // listings whose details were fetched in an earlier run
  // The send schedule: a Fantastic morning mail or a Good slot can become due without any queue activity, so check
  // every minute (a few SQL reads, no WG-Gesucht calls). Also once now: a restart picks up what is already overdue.
  let alertTimer = null;
  if (config.notify.enabled) {
    track(alertWhenIdle());
    alertTimer = setInterval(() => track(alertWhenIdle()), io.alertCheckMs ?? 60_000);
  }
  try {
    logger.info(
      `wgg started: ${listEnabledSearches().length} search(es) for ${config.users.length} user(s), every ${config.schedule.intervalMinutes} min (+/-${config.schedule.jitterPercent}%).`,
    );
    await runScheduler({
      config,
      signal,
      onSchedule: setNextFetch,
      onStop: clearNextFetch,
      registerWake: coordinator.registerWake,
      registerPenalty: coordinator.registerPenalty,
      runCycle: async () => {
        const result = await coordinator.runScheduledCycle();
        if (!result.botDetected) startDrain();
        return result;
      },
      onNewListings: (found) => {
        out(`${found.length} new listing(s):`);
        for (const { search, listing } of found) out(`[${search.name}]\n${formatListing(listing)}`);
      },
    });
  } finally {
    if (alertTimer) clearInterval(alertTimer);
    await Promise.allSettled([...drains]);
    await server.close();
  }
  return 0;
}

async function serve(boot, { signal, withFetcher, io, env }) {
  const config = await boot();
  const login = loginOf(config, env, io, makeNotifier(config, { env, io }).mailer);
  // No scheduler here: "Fetch now" runs one cycle in this process (same guards, same browser wiring).
  const coordinator = makeCoordinator(config, { withFetcher, io });
  const server = await startServer({
    ...config.server,
    ...login,
    coordinator,
    details: { maxAgeDays: config.details.maxAgeDays },
    llm: {
      badgeThreshold: createLlmDeps({ env, fetchImpl: io.llmFetch, directory: config.directory }).config.llm
        .badgeThreshold,
    },
  });
  try {
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } finally {
    await server.close();
  }
  return 0;
}

/** Runs fn with a signal that aborts on SIGINT/SIGTERM (or on the injected signal, for tests). */
async function withShutdownSignal(injected, fn) {
  const controller = new AbortController();
  const stop = (sig) => {
    logger.info(`${sig} received, finishing the current step and shutting down.`);
    controller.abort();
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    return await fn(injected ?? controller.signal);
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

/**
 * CLI entry. Returns the process exit code.
 * @param {string[]} argv
 * @param {{out?: (s: string) => void, err?: (s: string) => void, withFetcher?: Function,
 *   geocoder?: import('../geocoding/geocoder.js').Geocoder, signal?: AbortSignal,
 *   detailSleep?: (ms: number, signal?: AbortSignal) => Promise<void>}} [io] `geocoder` replaces Nominatim and
 *   `detailSleep` the wait between detail requests (tests).
 */
export async function main(argv, io = {}) {
  /* eslint-disable no-console */
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  /* eslint-enable no-console */
  const withFetcher = io.withFetcher ?? withBrowserFetcher;

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c', default: DEFAULT_CONFIG_PATH },
        users: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        all: { type: 'boolean', default: false },
        regeocode: { type: 'boolean', default: false },
        limit: { type: 'string' },
        chat: { type: 'boolean', default: false },
        model: { type: 'string' },
        ids: { type: 'string' },
        force: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    err(`${e.message}\n\n${HELP}`);
    return 2;
  }

  const [command] = parsed.positionals;
  if (parsed.values.help || command === undefined) {
    out(HELP);
    return 0;
  }

  let limit;
  if (parsed.values.limit !== undefined) {
    limit = /^\d+$/.test(parsed.values.limit) ? Number(parsed.values.limit) : 0;
    if (limit < 1) {
      err(`--limit must be a whole number of at least 1\n\n${HELP}`);
      return 2;
    }
  }

  let ids;
  if (parsed.values.ids !== undefined) {
    ids = parsed.values.ids
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0 || !ids.every((id) => /^\d+$/.test(id))) {
      err(`--ids must be a comma separated list of numeric ids, e.g. --ids 123,456\n\n${HELP}`);
      return 2;
    }
  }

  const env = io.env ?? process.env;
  if (!io.env && !process.env.WGG_SKIP_ENV_FILE && fs.existsSync('.env')) process.loadEnvFile('.env');

  const boot = () => setup(parsed.values.config, { usersPath: parsed.values.users, env });
  try {
    switch (command) {
      case 'scrape-once':
        return await scrapeOnce(boot, { out, err, withFetcher, io });
      case 'run':
        return await withShutdownSignal(io.signal, (signal) =>
          run(boot, { out, withFetcher, signal, io, env, dryRun: parsed.values['dry-run'] }),
        );
      case 'serve':
        return await withShutdownSignal(io.signal, (signal) => serve(boot, { signal, withFetcher, io, env }));
      case 'details':
        return await withShutdownSignal(io.signal, (signal) =>
          detailsCommand(boot, { limit, ids }, { out, err, withFetcher, signal, io, env }),
        );
      case 'llm':
        return await withShutdownSignal(io.signal, (signal) =>
          llmCommand(
            boot,
            { limit, ids, force: parsed.values.force, dryRun: parsed.values['dry-run'] },
            { out, err, signal, env, io },
          ),
        );
      case 'notify':
        return await notifyCommand(boot, { dryRun: parsed.values['dry-run'] }, { out, env, io });
      case 'test-mail':
        return await testMailCommand({ out, err, env, io });
      case 'hash-password':
        return await hashPasswordCommand({ out, err, io });
      case 'llm-check':
        return await llmCheckCommand(parsed.values, { out, err, env, llmFetch: io.llmFetch });
      case 'evaluate':
        return await evaluateCommand(boot, parsed.values, { out, geocoder: io.geocoder });
      default:
        err(`Unknown command: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`Config error: ${e.message}`);
      return 2;
    }
    logger.error(e.stack || e.message);
    return 1;
  } finally {
    Db.close();
  }
}
