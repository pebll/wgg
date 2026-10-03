import { domainToUnicode } from 'node:url';
import {
  aiScore,
  breakdownRows,
  deductionRows,
  formatAvailability,
  formatDistance,
  formatLocation,
  formatRent,
  formatScore,
  formatSize,
  postedAt,
  safeLink,
} from '../../ui/src/services/format.js';

/**
 * Email composer: turns API-shaped listings (see `toApiListing` in listingsStorage.js) into `{subject, text, html}`.
 * Pure functions, no I/O. All listing text is untrusted (it is scraped, and the AI summary quotes it): the HTML escapes
 * every value and only emits http(s) links; the subject is a single line.
 */

const CORAL = '#F2633A';
const BRAND = 'WG Gefunden!';
const has = (v) => v !== null && v !== undefined && v !== '';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const district = (l) => (has(l.district) ? oneLine(l.district).replace(/^München\s+/i, '') : null);

function subjectOf(l) {
  const parts = [`★ ${formatScore(l.evaluation?.overall)}`];
  const ai = aiScore(l.llm);
  if (ai !== null) parts.push(`AI ${formatScore(ai)}`);
  if (has(l.price)) parts.push(formatRent(l.price));
  if (district(l)) parts.push(district(l));
  return `${parts.join(' · ')} — ${BRAND}`;
}

/** "Why not 10?" lines of an AI result: the deductions, or `perfect` for a 10 without any. */
function whyNot10(r) {
  const { perfect, rows } = deductionRows(r);
  return { perfect, deductions: rows.map((d) => d.text) };
}

/** The AI part of a listing as plain facts (null without a finished assessment). */
function aiFacts(l) {
  if (l.llm?.status !== 'done' || !l.llm.result) return null;
  const r = l.llm.result;
  const p = r.verbindungProbability;
  return {
    fit: aiScore(l.llm),
    verbindung: typeof p === 'number' ? `${Math.round(p * 100)} %` : null,
    eligible: r.eligible !== false,
    eligibilityReason: r.eligibilityReason || '',
    summary: r.summary || '',
    positives: Array.isArray(r.positives) ? r.positives : [],
    redFlags: Array.isArray(r.redFlags) ? r.redFlags : [],
    ...whyNot10(r),
  };
}

function facts(l, now, targetName) {
  return [
    ['Rent', formatRent(l.price)],
    ['Size', formatSize(l.size)],
    ['WG size', has(l.wgSize) ? `${l.wgSize} people` : '---'],
    ['Location', formatLocation(l.district, l.street)],
    ['Distance', formatDistance(l.distanceKm, l.geoPrecision, targetName)],
    ['Available', formatAvailability(l.availableFrom, l.availableUntil, now)],
    ['Posted', postedAt(l, now)],
  ];
}

function plainListing(l, now, targetName) {
  const lines = [oneLine(l.title || 'Untitled listing'), ''];
  for (const [k, v] of facts(l, now, targetName)) lines.push(`${k}: ${v}`);
  const { rows, excludedReason } = breakdownRows(l.evaluation);
  lines.push('', `Score: ${formatScore(l.evaluation?.overall)} / 10`);
  if (excludedReason) lines.push(`Excluded: ${excludedReason}`);
  for (const r of rows) lines.push(`  ${r.param}: ${formatScore(r.score)}${r.detail ? ` - ${r.detail}` : ''}`);
  const ai = aiFacts(l);
  if (ai) {
    lines.push('', `AI fit: ${formatScore(ai.fit)} / 10`);
    if (ai.verbindung) lines.push(`Verbindung probability: ${ai.verbindung}`);
    lines.push(ai.eligible ? 'Eligible: yes' : `Eligible: NO - ${ai.eligibilityReason || 'not eligible'}`);
    if (ai.summary) lines.push(ai.summary);
    if (ai.positives.length) lines.push('Positives:', ...ai.positives.map((s) => `  + ${s}`));
    if (ai.redFlags.length) lines.push('Red flags:', ...ai.redFlags.map((s) => `  ! ${s}`));
    if (ai.perfect) lines.push('Perfect match');
    else if (ai.deductions.length) lines.push('Why not 10?', ...ai.deductions.map((s) => `  ${s}`));
  }
  const link = safeLink(l.link);
  if (link) lines.push('', `WG-Gesucht: ${link}`);
  return lines.join('\n');
}

const FONT = 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;';
const esc = escapeHtml;

function htmlList(title, items, color) {
  if (items.length === 0) return '';
  const lis = items.map((s) => `<li>${esc(s)}</li>`).join('');
  return `<p style="margin:8px 0 2px;font-weight:bold;color:${color}">${title}</p><ul style="margin:0;padding-left:20px">${lis}</ul>`;
}

