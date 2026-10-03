import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../errors.js';
import { isValidHash } from './password.js';

export const DEFAULT_USERS_PATH = 'config/users.yaml';
export const EXAMPLE_USERS_PATH = 'config/users.example.yaml';

/** An invalid or missing users file. Never carries a password hash. */
export class UsersError extends ConfigError {
  constructor(message) {
    super(message);
    this.name = 'UsersError';
  }
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates the parsed users.yaml: `users: [{username, passwordHash, admin?, email?}]`. The username is the stable
 * user id in the database (lowercase letters, digits, `.`, `_`, `-`), at least one user must be an admin (the first
 * admin owns the data from before multi-user).
 *
 * @param {unknown} raw
 * @returns {{username: string, passwordHash: string, admin: boolean, email: string|null}[]}
 */
export function parseUsers(raw) {
  if (!isObject(raw)) throw new UsersError('The users file must be a YAML mapping with a "users" list.');
  if (!Array.isArray(raw.users)) throw new UsersError('The users file needs a "users" list.');
  if (raw.users.length === 0) throw new UsersError('The users file needs at least one user (an admin).');
  const seen = new Set();
  const users = raw.users.map((entry, i) => {
    const at = `users[${i}]`;
    if (!isObject(entry)) throw new UsersError(`${at} must be a mapping with username and passwordHash.`);
    const { username, passwordHash, admin, email } = entry;
    if (typeof username !== 'string' || username.trim() === '') throw new UsersError(`${at}: "username" is required.`);
    if (username !== username.toLowerCase()) {
      throw new UsersError(`${at}: username "${username}" must be lowercase.`);
    }
    if (!USERNAME.test(username)) {
      throw new UsersError(
        `${at}: invalid username "${username}" (1-32 characters: lowercase letters, digits, ".", "_", "-").`,
      );
    }
    if (seen.has(username)) throw new UsersError(`${at}: duplicate username "${username}".`);
    seen.add(username);
    if (typeof passwordHash !== 'string' || passwordHash === '') {
      throw new UsersError(`${at}: "passwordHash" is required (create one with: wgg hash-password).`);
    }
    if (!isValidHash(passwordHash)) {
      throw new UsersError(
        `${at}: "passwordHash" is not a hash made by "wgg hash-password" (never store the password itself).`,
      );
    }
    if (admin !== undefined && typeof admin !== 'boolean')
      throw new UsersError(`${at}: "admin" must be true or false.`);
    if (email !== undefined && email !== null && (typeof email !== 'string' || !EMAIL.test(email.trim()))) {
      throw new UsersError(`${at}: "email" is not a valid address.`);
    }
    return { username, passwordHash, admin: admin === true, email: email ? email.trim() : null };
  });
  if (!users.some((u) => u.admin)) throw new UsersError('At least one user needs "admin: true".');
  return users;
}

/**
 * Loads config/users.yaml.
 * @param {string} [filePath]
 */
export function loadUsers(filePath = DEFAULT_USERS_PATH) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new UsersError(
        `Users file not found: ${filePath}. wgg needs at least one account: copy ${EXAMPLE_USERS_PATH} to ${filePath}, ` +
          'create a password hash with "wgg hash-password" and paste it in.',
      );
    }
    throw e;
  }
  let raw;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new UsersError(`Invalid YAML in ${filePath}: ${e.message}`);
  }
  return parseUsers(raw);
}
