/**
 * Raised when WG-Gesucht answered with a bot wall / human verification / 403 / 429.
 * The scheduler backs off on it; never try to solve the challenge.
 */
export class BotDetectedError extends Error {
  constructor(url, status = null) {
    super(`Bot detection / human verification triggered for ${url}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'BotDetectedError';
    this.url = url;
    this.status = status;
  }
}

/** Raised for any other failure to load a page (HTTP errors, timeouts, navigation failures). */
export class FetchError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FetchError';
    this.status = status;
  }
}

/** Raised for an invalid config file (also by the notify rule parser). */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