function htmlAi(l) {
  const ai = aiFacts(l);
  if (!ai) return '';
  const meta = [`AI fit <b>${esc(formatScore(ai.fit))} / 10</b>`];
  if (ai.verbindung) meta.push(`Verbindung probability <b>${esc(ai.verbindung)}</b>`);
  meta.push(ai.eligible ? 'Eligible' : `<b style="color:#C0392B">Not eligible: ${esc(ai.eligibilityReason || '')}</b>`);
  return (
    `<div style="margin-top:14px;padding:10px 12px;background:#FFF3EE;border-left:4px solid ${CORAL}">` +
    `<p style="margin:0 0 6px">${meta.join(' &middot; ')}</p>` +
    (ai.summary ? `<p style="margin:0">${esc(ai.summary)}</p>` : '') +
    htmlList('Positives', ai.positives, '#2E7D32') +
    htmlList('Red flags', ai.redFlags, '#C0392B') +
    (ai.perfect
      ? '<p style="margin:8px 0 0;font-weight:bold;color:#2E7D32">Perfect match</p>'
      : htmlList('Why not 10?', ai.deductions, '#555')) +
    '</div>'
  );
}

function htmlBreakdown(l) {
  const { rows, excludedReason } = breakdownRows(l.evaluation);
  const trs = rows
    .map(
      (r) =>
        `<tr><td style="padding:2px 8px 2px 0;color:#555">${esc(r.param)}</td>` +
        `<td style="padding:2px 8px 2px 0"><b>${esc(formatScore(r.score))}</b></td>` +
        `<td style="padding:2px 0;color:#555">${esc(r.detail ?? '')}</td></tr>`,
    )
    .join('');
  return (
    `<p style="margin:14px 0 4px;font-weight:bold">Score ${esc(formatScore(l.evaluation?.overall))} / 10</p>` +
    (excludedReason ? `<p style="margin:0;color:#C0392B">Excluded: ${esc(excludedReason)}</p>` : '') +
    `<table style="border-collapse:collapse;font-size:14px">${trs}</table>`
  );
}

function htmlButton(link, label) {
  const href = safeLink(link);
  if (!href) return '';
  return `<p style="margin:16px 0 0"><a href="${esc(href)}" style="display:inline-block;padding:10px 18px;background:${CORAL};color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">${esc(label)}</a></p>`;
}

function htmlPhoto(l, width) {
  const src = safeLink(l.image);
  return src
    ? `<img src="${esc(src)}" alt="" width="${width}" style="display:block;max-width:100%;height:auto;border-radius:6px;margin-bottom:12px">`
    : '';
}

/** Absolute link to the app (server.publicUrl) with a trailing slash; null when not configured or not http(s). */
function appLink(appUrl) {
  const href = appUrl ? safeLink(appUrl) : null;
  return href ? `${href.replace(/\/+$/, '')}/` : null;
}

/** Readable form of the app link for display: the Unicode host ("wgg.léo.com") plus any path; the href stays punycode. */
function appLabel(appUrl) {
  const href = appLink(appUrl);
  if (!href) return null;
  const { host, pathname } = new URL(href);
  return `${domainToUnicode(host)}${pathname.replace(/\/+$/, '')}`;
}

function htmlAppFooter(appUrl) {
  const href = appLink(appUrl);
  return href
    ? `<p style="margin:18px 0 0;font-size:13px">Open ${BRAND} &rarr; <a href="${esc(href)}" style="color:${CORAL}">${esc(appLabel(appUrl))}</a></p>`
    : '';
}

/** Plain-text header line: "WG Gefunden! · wgg.léo.com" (empty without an app URL). */
function textHeader(appUrl) {
  const label = appLabel(appUrl);
  return label ? `${BRAND} \u00b7 ${label}\n\n` : '';
}

/** Plain-text footer: the readable label, then the real URL so mail clients make it clickable. */
function textFooter(appUrl) {
  const href = appLink(appUrl);
  return href ? `Open ${BRAND} \u2192 ${appLabel(appUrl)} (${href})` : '';
}

function page(inner, appUrl) {
  const href = appLink(appUrl);
  const site = href
    ? ` <span style="font-weight:normal;color:#555">&middot; <a href="${esc(href)}" style="color:${CORAL}">${esc(appLabel(appUrl))}</a></span>`
    : '';
  return (
    `<!doctype html><html><body style="margin:0;padding:16px;background:#f5f5f5;${FONT}">` +
    `<div style="max-width:600px;margin:0 auto;background:#fff;padding:20px;border-radius:8px">` +
    `<p style="margin:0 0 14px;font-size:13px;font-weight:bold;color:${CORAL}">${BRAND}${site}</p>${inner}</div></body></html>`
  );
}

/**
 * One listing, in full: the "Fantastic" alert (config key `notify.priority`), sent right after the AI assessment.
 * @param {object} listing API-shaped listing.
 * @param {{now?: number, appUrl?: string, targetName?: string}} [options] `appUrl`: server.publicUrl, adds an absolute link
 *   to the app; `targetName`: the recipient's scoring target, named in the distance.
 * @returns {{subject: string, text: string, html: string}}
 */
