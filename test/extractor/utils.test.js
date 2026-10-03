import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../lib/services/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { botDetected, debug, setDebug, DEFAULT_HEADER } = await import('../../lib/services/extractor/utils.js');
const logger = (await import('../../lib/services/logger.js')).default;

describe('botDetected', () => {
  it.each([403, 429])('is true for HTTP %i', (status) => {
    expect(botDetected('<html>fine</html>', status)).toBe(true);
  });

  it('is true for the human-verification and access-denied phrases in any case', () => {
    expect(botDetected('Please Verify You Are Human', 200)).toBe(true);
    expect(botDetected('<h1>ACCESS DENIED</h1>', 200)).toBe(true);
    expect(botDetected(`${'x'.repeat(50_000)} access denied`, 200)).toBe(true);
  });

  it('flags small pages carrying a CloudFront request id', () => {
    expect(botDetected('<p>blocked X-Amz-Cf-Id: abc</p>', 200)).toBe(true);
  });

  it('ignores the CloudFront marker on long pages', () => {
    expect(botDetected(`x-amz-cf-id ${'a'.repeat(5000)}`, 200)).toBe(false);
    expect(botDetected(`x-amz-cf-id${'a'.repeat(4084)}`, 200)).toBe(true); // exactly 4096 characters
  });

  it('is false for ordinary pages and tolerates odd input', () => {
    expect(botDetected('<html><body>hello</body></html>', 200)).toBe(false);
    expect(botDetected(null, 200)).toBe(false);
    expect(botDetected(undefined, 200)).toBe(false);
    expect(botDetected(12345, 200)).toBe(false);
  });

  it('does not mistake the saved fixtures for bot walls', () => {
    for (const name of ['wgGesucht.html', 'wgGesucht_detail.html']) {
      const html = fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
      expect(botDetected(html, 200)).toBe(false);
    }
  });
});

describe('debug output', () => {
  it('is silent until enabled via setDebug', () => {
    debug('quiet');
    expect(logger.debug).not.toHaveBeenCalled();
    setDebug({ debug: true });
    debug('loud');
    expect(logger.debug).toHaveBeenCalledWith('loud');
    setDebug(undefined);
    debug('quiet again');
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});

describe('DEFAULT_HEADER', () => {
  it('carries the usual browser request headers', () => {
    for (const key of ['Accept', 'Accept-Language', 'Connection', 'Upgrade-Insecure-Requests', 'User-Agent']) {
      expect(typeof DEFAULT_HEADER[key]).toBe('string');
    }
  });
});
