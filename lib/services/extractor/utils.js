import logger from '../logger.js';

const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Baseline request headers; botPrevention overlays locale-specific values on top. */
export const DEFAULT_HEADER = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': DESKTOP_CHROME,
};

let debugOn = false;

export function setDebug(options) {
  debugOn = Boolean(options?.debug);
}

export function debug(message) {
  if (debugOn) logger.debug(message);
}

const BLOCK_PHRASES = ['verify you are human', 'access denied'];
const CLOUDFRONT_MARKER = 'x-amz-cf-id';
// Genuine CloudFront block pages are tiny; bigger pages merely echo headers into their state.
const CLOUDFRONT_MAX_LENGTH = 4096;

/**
 * Does this response look like a bot wall rather than the page we asked for?
 * @param {unknown} pageSource
 * @param {number} statusCode
 */
export function botDetected(pageSource, statusCode) {
  if (statusCode === 403 || statusCode === 429) return true;

  const text = typeof pageSource === 'string' ? pageSource.toLowerCase() : '';
  if (BLOCK_PHRASES.some((phrase) => text.includes(phrase))) return true;
  return text.length <= CLOUDFRONT_MAX_LENGTH && text.includes(CLOUDFRONT_MARKER);
}