export function composePriority(listing, { now = Date.now(), appUrl, targetName } = {}) {
  const l = listing;
  const rows = facts(l, now, targetName)
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${k}</td><td>${esc(v)}</td></tr>`)
    .join('');
  const html = page(
    `<p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:${CORAL}">✦ Fantastic offer</p>` +
      htmlPhoto(l, 560) +
      `<h2 style="margin:0 0 10px;font-size:20px">${esc(oneLine(l.title || 'Untitled listing'))}</h2>` +
      `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` +
      htmlBreakdown(l) +
      htmlAi(l) +
      htmlButton(l.link, 'Open on WG-Gesucht') +
      htmlAppFooter(appUrl),
    appUrl,
  );
  const footer = textFooter(appUrl);
  const text =
    `${textHeader(appUrl)}✦ Fantastic offer\n\n${plainListing(l, now, targetName)}` + (footer ? `\n\n${footer}` : '');
  return { subject: oneLine(`✦ Fantastic: ${subjectOf(l)}`), text, html };
}

const overallOf = (l) => (typeof l.evaluation?.overall === 'number' ? l.evaluation.overall : -1);

function digestLine(l, now, targetName) {
  const ai = aiScore(l.llm);
  const head = [
    `★ ${formatScore(l.evaluation?.overall)}`,
    ai !== null ? `AI ${formatScore(ai)}` : null,
    formatRent(l.price),
    formatSize(l.size),
    district(l),
  ].filter(Boolean);
  const lines = [head.join(' · '), oneLine(l.title || 'Untitled listing')];
  const summary = aiFacts(l)?.summary;
  if (summary) lines.push(summary);
  lines.push(
    `${formatDistance(l.distanceKm, l.geoPrecision, targetName)}, available ${formatAvailability(l.availableFrom, l.availableUntil, now)}`,
  );
  const link = safeLink(l.link);
  if (link) lines.push(link);
  return lines.join('\n');
}

function digestCard(l, now, targetName) {
  const ai = aiScore(l.llm);
  const head = [
    `<b style="color:${CORAL}">★ ${esc(formatScore(l.evaluation?.overall))}</b>`,
    ai !== null ? `AI ${esc(formatScore(ai))}` : null,
    esc(formatRent(l.price)),
    esc(formatSize(l.size)),
    district(l) ? esc(district(l)) : null,
  ].filter(Boolean);
  const summary = aiFacts(l)?.summary;
  const href = safeLink(l.link);
  return (
    `<div style="padding:12px 0;border-top:1px solid #e5e5e5">` +
    htmlPhoto(l, 200) +
    `<p style="margin:0 0 4px">${head.join(' &middot; ')}</p>` +
    `<p style="margin:0 0 4px;font-weight:bold">${esc(oneLine(l.title || 'Untitled listing'))}</p>` +
    (summary ? `<p style="margin:0 0 4px;font-size:14px">${esc(summary)}</p>` : '') +
    `<p style="margin:0 0 6px;font-size:13px;color:#555">${esc(formatDistance(l.distanceKm, l.geoPrecision, targetName))}, available ${esc(formatAvailability(l.availableFrom, l.availableUntil, now))}</p>` +
    (href ? `<a href="${esc(href)}" style="color:${CORAL};font-weight:bold">Open on WG-Gesucht</a>` : '') +
    '</div>'
  );
}

/**
 * A digest of several "Good" listings (config key `notify.bulk`), best overall score first.
 * @param {object[]} listings API-shaped listings (at least one).
 * @param {{now?: number, appUrl?: string, targetName?: string}} [options]
 * @returns {{subject: string, text: string, html: string}}
 */
export function composeDigest(listings, { now = Date.now(), appUrl, targetName } = {}) {
  if (listings.length === 0) throw new Error('Refusing to compose an empty digest');
  const sorted = [...listings].sort((a, b) => overallOf(b) - overallOf(a));
  const n = sorted.length;
  const noun = `good ${n === 1 ? 'offer' : 'offers'}`;
  const subject = `${n} ${noun} — ${BRAND}`;
  const footer = textFooter(appUrl);
  const text = [
    `${textHeader(appUrl)}${n} ${noun}, best score first:`,
    '',
    ...sorted.map((l) => digestLine(l, now, targetName) + '\n'),
    ...(footer ? [footer] : []),
  ].join('\n');
  const html = page(
    `<h2 style="margin:0 0 6px;font-size:20px">${n} ${noun}</h2>` +
      sorted.map((l) => digestCard(l, now, targetName)).join('') +
      htmlAppFooter(appUrl),
    appUrl,
  );
  return { subject, text: text.trimEnd(), html };
}

/**
 * The test email ("Send test email" in Options, `wgg test-mail`): proves that alerts reach this address.
 * @param {{username?: string}} [options]
 * @returns {{subject: string, text: string, html: string}}
 */
export function composeTestMail({ username } = {}) {
  const who = username ? ` for ${username}` : '';
  const text = `This is a test email from wgg${who}. If you can read this, email alerts will reach you.`;
  return {
    subject: `${BRAND} test email`,
    text,
    html: page(
      `<p style="margin:0">This is a <b style="color:${CORAL}">${BRAND}</b> test email${esc(who)}. If you can read this, email alerts will reach you.</p>`,
    ),
  };
}
