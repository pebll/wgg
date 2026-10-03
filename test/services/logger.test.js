import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LEVELS = [
  ['debug', 'DEBUG'],
  ['info', 'INFO'],
  ['warn', 'WARN'],
  ['error', 'ERROR'],
];

async function loadLogger(nodeEnv) {
  vi.resetModules();
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  return (await import('../../lib/services/logger.js')).default;
}

describe('logger', () => {
  const originalEnv = process.env.NODE_ENV;
  const spies = {};

  beforeEach(() => {
    for (const [method] of LEVELS) spies[method] = vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  it.each(LEVELS)('%s prints a timestamped prefix followed by the arguments', async (method, label) => {
    const logger = await loadLogger('development');
    const err = new Error('boom');
    logger[method]('hello', 42, err);
    expect(spies[method]).toHaveBeenCalledTimes(1);
    const [prefix, ...rest] = spies[method].mock.calls[0];
    // eslint-disable-next-line no-control-regex
    const plain = prefix.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toMatch(new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\] ${label}:$`));
    expect(rest).toEqual(['hello', 42, err]);
    expect(rest[2]).toBe(err);
  });

  it('drops debug lines outside development', async () => {
    const logger = await loadLogger('production');
    logger.debug('hidden');
    logger.info('shown');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledTimes(1);
  });

  it('treats an unset NODE_ENV as development', async () => {
    const logger = await loadLogger(undefined);
    logger.debug('visible');
    expect(spies.debug).toHaveBeenCalledTimes(1);
  });

  it('uses plain text when no stream is a TTY', async () => {
    const out = process.stdout.isTTY;
    const err = process.stderr.isTTY;
    process.stdout.isTTY = false;
    process.stderr.isTTY = false;
    try {
      const logger = await loadLogger('development');
      logger.warn('x');
      expect(spies.warn.mock.calls[0][0]).not.toContain('\u001b');
    } finally {
      process.stdout.isTTY = out;
      process.stderr.isTTY = err;
    }
  });

  it('colours the level word on a TTY', async () => {
    const out = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      const logger = await loadLogger('development');
      logger.error('x');
      expect(spies.error.mock.calls[0][0]).toContain('\u001b[');
    } finally {
      process.stdout.isTTY = out;
    }
  });
});
