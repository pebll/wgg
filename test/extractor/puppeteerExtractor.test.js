import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDetectedError, FetchError } from '../../lib/errors.js';

const launch = vi.fn();
vi.mock('cloakbrowser/puppeteer', () => ({ launch: (...args) => launch(...args) }));
vi.mock('../../lib/services/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  default: execute,
  launchBrowser,
  closeBrowser,
} = await import('../../lib/services/extractor/puppeteerExtractor.js');

const URL_ = 'https://www.wg-gesucht.de/x.html';

function fakePage({ status = 200, html = '<html><body>ok</body></html>', inner = 'inner', gotoError } = {}) {
  return {
    setCookie: vi.fn(async () => {}),
    goto: vi.fn(async () => {
      if (gotoError) throw gotoError;
      return { status: () => status };
    }),
    waitForNetworkIdle: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    evaluate: vi.fn(async () => inner),
    content: vi.fn(async () => html),
    close: vi.fn(async () => {}),
  };
}

function fakeBrowser(page, extra = {}) {
  return { newPage: vi.fn(async () => page), close: vi.fn(async () => {}), process: () => null, ...extra };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('launchBrowser', () => {
  it('passes headless, humanize, locale, timezone and container-safe args', async () => {
    launch.mockResolvedValue('B');
    await expect(launchBrowser(URL_, undefined)).resolves.toBe('B');
    const opts = launch.mock.calls[0][0];
    expect(opts).toMatchObject({ headless: true, humanize: true, locale: 'de-DE', timezone: 'Europe/Berlin' });
    expect(opts.proxy).toBeUndefined();
    expect(opts.args).toEqual(
      expect.arrayContaining([
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--ignore-certificate-errors',
        '--no-zygote',
      ]),
    );
    expect(opts.args.some((a) => a.startsWith('--window-size='))).toBe(true);
    expect(opts).not.toHaveProperty('userAgent');
  });

  it('honours headless and proxy options', async () => {
    launch.mockResolvedValue('B');
    await launchBrowser(URL_, { puppeteerHeadless: false, proxyUrl: 'http://p:1' });
    expect(launch.mock.calls[0][0]).toMatchObject({ headless: false, proxy: 'http://p:1' });
  });
});

describe('closeBrowser', () => {
  it('ignores a missing browser', async () => {
    await expect(closeBrowser(null)).resolves.toBeUndefined();
    await expect(closeBrowser(undefined)).resolves.toBeUndefined();
  });

  it('swallows a rejecting close() and still kills the process group', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const browser = {
      close: vi.fn(async () => {
        throw new Error('gone');
      }),
      process: () => ({ pid: 4242, exitCode: null, signalCode: null, kill: vi.fn() }),
    };
    await expect(closeBrowser(browser)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('survives a throwing process() accessor', async () => {
    const browser = {
      close: vi.fn(async () => {}),
      process: () => {
        throw new Error('broken handle');
      },
    };
    await expect(closeBrowser(browser)).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalled();
  });

  it('falls back to child.kill when the group kill fails, and skips exited processes', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const child = { pid: 1, exitCode: null, signalCode: null, kill: vi.fn() };
    await closeBrowser({ close: async () => {}, process: () => child });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    const done = { pid: 2, exitCode: 0, signalCode: null, kill: vi.fn() };
    await closeBrowser({ close: async () => {}, process: () => done });
    expect(done.kill).not.toHaveBeenCalled();
  });
});

describe('execute', () => {
  it('returns the body innerHTML when a selector is given and leaves an external browser open', async () => {
    const page = fakePage({ inner: '<div>cards</div>' });
    const browser = fakeBrowser(page);
    await expect(execute(URL_, 'body', { browser })).resolves.toBe('<div>cards</div>');
    expect(page.waitForSelector).toHaveBeenCalledWith('body', { timeout: 30000 });
    expect(page.goto).toHaveBeenCalledWith(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(page.close).toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns the full content without a selector and sets cookies', async () => {
    const page = fakePage({ html: '<html>full</html>' });
    const browser = fakeBrowser(page);
    const cookies = [{ name: 'a', value: 'b' }];
    await expect(execute(URL_, null, { browser, cookies })).resolves.toBe('<html>full</html>');
    expect(page.setCookie).toHaveBeenCalledWith(...cookies);
  });

  it('falls back to page.content() when the element html is empty', async () => {
    const page = fakePage({ inner: '', html: '<html>fallback</html>' });
    await expect(execute(URL_, 'body', { browser: fakeBrowser(page) })).resolves.toBe('<html>fallback</html>');
  });

  it('launches and closes its own browser when none is passed', async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    launch.mockResolvedValue(browser);
    await execute(URL_, 'body', {});
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalled();
  });

  it('throws BotDetectedError for bot walls and 403/429', async () => {
    const wall = fakePage({ inner: 'Please verify you are human' });
    await expect(execute(URL_, 'body', { browser: fakeBrowser(wall) })).rejects.toBeInstanceOf(BotDetectedError);
    const blocked = fakePage({ status: 429 });
    await expect(execute(URL_, 'body', { browser: fakeBrowser(blocked) })).rejects.toMatchObject({
      name: 'BotDetectedError',
      status: 429,
    });
    expect(blocked.close).toHaveBeenCalled();
  });

  it('throws FetchError with the status for other HTTP errors', async () => {
    const page = fakePage({ status: 500 });
    const error = await execute(URL_, 'body', { browser: fakeBrowser(page) }).catch((e) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect(error.message).toBe(`HTTP 500 for ${URL_}`);
    expect(error.status).toBe(500);
  });

  it('wraps unexpected failures and keeps the cause', async () => {
    const cause = new Error('Navigation timeout');
    const page = fakePage({ gotoError: cause });
    const error = await execute(URL_, 'body', { browser: fakeBrowser(page) }).catch((e) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect(error.message).toBe('Error executing with CloakBrowser executor: Navigation timeout');
    expect(error.cause).toBe(cause);
    expect(page.close).toHaveBeenCalled();
  });

  it('ignores warm-up and network-idle failures', async () => {
    const page = fakePage();
    page.goto.mockRejectedValueOnce(new Error('warm-up failed')).mockResolvedValue({ status: () => 200 });
    page.waitForNetworkIdle.mockRejectedValue(new Error('idle timeout'));
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });
    await expect(
      execute(URL_, 'body', {
        browser: fakeBrowser(page),
        preNavigateUrl: 'https://www.wg-gesucht.de/',
        waitForNetworkIdle: true,
      }),
    ).resolves.toBe('inner');
    expect(page.goto).toHaveBeenCalledTimes(2);
  });
});
