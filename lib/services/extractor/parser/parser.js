import * as cheerio from 'cheerio';
import logger from '../../logger.js';

const MODIFIERS = {
  int: (value) => Number.parseInt(value, 10),
  trim: (value) => String(value).replace(/\s+/g, ' ').trim(),
  removeNewline: (value) => String(value).replace(/\n/g, ' '),
};

/**
 * Reads one field from a card. Expression grammar: `<selector>[@<attribute>] [| modifier ...]`.
 *
 * @param {import('cheerio').Cheerio<any>} scope
 * @param {string} expression
 * @returns {string|number|null}
 */
export function extractField(scope, expression) {
  if (!expression) return null;

  const [target, ...modifiers] = expression.split('|').map((part) => part.trim());
  const at = target.indexOf('@');

  let value;
  if (at === -1) {
    value = scope.find(target).text();
  } else {
    const selector = target.slice(0, at).trim();
    const attribute = target.slice(at + 1).trim();
    const element = selector ? scope.find(selector).first() : scope;
    value = element.attr(attribute);
  }

  for (const name of modifiers) {
    if (!value) break;
    const apply = MODIFIERS[name];
    if (apply) value = apply(value);
    else logger.warn(`Unknown field modifier "${name}" ignored.`);
  }

  return value || null;
}

/**
 * Extracts one plain object per element matching `container`. Cards whose `id` field is empty are skipped.
 *
 * @param {string} container CSS selector for one card
 * @param {Record<string, string>} fields output key -> field expression
 * @param {string} text page html
 * @param {string} url only used in log messages
 * @returns {object[]|null} null when there is nothing to parse
 */
export function parse(container, fields, text, url) {
  if (!text || !container || !fields) {
    logger.debug(`Nothing to parse for ${url}`);
    return null;
  }

  const $ = cheerio.load(text);
  const cards = $(container);
  if (cards.length === 0) {
    logger.debug(`No elements matched "${container}" on ${url}`);
    return null;
  }

  const rows = [];
  cards.each((_, el) => {
    const card = $(el);
    const row = {};
    for (const [key, expression] of Object.entries(fields)) {
      try {
        row[key] = extractField(card, expression);
      } catch (error) {
        logger.error(`Could not extract "${key}" from ${url}: ${error.message}`);
        row[key] = null;
      }
    }
    if (row.id === null || row.id === undefined) {
      logger.debug(`Skipping a card without an id on ${url}`);
      return;
    }
    rows.push(row);
  });
  return rows;
}
