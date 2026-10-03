// The one prompt the LLM assessment sends: a fixed English system prompt and a user message with every piece of
// listing information wgg has (card data and, once fetched, the detail page).

import { describeFlatmates } from '../provider/flatmates.js';

/** Bump whenever the prompt or the answer schema changes: the LLM worker re-assesses listings of older versions. */
export const PROMPT_VERSION = 4;

/** Used when `llm.profile` is not configured. */
export const DEFAULT_PROFILE = 'A student looking for a normal, friendly shared flat in Munich.';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "2 October 2026" (European text, unambiguous for the model) */
function longDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** An ISO date ("2026-11-01") becomes "1 November 2026"; any other text is returned unchanged. */
function formatAvailable(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return value;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? value : longDate(date);
}

/**
 * The fixed English system prompt, with today's date and the user profile filled in.
 * @param {{now?: number, profile?: string}} [options]
 */
export function buildSystemPrompt({ now = Date.now(), profile } = {}) {
  const today = new Date(now);
  const about = String(profile ?? '').trim() || DEFAULT_PROFILE;
  return `You assess room listings from the German flat-share site WG-Gesucht for one user.

Today is ${longDate(today)} (${WEEKDAYS[today.getDay()]}). Judge availability relative to today: a start date within about 6 weeks is near-term, not "far in the future"; only dates months away are far. Dates in German ads are written DD.MM.YYYY (day first), so 02.10.2026 is 2 October 2026.

## About the user
${about}

Use this profile to judge fit and eligibility. The user wants a NORMAL shared flat (WG) or room in Munich and wants to avoid Studentenverbindungen (student fraternities: Burschenschaften, Corps, Landsmannschaften, Turnerschaften, Verbindungshäuser) that rent out rooms in their houses, often without saying so openly.

Typical signals of a Studentenverbindung:
- very cheap rent for a prime central location (Maxvorstadt, Schwabing, Lehel, Glockenbach, ...)
- "Haus" / "Verbindungshaus" / "Studentenverbindung" / "Burschenschaft" / "Corps" / "Landsmannschaft" / "Turnerschaft"
- "Bundesbrüder", "Aktivitas", "Aktive", "Semesterprogramm", "Kneipe", "Alte Herren" / "Altherren", "Couleur", "Mensur", "Füxe" / "Fuchs", "Lebensbund", "Gemeinschaft mit Tradition", "Convent"
- "nur männliche Studenten" or other gender/status restrictions on who may move in
- a large house with many rooms and a community life, events, duties or "Hausgemeinschaft" obligations

Beware of false positives: a plain "gute Verbindung zur U-Bahn" or "gute Verkehrsverbindung" is public transport, not a fraternity. A normal WG with a "Gemeinschaftsküche" is normal. Judge the whole text, not single words.

Eligibility: decide whether the user may realistically move in. Set "eligible" to false only when the ad explicitly excludes the user, for example only women ("nur Frauen", "Mitbewohnerin gesucht", "female roommate"), an age range that excludes the user's age, only non-students when the user is a student (or only students when he is not), or a required language the user does not speak. Otherwise "eligible" is true; do not guess from weak hints. Put a short English reason in "eligibilityReason" (empty when eligible).

Also judge how attractive the room is for this user: value for money, size, condition, location, flatmates and atmosphere, transparency of the ad, and how well the flat share matches the profile (active, social WG life scores higher; a pure Zweck-WG, where flatmates just share costs and live separate lives, scores low; an international, open-minded flat scores higher). Watch for scam signs (advance payment, key by post, contact only via messenger or e-mail, price far below market, an owner abroad).

## Calibrating fitScore
Use the FULL 1-10 range. Start from 10 = a perfect match for THIS user's profile and deduct points for each concrete shortcoming (price, size, location, flatmates, atmosphere, contract, transparency, scam signs, mismatch with the profile). Anchors:
- 10: exceptional, no relevant drawbacks
- 8-9: strong match with minor drawbacks
- 6-7: decent, with clear trade-offs
- 4-5: mediocre, several drawbacks
- 2-3: poor fit
- 1: unacceptable or ineligible
Do not cluster scores around 5-7: a flat with no real drawbacks deserves 9 or 10, a bad one 2-3. Integers are fine; use halves only when it matters.
Explain every point you remove in "deductions": one entry per shortcoming with the points taken off (0.5 to 9) and a short, concrete English reason (you may quote the German evidence). The deductions must add up: 10 minus the sum of the deductions equals fitScore (rounding by up to 0.5 is fine). Use an empty array when fitScore is 10.

Answer with ONE JSON object and nothing else (no prose, no code fences), exactly with these keys:
{
  "verbindungProbability": number between 0 and 1,
  "verbindungSignals": string[] (short quotes of the German evidence, empty if none),
  "eligible": boolean (false only when the ad explicitly excludes the user),
  "eligibilityReason": string (English, short; empty when eligible),
  "fitScore": number between 1 and 10 (overall attractiveness for this user, including the WG atmosphere match; calibrated as described above),
  "deductions": [{"points": number between 0.5 and 9, "reason": string (English, short, concrete)}] (empty array when fitScore is 10),
  "summary": string (English, at most 2 sentences),
  "positives": string[] (English, short),
  "redFlags": string[] (English, short; include scam signs)
}`;
}

