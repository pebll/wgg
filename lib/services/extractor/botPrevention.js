import { DEFAULT_HEADER } from './utils.js';

const DEFAULT_LANGUAGES = 'de-DE,de;q=0.9,en-US;q=0.7,en;q=0.5';
const DEFAULT_VIEWPORT = { width: 1366, height: 768, deviceScaleFactor: 1 };
const DEFAULT_TIMEZONE = 'Europe/Berlin';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_JITTER = 5;

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Works out locale, viewport and header hints for a launch. Nothing here touches the browser.
 *
 * @param {string} url absolute url of the page that will be fetched
 * @param {object} [options]
 */
export function getPreLaunchConfig(url, options = {}) {
  const hostname = new URL(url).hostname;

  const acceptLanguage = options.acceptLanguage ?? DEFAULT_LANGUAGES;
  const langForFlag = acceptLanguage.split(',')[0].trim();
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;

  // One shared offset keeps the aspect ratio plausible while making the window size vary slightly.
  const jitter = options.viewportJitter === false ? 0 : Math.floor(Math.random() * (MAX_JITTER + 1));
  const requested = options.viewport ?? {};
  const viewport = {
    width: toInt(requested.width, DEFAULT_VIEWPORT.width) + jitter,
    height: toInt(requested.height, DEFAULT_VIEWPORT.height) + jitter,
    deviceScaleFactor: requested.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
  };

  return {
    acceptLanguage,
    langForFlag,
    userAgent,
    viewport,
    windowSizeArg: `--window-size=${viewport.width},${viewport.height}`,
    langArg: `--lang=${langForFlag}`,
    extraArgs: [
      '--disable-blink-features=AutomationControlled',
      '--webrtc-ip-handling-policy=default_public_interface_only',
      '--force-webrtc-ip-handling-policy',
      '--proxy-bypass-list=<-loopback>',
    ],
    headers: {
      ...DEFAULT_HEADER,
      'Accept-Language': acceptLanguage,
      'User-Agent': userAgent,
      Referer: options.referer ?? `https://${hostname}/`,
      Connection: 'keep-alive',
      DNT: '1',
    },
    timezone,
    humanDelay: options.humanDelay !== false,
  };
}
