/**
 * Static, clearly fictional example data for the presentation page (no real listing, photo, address or person).
 * The shapes are the ones the API returns, so the real components render them unchanged.
 */

/** The neutral example target the presentation page measures its demo distances to. */
export const DEMO_TARGET = 'your university';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Two example offers: a great match and an ad the AI flags as a Studentenverbindung. `now` keeps "New" fresh. */
export function demoListings(now = Date.now()) {
  const scoring = {
    id: -1,
    title: 'Bright room in a friendly 3er WG (example)',
    price: 620,
    size: 18,
    district: 'Maxvorstadt',
    street: 'Musterweg',
    availableFrom: '2026-11-01',
    availableUntil: null,
    distanceKm: 1.4,
    geoPrecision: 'address',
    image: null,
    photoFallback: 'Example photo',
    publishedAt: now - 22 * MINUTE,
    firstSeenAt: now - 20 * MINUTE,
    wgSize: 3,
    flatmates: { wgSize: 3, female: 1, male: 1, diverse: 0, unspecified: 0, raw: null },
    tier: 'fantastic',
    notified: true,
    notifiedKind: 'priority',
    notifiedAt: now - 15 * MINUTE,
    evaluation: {
      overall: 8.6,
      scores: { rent: 8, distance: 9.5, recency: 10, stayLength: 7 },
      details: {
        rent: '620 € is in the lower third of your range',
        distance: '1.4 km to the target',
        recency: 'posted 22 min ago',
        stayLength: 'open-ended',
      },
      missing: [],
      excludedReason: null,
    },
    llm: {
      status: 'done',
      model: 'example-model',
      evaluatedAt: now - 12 * MINUTE,
      result: {
        eligible: true,
        eligibilityReason: null,
        verbindungProbability: 0.02,
        verbindungSignals: [],
        fitScore: 8.5,
        deductions: [
          { points: 1, reason: 'Far from target (4.3 km)' },
          { points: 0.5, reason: 'No photos of the kitchen' },
        ],
        summary:
          'Calm, tidy flat share with two working flatmates. The room is bright and furnished on request; a long stay is welcome.',
        positives: ['Open-ended contract', 'Balcony and washing machine', 'Short walk to the U-Bahn'],
        redFlags: ['No photos of the kitchen'],
      },
    },
  };

  const verbindung = {
    ...scoring,
    id: -2,
    title: 'Room in a traditional house (example)',
    price: 380,
    size: 16,
    district: 'Schwabing',
    street: 'Beispielgasse',
    distanceKm: 2.1,
    publishedAt: now - 3 * HOUR,
    firstSeenAt: now - 3 * HOUR,
    flatmates: null,
    wgSize: 6,
    tier: null,
    notified: false,
    notifiedKind: null,
    notifiedAt: null,
    hidden: { by: 'program', reason: 'Probably a Studentenverbindung (97 %)' },
    evaluation: { ...scoring.evaluation, overall: 6.1 },
    llm: {
      status: 'done',
      model: 'example-model',
      evaluatedAt: now - 2 * HOUR,
      result: {
        eligible: true,
        eligibilityReason: null,
        verbindungProbability: 0.97,
        verbindungSignals: [
          'Wir sind eine Verbindung mit langer Tradition',
          'Aktivitas und Philister leben im Haus',
          'Fechten und Convent als Teil des Hauslebens',
        ],
        fitScore: 4,
        deductions: [
          { points: 4, reason: 'Fraternity house: "Aktivitas und Philister leben im Haus"' },
          { points: 2, reason: 'Membership expected, no normal flat-share life' },
        ],
        summary: 'The very low rent comes with membership of a fraternity house; the ad is written for members.',
        positives: ['Very cheap'],
        redFlags: ['Fraternity (Studentenverbindung) house', 'Membership expected'],
      },
    },
  };

  return { scoring, verbindung };
}

const bins = (from, step, counts) =>
  counts.map((count, i) => ({ from: from + i * step, to: from + (i + 1) * step, count }));

/** Example histograms for the four distribution charts (the shape of /api/stats). */
export function demoStats() {
  return {
    score: { bins: bins(1, 1, [1, 2, 4, 7, 11, 16, 12, 6, 2]), unscored: 0 },
    ai: { bins: bins(1, 1, [2, 3, 5, 6, 9, 13, 14, 8, 3]), unassessed: 2 },
    rent: { bins: bins(300, 50, [2, 5, 9, 14, 12, 8, 5, 3, 1, 1]), unknown: 0 },
    distance: { bins: bins(0, 2, [4, 14, 18, 11, 6, 3]), unknown: 1 },
  };
}

/** Scoring parameters in display order: [key, label]. */
export const DEMO_PARAMETERS = [
  ['rent', 'Rent'],
  ['distance', 'Distance'],
  ['recency', 'Recency'],
  ['stayLength', 'Stay length'],
];

/** Example weights of the pie. */
export function demoWeights() {
  return { rent: 3, distance: 2, recency: 1, stayLength: 1 };
}

/** What the two alert mails look like: one Fantastic offer right away, or the Good digest. */
export function demoEmail(kind) {
  const { scoring } = demoListings();
  const item = (title, rent, size, district, score, ai) => ({ title, rent, size, district, score, ai });
  if (kind === 'fantastic') {
    return {
      subject: '✦ Fantastic: Bright room in a friendly 3er WG (example)',
      headline: '✦ Fantastic offer',
      items: [item(scoring.title, scoring.price, scoring.size, scoring.district, 8.6, 8.5)],
    };
  }
  return {
    subject: '3 good offers — WG Gefunden!',
    headline: 'Good offers',
    items: [
      item('Quiet room near the park (example)', 560, 15, 'Neuhausen', 7.4, 7.2),
      item('Two-person WG, balcony (example)', 590, 17, 'Haidhausen', 7.1, 6.8),
      item('Cosy attic room (example)', 540, 14, 'Giesing', 6.3, 6.5),
    ],
  };
}