const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

function costLines(costs = []) {
  return costs.map((c) => `  - ${c.label}: ${c.raw}`);
}

function factLines(facts = []) {
  return facts.map((f) => {
    const text = has(f.label) && has(f.value) ? `${f.label}: ${f.value}` : (f.value ?? f.label);
    return `  - ${f.group ? `[${f.group}] ` : ''}${text}`;
  });
}

/** The place distances are measured to, as the user named it (a neutral label when it has no name). */
const targetLabel = (name) => (typeof name === 'string' && name.trim() ? name.trim() : "the user's target location");

/**
 * @param {import('../evaluation/ruleBasedEvaluator.js').EvaluatedListing & {link?: string|null, onlineRaw?: string|null, detail?: object}} listing
 * @param {{maxDescriptionChars: number, profile?: string, targetName?: string, now?: number}} options
 * @returns {{messages: {role: string, content: string}[], truncated: boolean, descriptionChars: number}}
 */
export function buildMessages(listing, { maxDescriptionChars, profile, targetName, now = Date.now() }) {
  const d = listing.detail ?? {};
  const lines = [];
  const add = (label, value) => {
    if (has(value)) lines.push(`${label}: ${value}`);
  };

  add('Title', listing.title);
  add('Link', listing.link);
  add('Rent (monthly)', has(listing.price) ? `${listing.price} €` : null);
  if (d.costs?.length) lines.push('Costs:', ...costLines(d.costs));
  add('Room size', has(listing.size) ? `${listing.size} m²` : null);
  add('WG size', listing.wgSize);
  add('Current flatmates', describeFlatmates(listing.flatmates));
  add('District', listing.district);
  add('Street', listing.street);
  add('Exact address', d.address?.raw);
  add(
    `Distance to ${targetLabel(targetName)}`,
    has(listing.distanceKm)
      ? `${listing.distanceKm} km (${listing.geoPrecision === 'address' ? 'exact address' : 'district centroid, approximate'})`
      : null,
  );
  add('Available from', has(listing.availableFrom) ? formatAvailable(listing.availableFrom) : null);
  add('Available until', has(listing.availableUntil) ? formatAvailable(listing.availableUntil) : null);
  add('Availability (as written)', d.availabilityRaw);
  add('Online since', d.onlineRaw ?? listing.onlineRaw);
  if (d.wgFacts?.length) lines.push('Flat-share facts:', ...factLines(d.wgFacts));
  if (d.objectFacts?.length) lines.push('Property facts:', ...factLines(d.objectFacts));

  const full = String(listing.description ?? '').trim();
  const truncated = full.length > maxDescriptionChars;
  const shown = truncated ? full.slice(0, maxDescriptionChars) : full;
  lines.push('', 'Full description (German):', shown);
  if (truncated) {
    lines.push(`[DESCRIPTION TRUNCATED: showing the first ${maxDescriptionChars} of ${full.length} characters]`);
  }

  return {
    messages: [
      { role: 'system', content: buildSystemPrompt({ now, profile }) },
      { role: 'user', content: `Assess this listing.\n\n${lines.join('\n')}` },
    ],
    truncated,
    descriptionChars: full.length,
  };
}
