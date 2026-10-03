import * as cheerio from 'cheerio';
import { extractNumber } from '../utils/extract-number.js';
import { parseFlatmates } from './flatmates.js';
import { parseOnlineAge } from './onlineAge.js';
import { parseAvailability } from './wgGesucht.js';

/**
 * @typedef {object} DetailPage
 * @property {{heading: string|null, text: string}[]} sections
 * @property {string} description
 * @property {{label: string, raw: string, value: number|null}[]} costs
 * @property {{raw: string, street: string|null, postcodeCity: string|null}|null} address
 * @property {string|null} availableFrom
 * @property {string|null} availableUntil
 * @property {string|null} availabilityRaw
 * @property {string|null} onlineRaw
 * @property {number|null} onlineMinutes
 * @property {object|null} flatmates
 * @property {{group: string, label: string|null, value: string}[]} wgFacts
 * @property {{label: string, value: null}[]} objectFacts
 */

const WHITESPACE = /[\s ]+/g;
const SKIPPED_TAGS = new Set(['script', 'style', 'noscript']);
const BLOCK_TAGS = new Set(['p', 'div']);

const squish = (text) => (text ?? '').replace(WHITESPACE, ' ').trim();
const withoutColon = (text) => text.replace(/:\s*$/, '');

/** Text with line structure: <br> and the end of p/div become newlines, everything else collapses. */
function blockText(element) {
  const pieces = [];
  const walk = (node) => {
    if (node.type === 'text') {
      pieces.push(node.data.replace(WHITESPACE, ' '));
    } else if (node.type === 'tag') {
      if (SKIPPED_TAGS.has(node.name)) return;
      if (node.name === 'br') {
        pieces.push('\n');
        return;
      }
      node.children?.forEach(walk);
      if (BLOCK_TAGS.has(node.name)) pieces.push('\n');
    }
  };
  walk(element);

  return pieces
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readSections($) {
  const sections = [];
  const tabs = $('.section_panel_tab[data-text]').toArray();

  if (tabs.length > 0) {
    for (const tab of tabs) {
      const target = $(tab).attr('data-text');
      let body = null;
      try {
        body = $(target).first();
      } catch {
        body = null;
      }
      const text = body?.length ? blockText(body[0]) : '';
      if (!text) continue;
      sections.push({ heading: squish($(tab).find('h2, h3').first().text()) || null, text });
    }
    return sections;
  }

  for (const el of $('[id^="freitext_"]').toArray()) {
    const text = blockText(el);
    if (text) sections.push({ heading: null, text });
  }
  return sections;
}

/** The heading element of a panel; titles match exactly so "Kostenfrei registrieren" never counts. */
const panelHeading = ($, title) =>
  $('h2.section_panel_title')
    .filter((_, el) => squish($(el).text()) === title)
    .first();

function readCosts($) {
  const heading = panelHeading($, 'Kosten');
  if (!heading.length) return [];

  const costs = [];
  heading
    .closest('.section_panel')
    .find('.section_panel_value')
    .each((_, valueEl) => {
      const label = withoutColon(squish($(valueEl).closest('.row').find('.section_panel_detail').first().text()));
      if (!label) return;
      const raw = squish($(valueEl).text());
      costs.push({ label, raw, value: extractNumber(raw) });
    });
  return costs;
}

function readAddress($) {
  const element = $('a[href="#map_container"] .section_panel_detail').first();
  if (!element.length) return null;

  const lines = blockText(element[0])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  return {
    raw: lines.join(' '),
    street: lines.length > 1 ? lines[0] : null,
    postcodeCity: lines.length > 1 ? lines.slice(1).join(' ') : null,
  };
}

function readAvailabilityRows($) {
  const heading = panelHeading($, 'Verfügbarkeit');
  const rows = {};
  if (!heading.length) return rows;

  heading
    .parent()
    .find('.row')
    .each((_, row) => {
      const label = withoutColon(squish($(row).find('.section_panel_detail').first().text())).toLowerCase();
      const valueEl = $(row).find('.section_panel_value').first();
      const value = squish((valueEl.length ? valueEl : $(row).find('b').first()).text());
      if (label && value) rows[label] = value;
    });
  return rows;
}

function readWgFacts($) {
  const heading = panelHeading($, 'WG-Details');
  if (!heading.length) return [];

  const facts = [];
  heading
    .closest('.section_panel')
    .find('h3')
    .each((_, h3) => {
      const group = withoutColon(squish($(h3).text()));
      $(h3)
        .nextAll('ul')
        .first()
        .children('li')
        .each((__, li) => {
          const text = squish($(li).find('.section_panel_detail').first().text());
          if (!text) return;
          const split = /^([^:]{1,40}):\s*(.+)$/.exec(text);
          facts.push(
            split ? { group, label: split[1].trim(), value: split[2].trim() } : { group, label: null, value: text },
          );
        });
    });
  return facts;
}

function readObjectFacts($) {
  const heading = panelHeading($, 'Angaben zum Objekt');
  if (!heading.length) return [];

  return heading
    .closest('.section_panel')
    .find('.utility_icons')
    .first()
    .children('div')
    .toArray()
    .map((el) => squish($(el).text()))
    .filter(Boolean)
    .map((label) => ({ label, value: null }));
}

/**
 * Turns the HTML of one offer's detail page into a structured object. Only what the page contains is returned.
 * @param {string} html
 * @returns {DetailPage}
 */
export function parseDetailPage(html) {
  const $ = cheerio.load(html ?? '');
  $('script, style, noscript').remove();

  const sections = readSections($);
  const description = sections.map(({ heading, text }) => (heading ? `${heading}\n${text}` : text)).join('\n\n');

  const rows = readAvailabilityRows($);
  const availabilityRaw = [rows['frei ab'], rows['frei bis']].filter(Boolean).join(' - ') || null;
  const onlineRaw = rows.online ?? null;

  return {
    sections,
    description,
    costs: readCosts($),
    address: readAddress($),
    availableFrom: rows['frei ab'] ? parseAvailability(rows['frei ab']).from : null,
    availableUntil: rows['frei bis'] ? parseAvailability(rows['frei bis']).from : null,
    availabilityRaw,
    onlineRaw,
    onlineMinutes: onlineRaw ? parseOnlineAge(`Online: ${onlineRaw}`) : null,
    flatmates: parseFlatmates($('[title*="er WG ("]').first().attr('title')),
    wgFacts: readWgFacts($),
    objectFacts: readObjectFacts($),
  };
}
