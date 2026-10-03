import { describe, it, expect } from 'vitest';
import { buildMessages, PROMPT_VERSION } from '../../lib/llm/prompt.js';

const listing = {
  title: 'Helles Zimmer nahe Uni',
  link: 'https://www.wg-gesucht.de/x.1.html',
  price: 520,
  size: 16,
  wgSize: 3,
  district: 'München Maxvorstadt',
  street: 'Amalienstr. 12',
  distanceKm: 0.8,
  geoPrecision: 'address',
  availableFrom: '2026-11-01',
  availableUntil: '2027-03-31',
  onlineRaw: 'Online: 2 Stunden',
  description: 'Zimmer\nSchönes helles Zimmer mit Balkon.',
  detail: {
    costs: [
      { label: 'Miete', raw: '520€', value: 520 },
      { label: 'Nebenkosten', raw: '90€', value: 90 },
      { label: 'Kaution', raw: '1000€', value: 1000 },
    ],
    address: { raw: 'Amalienstr. 12 80333 München', street: 'Amalienstr. 12', postcodeCity: '80333 München' },
    availabilityRaw: '01.11.2026 - 31.03.2027',
    onlineRaw: '2 Stunden',
    wgFacts: [
      { group: 'Die WG', label: null, value: '3er WG' },
      { group: 'Gesucht wird', label: 'Geschlecht', value: 'egal' },
    ],
    objectFacts: [{ label: 'möbliert', value: null }],
  },
};

const userText = (r) => r.messages.find((m) => m.role === 'user').content;
const systemText = (r) => r.messages.find((m) => m.role === 'system').content;

const NOW_FOR_CAL = Date.UTC(2026, 9, 2, 12);

describe('#llm prompt', () => {
  it('system prompt (English) explains the task, signals, traps and the JSON schema', () => {
    const s = systemText(buildMessages(listing, { maxDescriptionChars: 12000 }));
    for (const term of [
      'Studentenverbindung',
      'Burschenschaft',
      'Bundesbrüder',
      'Aktivitas',
      'Semesterprogramm',
      'Kneipe',
      'Altherren',
      'Couleur',
      'Mensur',
      'Füxe',
      'nur männliche Studenten',
      'Lebensbund',
      'gute Verbindung zur U-Bahn',
      'verbindungProbability',
      'verbindungSignals',
      'fitScore',
      'summary',
      'positives',
      'redFlags',
      'JSON',
    ]) {
      expect(s).toContain(term);
    }
  });

  it('the user prompt carries every available listing field', () => {
    const r = buildMessages(listing, { maxDescriptionChars: 12000 });
    const u = userText(r);
    for (const part of [
      'Helles Zimmer nahe Uni',
      '520',
      'Nebenkosten',
      '90€',
      'Kaution',
      '16 m',
      'WG size: 3',
      'München Maxvorstadt',
      'Amalienstr. 12',
      '80333 München',
      '0.8 km',
      '1 November 2026',
      '31 March 2027',
      '2 Stunden',
      '3er WG',
      'Geschlecht: egal',
      'möbliert',
      'Schönes helles Zimmer mit Balkon.',
    ]) {
      expect(u).toContain(part);
    }
    expect(r.truncated).toBe(false);
    expect(u).not.toMatch(/truncated/i);
  });

  it('tells the model who lives in the flat now (only the genders that are known)', () => {
    const withMates = (flatmates) => userText(buildMessages({ ...listing, flatmates }, { maxDescriptionChars: 12000 }));
    expect(withMates({ wgSize: 3, female: 1, male: 1, diverse: 0, unspecified: 0 })).toContain(
      'Current flatmates: 1 woman, 1 man',
    );
    expect(withMates({ wgSize: 3, female: 0, male: 0, diverse: 0, unspecified: 0 })).not.toContain('Current flatmates');
    expect(withMates(null)).not.toContain('Current flatmates');
  });

  it('states the date of today, the near-term rule, the profile and the eligibility schema', () => {
    const now = new Date(2026, 9, 2, 15, 30).getTime();
    const profile = 'Male, 22 years old. Speaks German and English. UNIQUE-PROFILE-TEXT';
    const r = buildMessages(listing, { maxDescriptionChars: 12000, now, profile });
    const s = systemText(r);
    expect(s).toContain('Today is 2 October 2026 (Friday).');
    expect(s).toMatch(/6 weeks/);
    expect(s).toMatch(/DD\.MM\.YYYY/);
    expect(s).toMatch(/About the user/);
    expect(s).toContain('UNIQUE-PROFILE-TEXT');
    expect(s).toContain('eligible');
    expect(s).toContain('eligibilityReason');
    expect(s).toMatch(/nur Frauen/);
    expect(userText(r)).not.toContain('2026-11-01');
  });

  it('defaults to the current date and exposes an integer prompt version', () => {
    const s = systemText(buildMessages(listing, { maxDescriptionChars: 1000 }));
    expect(s).toMatch(/Today is \d{1,2} [A-Z][a-z]+ \d{4} \([A-Z][a-z]+day\)\./);
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(4); // 4: fitScore calibration and deductions;  3: the current flatmates were added
  });

  it('cuts a long description and says so explicitly', () => {
    const long = 'a'.repeat(5000);
    const r = buildMessages({ ...listing, description: long }, { maxDescriptionChars: 1000 });
    expect(r.truncated).toBe(true);
    expect(userText(r)).toContain('[DESCRIPTION TRUNCATED: showing the first 1000 of 5000 characters]');
    expect(userText(r)).not.toContain('a'.repeat(1001));
  });

  it('copes with a sparse listing', () => {
    const u = userText(buildMessages({ title: 'T', description: 'D' }, { maxDescriptionChars: 1000 }));
    expect(u).toContain('T');
    expect(u).toContain('D');
    expect(u).not.toContain('undefined');
    expect(u).not.toContain('null');
  });

  it('calibrates fitScore over the full 1-10 range and asks for deductions that add up', () => {
    const { messages } = buildMessages({ title: 'x' }, { maxDescriptionChars: 100, now: NOW_FOR_CAL });
    const system = messages[0].content;
    expect(system).toContain('FULL 1-10 range');
    expect(system).toMatch(/start from 10/i);
    expect(system).toMatch(/do not cluster/i);
    expect(system).toMatch(/integers are fine/i);
    expect(system).toContain('"deductions"');
    expect(system).toMatch(/10 minus the sum of the deductions/);
    expect(system).toMatch(/empty array when fitScore is 10/);
  });
});

describe('#llm prompt target name', () => {
  const opts = { maxDescriptionChars: 5000, now: NOW_FOR_CAL };

  it("names the user's target in the distance line, never a hardcoded place", () => {
    const text = userText(buildMessages(listing, { ...opts, targetName: 'Marienplatz' }));
    expect(text).toContain('Distance to Marienplatz: 0.8 km (exact address)');
    expect(text).not.toMatch(/TUM|library/i);
  });

  it('falls back to a generic label without a target name', () => {
    expect(userText(buildMessages(listing, opts))).toContain("Distance to the user's target location: 0.8 km");
    expect(userText(buildMessages(listing, { ...opts, targetName: '  ' }))).toContain("the user's target location");
  });
});
