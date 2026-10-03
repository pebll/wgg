import { launchBrowser, closeBrowser } from './extractor/puppeteerExtractor.js';
import puppeteerExtractor from './extractor/puppeteerExtractor.js';
import { ensureValidBinary } from './ensureValidBinary.js';

/**
 * Run `fn` with a `fetchHtml(url)` that reuses one CloakBrowser instance (one warm session for
 * all searches of a cycle). The browser is launched lazily on the first fetch and always closed.
 *
 * @template T
 * @param {(fetchHtml: (url: string) => Promise<string>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withBrowserFetcher(fn) {
  let browser = null;
  const fetchHtml = async (url) => {
    if (!browser) {
      await ensureValidBinary();
      browser = await launchBrowser(url);
    }
    return puppeteerExtractor(url, 'body', { browser, name: 'wgGesucht' });
  };
  try {
    return await fn(fetchHtml);
  } finally {
    await closeBrowser(browser);
  }
}
