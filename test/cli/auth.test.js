import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import Db from '../../lib/services/storage/Db.js';
import { main } from '../../lib/cli/main.js';
import { readPasswordFromStream, promptHidden } from '../../lib/cli/password.js';
import { verifyPassword, DUMMY_HASH } from '../../lib/auth/password.js';
import { SECRET } from '../helpers/auth.js';

const run = async (argv, io = {}) => {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), ...io });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('#cli hash-password', () => {
  it('prints exactly one scrypt hash line that verifies the password (nothing else on stdout)', async () => {
    const r = await run(['hash-password'], { readPassword: async () => 'a long enough password' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^scrypt\$\d+\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifyPassword('a long enough password', r.out)).toBe(true);
    expect(r.out + r.err).not.toContain('a long enough password');
  });

  it('refuses a short password with exit 1 and prints no hash', async () => {
    const r = await run(['hash-password'], { readPassword: async () => 'short' });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/at least 10/);
  });

  it('is listed in the help text', async () => {
    expect((await run(['--help'])).out).toMatch(/hash-password/);
  });
});

describe('#cli password input', () => {
  it('reads the password from a piped stream and strips only the trailing newline', async () => {
    expect(await readPasswordFromStream(Readable.from(['secret pass 123\n']))).toBe('secret pass 123');
    expect(await readPasswordFromStream(Readable.from(['a b\r\n']))).toBe('a b');
    expect(await readPasswordFromStream(Readable.from(['  keep spaces  ']))).toBe('  keep spaces  ');
  });

  const fakeTty = () => {
    const input = new EventEmitter();
    input.isTTY = true;
    input.raw = [];
    input.setRawMode = (on) => input.raw.push(on);
    input.resume = () => {};
    input.pause = () => {};
    const written = [];
    return { input, output: { write: (s) => written.push(s) }, written };
  };

  it('promptHidden never echoes the typed characters and supports backspace', async () => {
    const { input, output, written } = fakeTty();
    const result = promptHidden('Password: ', { input, output });
    for (const ch of 'abcd') input.emit('data', Buffer.from(ch));
    input.emit('data', Buffer.from('\x7f'));
    input.emit('data', Buffer.from('e\r'));
    expect(await result).toBe('abce');
    expect(written.join('')).toBe('Password: \n');
    expect(input.raw).toEqual([true, false]);
  });

  it('promptHidden rejects on Ctrl+C and restores the terminal', async () => {
    const { input, output } = fakeTty();
    const result = promptHidden('Password: ', { input, output });
    input.emit('data', Buffer.from('\x03'));
    await expect(result).rejects.toThrow(/cancel/i);
    expect(input.raw).toEqual([true, false]);
  });
});

describe('#cli run / serve need accounts and a session secret', () => {
  afterEach(() => Db.reset());
  const setup = ({ users = true } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-cli-auth-'));
    const cfgFile = path.join(dir, 'wgg.yaml');
    fs.writeFileSync(
      cfgFile,
      `db: ${path.join(dir, 'x.db')}\nsearches:\n  - url: https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html\nserver:\n  port: 1\n`,
    );
    if (users) {
      fs.writeFileSync(
        path.join(dir, 'users.yaml'),
        `users:\n  - username: leo\n    passwordHash: "${DUMMY_HASH}"\n    admin: true\n`,
      );
    }
    return { dir, cfgFile };
  };
  const never = async () => {
    throw new Error('must not scrape');
  };

  it.each(['serve', 'run'])('%s exits 2 and explains hash-password when users.yaml is missing', async (command) => {
    const { dir, cfgFile } = setup({ users: false });
    const r = await run([command, '--config', cfgFile], { env: { SESSION_SECRET: SECRET }, withFetcher: never });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/hash-password/);
    expect(r.err).toMatch(/users\.example\.yaml/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['serve', 'run'])('%s exits 2 with a clear message when SESSION_SECRET is missing', async (command) => {
    const { dir, cfgFile } = setup();
    const r = await run([command, '--config', cfgFile], { env: {}, withFetcher: never });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/SESSION_SECRET/);
    expect(r.err).toMatch(/openssl rand -hex 32/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--users points at another users file', async () => {
    const { dir, cfgFile } = setup({ users: false });
    const r = await run(['serve', '--config', cfgFile, '--users', path.join(dir, 'nope.yaml')], {
      env: { SESSION_SECRET: SECRET },
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('nope.yaml');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
