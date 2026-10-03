import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, isValidHash, DUMMY_HASH, MIN_PASSWORD_LENGTH } from '../../lib/auth/password.js';

describe('#password hashing', () => {
  it('produces a salted scrypt hash that verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password!!', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('uses a fresh salt per hash', async () => {
    expect(await hashPassword('same password 1')).not.toBe(await hashPassword('same password 1'));
  });

  it('rejects malformed or foreign hashes without throwing', async () => {
    for (const bad of [undefined, null, '', 'plain', 'scrypt$1$2', 'scrypt$x$8$1$00$00', `${'a'.repeat(64)}`]) {
      expect(await verifyPassword('whatever12345', bad)).toBe(false);
    }
  });

  it('DUMMY_HASH is well formed but never verifies', async () => {
    expect(isValidHash(DUMMY_HASH)).toBe(true);
    expect(await verifyPassword('anything at all', DUMMY_HASH)).toBe(false);
  });

  it('isValidHash accepts only the scrypt format', async () => {
    expect(isValidHash(await hashPassword('another password'))).toBe(true);
    expect(isValidHash('scrypt$32768$8$1$ab')).toBe(false);
    expect(isValidHash('$2b$10$abcdefghijklmnopqrstuv')).toBe(false);
    expect(isValidHash(42)).toBe(false);
  });

  it('refuses to hash a password that is too short', async () => {
    await expect(hashPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(/at least/);
  });
});
