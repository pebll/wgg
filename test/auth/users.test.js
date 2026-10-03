import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseUsers, loadUsers, UsersError } from '../../lib/auth/users.js';
import { ConfigError } from '../../lib/errors.js';
import { DUMMY_HASH } from '../../lib/auth/password.js';

const H = DUMMY_HASH; // a well-formed hash is enough for the loader
const user = (over = {}) => ({ username: 'leo', passwordHash: H, admin: true, ...over });

describe('#users.yaml', () => {
  it('parses users and fills defaults', () => {
    const users = parseUsers({
      users: [user({ email: 'leo@example.org' }), user({ username: 'anna', admin: undefined })],
    });
    expect(users).toEqual([
      { username: 'leo', passwordHash: H, admin: true, email: 'leo@example.org' },
      { username: 'anna', passwordHash: H, admin: false, email: null },
    ]);
  });

  it.each([
    [undefined, /mapping/],
    [{}, /"users"/],
    [{ users: [] }, /at least one/],
    [{ users: [user({ username: 'Leo Q' })] }, /username/],
    [{ users: [user({ username: 'Leo' })] }, /lowercase/],
    [{ users: [user(), user()] }, /duplicate/],
    [{ users: [user({ passwordHash: 'secret' })] }, /wgg hash-password/],
    [{ users: [user({ passwordHash: undefined })] }, /passwordHash/],
    [{ users: [user({ admin: 'yes' })] }, /admin/],
    [{ users: [user({ email: 'not-an-email' })] }, /email/],
    [{ users: [user({ admin: false })] }, /admin/],
    [{ users: ['leo'] }, /users\[0\]/],
  ])('rejects invalid input %#', (raw, message) => {
    expect(() => parseUsers(raw)).toThrow(UsersError);
    expect(() => parseUsers(raw)).toThrow(message);
  });

  it('UsersError is a ConfigError (the CLI prints it as a config error)', () => {
    expect(new UsersError('x')).toBeInstanceOf(ConfigError);
  });

  it('loadUsers explains how to create the file when it is missing', () => {
    expect(() => loadUsers('/nonexistent/users.yaml')).toThrow(/hash-password/);
    expect(() => loadUsers('/nonexistent/users.yaml')).toThrow(/users\.example\.yaml/);
  });

  it('loadUsers reads and validates a YAML file; invalid YAML is a UsersError, and the hash is never echoed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-users-'));
    const file = path.join(dir, 'users.yaml');
    fs.writeFileSync(file, `users:\n  - username: leo\n    passwordHash: "${H}"\n    admin: true\n`);
    expect(loadUsers(file)[0].username).toBe('leo');
    fs.writeFileSync(file, 'users: [unclosed');
    expect(() => loadUsers(file)).toThrow(UsersError);
    fs.writeFileSync(file, 'users:\n  - username: leo\n    passwordHash: topsecret\n    admin: true\n');
    try {
      loadUsers(file);
    } catch (e) {
      expect(e.message).not.toContain('topsecret');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
