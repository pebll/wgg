import Db from './Db.js';

/** Small key/value flags of the application (table app_meta). */
export function getMeta(key) {
  return Db.query('SELECT value FROM app_meta WHERE key = @key', { key })[0]?.value ?? null;
}

export function setMeta(key, value) {
  Db.execute('INSERT INTO app_meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value', {
    key,
    value: String(value),
  });
}
