import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

export const MIN_PASSWORD_LENGTH = 10;

const PREFIX = 'scrypt$';
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// scrypt needs about 128 * N * r bytes; leave generous head-room above that.
const maxmemFor = (n, r) => 256 * n * r;

const HEX = /^(?:[0-9a-f]{2})+$/i;
const UINT = /^\d+$/;

function derive(password, salt, n, r, p, length) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { N: n, r, p, maxmem: maxmemFor(n, r) }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function parseHash(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return null;
  const parts = stored.slice(PREFIX.length).split('$');
  if (parts.length !== 5) return null;
  const [nText, rText, pText, saltHex, keyHex] = parts;
  if (![nText, rText, pText].every((x) => UINT.test(x))) return null;
  const [n, r, p] = [Number(nText), Number(rText), Number(pText)];
  if (n < 2 || (n & (n - 1)) !== 0 || r < 1 || p < 1) return null;
  if (!HEX.test(saltHex) || !HEX.test(keyHex)) return null;
  return { n, r, p, salt: Buffer.from(saltHex, 'hex'), key: Buffer.from(keyHex, 'hex') };
}

export function isValidHash(stored) {
  return parseHash(stored) !== null;
}

/** @returns {Promise<string>} `scrypt$N$r$p$saltHex$hashHex` */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM, KEY_BYTES);
  return `${PREFIX}${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Never throws: anything unusable simply does not verify. */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== 'string' || password === '') return false;
  try {
    const candidate = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.key.length);
    return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
  } catch {
    return false;
  }
}

/** Well-formed hash nobody can match; lets a login for an unknown user cost one derivation as well. */
export const DUMMY_HASH = `${PREFIX}${COST}$${BLOCK_SIZE}$${PARALLELISM}$${'00'.repeat(SALT_BYTES)}$${'00'.repeat(KEY_BYTES)}`;
