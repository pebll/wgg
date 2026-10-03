import { describe, it, expect } from 'vitest';
import { composePriority, composeDigest, composeTestMail, escapeHtml } from '../../lib/notify/composer.js';

const NOW = new Date(2026, 9, 2, 14, 32, 0).getTime();

const listing = (over = {}) => ({
  id: 1,
  providerId: '11',
  link: 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen-Maxvorstadt.11.html',
  title: 'Sunny room near the park',
  image: 'https://img.wg-gesucht.de/media/11.jpg',
  price: 650,
  size: 18,
  wgSize: 3,
  district: 'Maxvorstadt',
  street: 'Teststr. 1',
  availableFrom: '2026-11-01',
  availableUntil: null,
  publishedAt: NOW - 20 * 60_000,
  firstSeenAt: NOW - 15 * 60_000,
  distanceKm: 1.24,
  geoPrecision: 'address',
  evaluation: {
    overall: 8.44,
    scores: { rent: 9, size: 7, llm: 8 },
    details: { rent: 'Cheap for the area', size: 'Medium size', llm: 'Nice.' },
    missing: [],
    excludedReason: null,
  },
  llm: {
    status: 'done',
    result: {
      fitScore: 8,
      verbindungProbability: 0.15,
      eligible: true,
      eligibilityReason: '',
      summary: 'A calm WG of students.',
      positives: ['Balcony', 'Quiet'],
      redFlags: ['Short contract'],
      deductions: [
        { points: 1, reason: 'far from A&B' },
        { points: 1, reason: 'Zweck-WG' },
      ],
    },
  },
  ...over,
});

