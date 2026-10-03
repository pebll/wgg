import { BotDetectedError } from '../errors.js';
import execute from '../services/extractor/puppeteerExtractor.js';
import { parse } from '../services/extractor/parser/parser.js';
import { botDetected } from '../services/extractor/utils.js';
import logger from '../services/logger.js';
import mutateQuery from '../services/queryStringMutator.js';
import { extractNumber } from '../utils/extract-number.js';
import { parseFlatmates } from './flatmates.js';
import { parseOnlineAge } from './onlineAge.js';

export { parseOnlineAge };

export const BASE_URL = 'https://www.wg-gesucht.de';
/** WG-Gesucht's "newest first" ordering. */
export const SORT_BY_DATE_PARAM = 'sort_column=0&sort_order=0';

export const metaInformation = {
  countries: ['de'],
  name: 'Wg gesucht',
  baseUrl: 'https://www.wg-gesucht.de/',
  id: 'wgGesucht',
};

// Partner ads share the card class but have no data-id; the parser drops cards without an id.
const CARD = '#main_column .wgg_card';
const FIELDS = {
  id: '@data-id',
  title: 'h2.truncate_title a | trim',
  link: 'h2.truncate_title a@href',
  image: 'img.img-responsive@src',
  detailsRaw: 'div.col-xs-11 | trim',
  priceRaw: '.middle .col-xs-3:not(.text-right) | trim',
  sizeRaw: '.middle .text-right | trim',
  availabilityRaw: '.middle .col-xs-5 | trim',
  onlineRaw: '.bottom span[style*="color"] | trim',
  flatmatesTitle: '[title*="er WG ("]@title',
};

const ISO_DATE = /(\d{2})\.(\d{2})\.(\d{4})/g;

/**
 * "01.08.2026", "01.10.2026 - 30.04.2027" or "ab sofort - 31.12.2026" -> ISO dates.
 * @param {string|null|undefined} raw
 * @returns {{from: string|null, until: string|null}}
 */
export function parseAvailability(raw) {
  const text = raw ?? '';
  const dates = [...text.matchAll(ISO_DATE)].map(([, d, m, y]) => `${y}-${m}-${d}`);
  if (dates.length === 1 && /sofort/i.test(text)) return { from: null, until: dates[0] };
  return { from: dates[0] ?? null, until: dates[1] ?? null };
}

/**
 * Splits "2er WG | Düsseldorf Derendorf | Jülicher Straße 96" into its parts.
 * @param {string|null|undefined} raw
 */
export function parseDetails(raw) {
  const [flatmatesRaw = null, district = null, street = null] = (raw ?? '').split('|').map((p) => p.trim() || null);
  return { flatmatesRaw, wgSize: extractNumber(flatmatesRaw), district, street };
}

function toListing(card) {
  const details = parseDetails(card.detailsRaw);
  const { from, until } = parseAvailability(card.availabilityRaw);
  return {
    providerId: card.id,
    link: card.link ? `${BASE_URL}${card.link}` : null,
    title: card.title ?? '',
    image: card.image ? card.image.replace('small', 'large') : null,
    price: extractNumber(card.priceRaw),
    priceRaw: card.priceRaw,
    size: extractNumber(card.sizeRaw),
    sizeRaw: card.sizeRaw,
    wgSize: details.wgSize,
    flatmatesRaw: details.flatmatesRaw,
    flatmates: parseFlatmates(card.flatmatesTitle),
    district: details.district,
    street: details.street,
    detailsRaw: card.detailsRaw,
    availableFrom: from,
    availableUntil: until,
    availabilityRaw: card.availabilityRaw,
    onlineRaw: card.onlineRaw,
    onlineMinutes: parseOnlineAge(card.onlineRaw),
  };
}

/**
 * @param {string} html a WG-Gesucht search result page
 * @returns {object[]} one listing per real offer, in page order
 */
export function parseListings(html) {
  const cards = parse(CARD, FIELDS, html, BASE_URL);
  if (!cards || cards.length === 0) {
    logger.warn('No offer cards found on the WG-Gesucht result page.');
    return [];
  }
  return cards.map(toListing);
}

/**
 * Fetches a search page sorted by date and parses it.
 * @param {string} searchUrl
 * @param {{fetchHtml?: (url: string) => Promise<string>, browser?: object}} [options]
 */
export async function fetchListings(searchUrl, { fetchHtml, browser } = {}) {
  const url = mutateQuery(searchUrl, SORT_BY_DATE_PARAM);
  const html = fetchHtml ? await fetchHtml(url) : await execute(url, 'body', { browser, name: 'wgGesucht' });
  if (botDetected(html, 200)) throw new BotDetectedError(url);
  return parseListings(html);
}
