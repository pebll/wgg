import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPreLaunchConfig } from '../../lib/services/extractor/botPrevention.js';

const URL_ = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';

afterEach(() => vi.restoreAllMocks());

describe('getPreLaunchConfig', () => {
  it('returns German-first defaults', () => {
    const cfg = getPreLaunchConfig(URL_, { viewportJitter: false });
    expect(cfg.acceptLanguage).toBe('de-DE,de;q=0.9,en-US;q=0.7,en;q=0.5');
    expect(cfg.langForFlag).toBe('de-DE');
    expect(cfg.viewport).toEqual({ width: 1366, height: 768, deviceScaleFactor: 1 });
    expect(cfg.windowSizeArg).toContain('1366,768');
    expect(cfg.langArg).toContain('de-DE');
    expect(cfg.timezone).toBe('Europe/Berlin');
    expect(cfg.humanDelay).toBe(true);
    expect(typeof cfg.userAgent).toBe('string');
    expect(Array.isArray(cfg.extraArgs)).toBe(true);
  });

  it('adds one shared jitter between 0 and 5 to width and height only', () => {
    for (let i = 0; i < 50; i++) {
      const { viewport } = getPreLaunchConfig(URL_);
      const dw = viewport.width - 1366;
      expect(dw).toBeGreaterThanOrEqual(0);
      expect(dw).toBeLessThanOrEqual(5);
      expect(viewport.height - 768).toBe(dw);
      expect(viewport.deviceScaleFactor).toBe(1);
    }
  });

  it('applies the maximum jitter for the highest random value', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    expect(getPreLaunchConfig(URL_).viewport.width).toBe(1371);
  });

  it('coerces viewport values and falls back on junk', () => {
    const cfg = getPreLaunchConfig(URL_, {
      viewportJitter: false,
      viewport: { width: '1000', height: 'abc', deviceScaleFactor: 2 },
    });
    expect(cfg.viewport).toEqual({ width: 1000, height: 768, deviceScaleFactor: 2 });
  });

  it('honours option overrides', () => {
    const cfg = getPreLaunchConfig(URL_, {
      acceptLanguage: 'fr-FR,fr;q=0.8',
      userAgent: 'UA/1',
      referer: 'https://example.org/',
      timezone: 'Europe/Paris',
      humanDelay: false,
    });
    expect(cfg.langForFlag).toBe('fr-FR');
    expect(cfg.userAgent).toBe('UA/1');
    expect(cfg.timezone).toBe('Europe/Paris');
    expect(cfg.humanDelay).toBe(false);
    expect(cfg.headers).toMatchObject({
      'Accept-Language': 'fr-FR,fr;q=0.8',
      'User-Agent': 'UA/1',
      Referer: 'https://example.org/',
      Connection: 'keep-alive',
      DNT: '1',
    });
  });

  it('derives the referer from the url host', () => {
    expect(getPreLaunchConfig(URL_).headers.Referer).toBe('https://www.wg-gesucht.de/');
  });

  it('throws on an invalid url', () => {
    expect(() => getPreLaunchConfig('not a url')).toThrow(TypeError);
  });
});