describe('#escapeHtml', () => {
  it('escapes the five HTML special characters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  });
});

describe('#priority mail', () => {
  it('builds the subject from score, AI score, rent and district', () => {
    const m = composePriority(listing(), { now: NOW });
    expect(m.subject).toBe('✦ Fantastic: ★ 8.4 · AI 8 · 650 € · Maxvorstadt — WG Gefunden!');
  });

  it('says in the body that it is a Fantastic offer', () => {
    const m = composePriority(listing(), { now: NOW });
    expect(m.text.startsWith('✦ Fantastic offer')).toBe(true);
    expect(m.html).toContain('✦ Fantastic offer');
  });

  it('copes with missing values in the subject and never breaks the header line', () => {
    const m = composePriority(
      listing({ price: null, district: 'Evil\r\nBcc: x@y.z', evaluation: { overall: 6, scores: {}, details: {} } }),
      { now: NOW },
    );
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toContain('★ 6');
  });

  it('puts key facts, breakdown, AI block and the link in the plain text', () => {
    const { text } = composePriority(listing(), { now: NOW, targetName: 'Marienplatz' });
    for (const part of [
      'Sunny room near the park',
      '650 €',
      '18 m²',
      '3 people',
      'Maxvorstadt',
      'Teststr. 1',
      '1.2 km to Marienplatz',
      '1 November 2026',
      'posted 20 min ago',
      'rent: 9',
      'Cheap for the area',
      'AI fit: 8 / 10',
      'Verbindung probability: 15 %',
      'A calm WG of students.',
      'Balcony',
      'Short contract',
      'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen-Maxvorstadt.11.html',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('renders an HTML body with the photo, the coral brand colour and a direct link', () => {
    const { html } = composePriority(listing(), { now: NOW });
    expect(html).toContain('#F2633A');
    expect(html).toContain('<img src="https://img.wg-gesucht.de/media/11.jpg"');
    expect(html).toContain('href="https://www.wg-gesucht.de/wg-zimmer-in-Muenchen-Maxvorstadt.11.html"');
    expect(html).toContain('Cheap for the area');
    expect(html).toContain('A calm WG of students.');
  });

  it('shows a not-eligible assessment with its reason', () => {
    const l = listing();
    l.llm.result = { ...l.llm.result, eligible: false, eligibilityReason: 'Only women wanted' };
    expect(composePriority(l, { now: NOW }).text).toContain('Only women wanted');
  });

  it('escapes all listing text in the HTML and only keeps http(s) links', () => {
    const evil = '<script>alert(1)</script>';
    const l = listing({
      title: evil,
      district: evil,
      street: evil,
      link: 'javascript:alert(1)',
      image: 'javascript:alert(2)',
    });
    l.evaluation.details.rent = evil;
    l.llm.result.summary = evil;
    l.llm.result.positives = [evil];
    l.llm.result.redFlags = [`"><img src=x onerror=alert(3)>`];
    const { html, text } = composePriority(l, { now: NOW });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src="javascript');
    expect(text).not.toContain('javascript:');
  });
});

describe('#digest mail', () => {
  it('uses a count subject and sorts the cards by overall score, best first', () => {
    const a = listing({ id: 1, title: 'Low one', evaluation: { overall: 5.5, scores: {}, details: {} } });
    const b = listing({ id: 2, title: 'High one', evaluation: { overall: 7.9, scores: {}, details: {} } });
    const m = composeDigest([a, b], { now: NOW });
    expect(m.subject).toBe('2 good offers — WG Gefunden!');
    expect(m.text.indexOf('High one')).toBeLessThan(m.text.indexOf('Low one'));
    expect(m.html.indexOf('High one')).toBeLessThan(m.html.indexOf('Low one'));
    expect(m.html).toContain('#F2633A');
  });

  it('says "1 good offer" for a single listing and shows rent, AI score and link', () => {
    const m = composeDigest([listing()], { now: NOW });
    expect(m.subject).toBe('1 good offer — WG Gefunden!');
    expect(m.text).toContain('1 good offer, best score first');
    expect(m.html).toContain('1 good offer</h2>');
    expect(m.text).toContain('650 €');
    expect(m.text).toContain('AI 8');
    expect(m.text).toContain('https://www.wg-gesucht.de/wg-zimmer-in-Muenchen-Maxvorstadt.11.html');
  });

  it('escapes listing text in the digest too', () => {
    const m = composeDigest([listing({ title: '<b onmouseover=x>hi</b>' })], { now: NOW });
    expect(m.html).not.toContain('<b onmouseover');
    expect(m.html).toContain('&lt;b onmouseover=x&gt;');
  });

  it('has a Fantastic variant for the morning mail with the offers of the night', () => {
    const a = listing({ id: 1, title: 'Low one', evaluation: { overall: 8.1, scores: {}, details: {} } });
    const b = listing({ id: 2, title: 'High one', evaluation: { overall: 9.4, scores: {}, details: {} } });
    const m = composeDigest([a, b], { now: NOW, tier: 'fantastic' });
    expect(m.subject).toBe('✦ 2 Fantastic offers overnight — WG Gefunden!');
    expect(m.text).toContain('✦ 2 Fantastic offers overnight, best score first:');
    expect(m.html).toContain('✦ 2 Fantastic offers overnight</h2>');
    expect(m.text.indexOf('High one')).toBeLessThan(m.text.indexOf('Low one'));
  });

  it('refuses an empty digest', () => {
    expect(() => composeDigest([], { now: NOW })).toThrow('empty digest');
  });
});

describe('#composeTestMail', () => {
  it('is a short mail naming the user, escaped in HTML', () => {
    const mail = composeTestMail({ username: 'anna' });
    expect(mail.subject).toBe('WG Gefunden! test email');
    expect(mail.text).toContain('for anna');
    expect(mail.html).toContain('test email for anna');
    expect(composeTestMail().text).toBe(
      'This is a test email from wgg. If you can read this, email alerts will reach you.',
    );
    expect(composeTestMail({ username: '<script>' }).html).not.toContain('<script>');
  });
});

describe('#links back to the app (server.publicUrl)', () => {
  const APP = 'https://xn--lo-bja.com/wgg';

  it('a priority mail ends with an absolute link to the dashboard, in text and HTML', () => {
    const mail = composePriority(listing(), { now: NOW, appUrl: APP });
    expect(mail.text.trimEnd().endsWith(`Open WG Gefunden! \u2192 l\u00e9o.com/wgg (${APP}/)`)).toBe(true);
    expect(mail.html).toContain(`href="${APP}/"`);
  });

  it('so does a digest', () => {
    const mail = composeDigest([listing(), listing({ id: 2, providerId: '12' })], { now: NOW, appUrl: APP });
    expect(mail.text).toContain(`Open WG Gefunden! \u2192 l\u00e9o.com/wgg (${APP}/)`);
    expect(mail.html).toContain(`href="${APP}/"`);
  });

  it('shows the link as readable Unicode text while the href stays the punycode URL', () => {
    const site = 'https://wgg.xn--lo-bja.com';
    const mail = composePriority(listing(), { now: NOW, appUrl: site });
    expect(mail.html).toContain(`href="${site}/"`);
    expect(mail.html).toContain('>wgg.l\u00e9o.com</a>');
    expect(mail.html).not.toContain('>wgg.xn--lo-bja.com<');
  });

  it('puts the link in the header next to the brand and again in the footer, in HTML and text', () => {
    const site = 'https://wgg.xn--lo-bja.com';
    for (const mail of [
      composePriority(listing(), { now: NOW, appUrl: site }),
      composeDigest([listing()], { now: NOW, appUrl: site }),
    ]) {
      const links = mail.html.match(/>wgg\.l\u00e9o\.com<\/a>/g) ?? [];
      expect(links).toHaveLength(2);
      expect(mail.html.indexOf('WG Gefunden!')).toBeLessThan(mail.html.indexOf('>wgg.l\u00e9o.com</a>'));
      expect(mail.html).toContain('Open WG Gefunden!');
      expect(mail.text.split('\n')[0]).toBe('WG Gefunden! \u00b7 wgg.l\u00e9o.com');
      expect(mail.text.trimEnd().endsWith(`Open WG Gefunden! \u2192 wgg.l\u00e9o.com (${site}/)`)).toBe(true);
    }
  });

  it('keeps the header a plain brand without an app URL', () => {
    const mail = composePriority(listing(), { now: NOW });
    expect(mail.text.split('\n')[0]).not.toContain('\u00b7 wgg');
    expect(mail.html).not.toContain('<a href="https://wgg');
  });

  it('adds nothing without an app URL, and never emits a link that is not http(s)', () => {
    expect(composePriority(listing(), { now: NOW }).text).not.toContain('Open WG Gefunden!');
    expect(composePriority(listing(), { now: NOW }).html).not.toContain('Open WG Gefunden!');
    const bad = composePriority(listing(), { now: NOW, appUrl: 'javascript:alert(1)' });
    expect(bad.html).not.toContain('javascript:');
    expect(bad.text).not.toContain('javascript:');
  });

  it('lists the deductions ("Why not 10?") in plain text and HTML, escaped', () => {
    const m = composePriority(listing(), { now: NOW });
    expect(m.text).toContain('Why not 10?');
    expect(m.text).toContain('  \u22121 far from A&B');
    expect(m.html).toContain('Why not 10?');
    expect(m.html).toContain('\u22121 far from A&amp;B');
    expect(m.html).not.toContain('far from A&B');
  });

  it('says "Perfect match" for a 10 without deductions and shows nothing for old answers', () => {
    const perfect = listing();
    perfect.llm.result = { ...perfect.llm.result, fitScore: 10, deductions: [] };
    expect(composePriority(perfect, { now: NOW }).text).toContain('Perfect match');
    const old = listing();
    delete old.llm.result.deductions;
    const m = composePriority(old, { now: NOW });
    expect(m.text).not.toContain('Why not 10?');
    expect(m.html).not.toContain('Perfect match');
  });
});

describe('#target name in distances', () => {
  const NAME = 'Hauptbahnhof <München>';

  it('priority mail names the recipient target (plain and escaped HTML)', () => {
    const m = composePriority(listing(), { now: NOW, targetName: NAME });
    expect(m.text).toContain(`Distance: 1.2 km to ${NAME}`);
    expect(m.html).toContain('1.2 km to Hauptbahnhof &lt;München&gt;');
    expect(m.text).not.toContain('TUM');
  });

  it('digest names the recipient target (plain and HTML)', () => {
    const m = composeDigest([listing()], { now: NOW, targetName: 'Marienplatz' });
    expect(m.text).toContain('1.2 km to Marienplatz, available');
    expect(m.html).toContain('1.2 km to Marienplatz, available');
  });

  it('falls back to a plain distance without a target name', () => {
    expect(composePriority(listing(), { now: NOW }).text).toContain('Distance: 1.2 km\n');
    expect(composeDigest([listing()], { now: NOW }).text).toContain('1.2 km, available');
  });
});
