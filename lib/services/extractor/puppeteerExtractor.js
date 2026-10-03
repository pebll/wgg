import { launch } from 'cloakbrowser/puppeteer';
import { BotDetectedError, FetchError } from '../../errors.js';
import { getPreLaunchConfig } from './botPrevention.js';
import { botDetected, debug } from './utils.js';

const DEFAULTS = {
  navigationTimeout: 60_000,
  idleTimeout: 60_000,
  selectorFallbackTimeout: 30_000,
  warmUpTimeout: 30_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a CloakBrowser instance. The patched Chromium already provides a consistent fingerprint, so no user
 * agent, headers or init scripts are layered on top.
 */
export async function launchBrowser(url, options) {
  const config = getPreLaunchConfig(url, options ?? {});
  const launchOptions = {
    headless: options?.puppeteerHeadless ?? true,
    humanize: true,
    locale: config.langForFlag,
    args: [
      '--no-sandbox', // runs as root inside Docker
      '--disable-dev-shm-usage', // do not rely on a large /dev/shm
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors', // bundled CA store may not trust interception proxies
      '--no-zygote', // containers with restricted namespaces
      config.windowSizeArg,
    ],
  };
  if (config.timezone) launchOptions.timezone = config.timezone;
  if (options?.proxyUrl) launchOptions.proxy = options.proxyUrl;
  return launch(launchOptions);
}

function childProcessOf(browser) {
  try {
    return typeof browser.process === 'function' ? browser.process() : null;
  } catch {
    return null;
  }
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') throw new Error('no process groups on Windows');
    // Chromium leads its own process group; a negative pid takes the whole tree down.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Closes a browser and makes sure no Chromium process survives. Never throws. */
export async function closeBrowser(browser) {
  if (!browser) return;
  const child = childProcessOf(browser);
  try {
    await browser.close();
  } catch {
    // the connection may already be gone; the hard kill below takes care of the rest
  }
  killTree(child);
}

async function loadHtml(page, url, waitForSelector, options) {
  if (options.cookies?.length) await page.setCookie(...options.cookies);

  if (options.preNavigateUrl) {
    try {
      await page.goto(options.preNavigateUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULTS.warmUpTimeout });
      await sleep(1500 + Math.random() * 2000);
    } catch {
      // the warm-up page is optional
    }
  }

  const response = await page.goto(url, {
    waitUntil: options.waitUntil ?? 'domcontentloaded',
    timeout: options.puppeteerTimeout ?? DEFAULTS.navigationTimeout,
  });

  if (options.waitForNetworkIdle) {
    try {
      await page.waitForNetworkIdle({ timeout: options.waitForNetworkIdleTimeout ?? DEFAULTS.idleTimeout });
    } catch {
      // a busy page that never goes idle is still usable
    }
  }

  let source;
  if (waitForSelector != null) {
    const timeout = options.puppeteerSelectorTimeout ?? options.puppeteerTimeout ?? DEFAULTS.selectorFallbackTimeout;
    await page.waitForSelector(waitForSelector, { timeout });
    source = await page.evaluate((selector) => document.querySelector(selector)?.innerHTML ?? '', waitForSelector);
  } else {
    source = await page.content();
  }

  const status = response?.status?.() ?? 200;
  if (botDetected(source, status)) throw new BotDetectedError(url, status);
  if (status >= 400) throw new FetchError(`HTTP ${status} for ${url}`, { status });

  return source || (await page.content());
}

/**
 * Loads one page and returns its HTML: the inner HTML of the first `waitForSelector` match, or the whole document
 * when no selector is given. A browser passed in `options.browser` is reused and never closed here.
 *
 * @returns {Promise<string|null>}
 */
export default async function execute(url, waitForSelector, options = {}) {
  debug(`Fetching ${url} (selector: ${waitForSelector ?? 'none'})`);

  const ownsBrowser = !options.browser;
  let browser = options.browser ?? null;
  let page = null;
  try {
    browser ??= await launchBrowser(url, options);
    page = await browser.newPage();
    return await loadHtml(page, url, waitForSelector, options);
  } catch (error) {
    if (error instanceof BotDetectedError || error instanceof FetchError) throw error;
    throw new FetchError(`Error executing with CloakBrowser executor: ${error.message}`, { cause: error });
  } finally {
    if (page) await page.close().catch(() => {});
    if (ownsBrowser) await closeBrowser(browser);
  }
}
