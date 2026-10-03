import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { parseDetailPage } from '../../lib/provider/wgGesuchtDetail.js';

const html = fs.readFileSync(new URL('../fixtures/wgGesucht_detail.html', import.meta.url), 'utf8');

describe('#parseDetailPage (offline fixture, real detail page)', () => {
  const d = parseDetailPage(html);

  it('reads the description tabs as sections with their real headings', () => {
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0].heading).toBe('Zimmer');
    expect(d.sections[0].text).toContain('Helles und ruhiges Wohnvergnügen');
    expect(d.sections[0].text).toContain('**WG-LEBEN**');
  });

  it('keeps line breaks as newlines and drops markup and scripts', () => {
    const text = d.sections[0].text;
    expect(text).toContain('Zimmer 3: ca. 9 qm - 760€ - frei ab 01.11.2026\n');
    expect(text).not.toMatch(/<|&nbsp;|function\s*\(/);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('builds the full description from all sections', () => {
    expect(d.description).toContain('Beispielplatz - Musterplatz');
    expect(d.description).toContain('If you study or work in town');
  });

  it('parses the cost panel as present, raw kept, "n.a." is not a number, the SCHUFA ad is not a cost', () => {
    expect(d.costs).toEqual([
      { label: 'Miete', raw: '819€', value: 819 },
      { label: 'Nebenkosten', raw: '0€', value: 0 },
      { label: 'Sonstige Kosten', raw: 'n.a.', value: null },
      { label: 'Kaution', raw: 'n.a.', value: null },
      { label: 'Ablösevereinbarung', raw: 'n.a.', value: null },
    ]);
  });

  it('parses the exact address with street and postcode/district split', () => {
    expect(d.address).toEqual({
      raw: 'Musterstraße 80999 München Beispielviertel',
      street: 'Musterstraße',
      postcodeCity: '80999 München Beispielviertel',
    });
  });

  it('parses availability and online-since', () => {
    expect(d.availableFrom).toBe('2028-07-01');
    expect(d.availableUntil).toBeNull();
    expect(d.availabilityRaw).toBe('01.07.2028');
    expect(d.onlineRaw).toBe('2 Tage');
    expect(d.onlineMinutes).toBe(2880);
  });

  it('parses the WG facts per group, label only where the page has one', () => {
    expect(d.wgFacts).toEqual([
      { group: 'Die WG', label: null, value: '9m² Zimmer in 3er WG' },
      { group: 'Die WG', label: 'Wohnungsgröße', value: '84m²' },
      { group: 'Die WG', label: null, value: '3er WG' },
      { group: 'Die WG', label: null, value: 'keine Zweck-WG' },
      { group: 'Gesucht wird', label: null, value: 'Geschlecht egal' },
    ]);
  });

  it('parses the object facts', () => {
    expect(d.objectFacts).toEqual([{ label: 'möbliert', value: null }]);
  });

  it('returns empty structures for a page without any of the panels', () => {
    const empty = parseDetailPage('<html><body><p>nothing</p></body></html>');
    expect(empty).toMatchObject({
      sections: [],
      description: '',
      costs: [],
      address: null,
      availableFrom: null,
      wgFacts: [],
      objectFacts: [],
    });
  });

  it('handles several tabs and a free text without tabs', () => {
    const tabs = `<div class="section_panel_tabs">
      <div class="section_panel_tab active" data-text="#freitext_0"><h2 class="headline section_panel_title">Zimmer</h2></div>
      <div class="section_panel_tab" data-text="#freitext_1"><h2 class="headline section_panel_title">Lage</h2></div></div>
      <div id="freitext_0"><p>Erster<br>Text</p></div><div id="freitext_1"><p>Zweiter Text</p></div>`;
    const r = parseDetailPage(`<body>${tabs}</body>`);
    expect(r.sections).toEqual([
      { heading: 'Zimmer', text: 'Erster\nText' },
      { heading: 'Lage', text: 'Zweiter Text' },
    ]);
    expect(r.description).toBe('Zimmer\nErster\nText\n\nLage\nZweiter Text');
    const bare = parseDetailPage('<body><div id="freitext_0">Nur Text</div></body>');
    expect(bare.sections).toEqual([{ heading: null, text: 'Nur Text' }]);
    expect(bare.description).toBe('Nur Text');
  });
});

describe('#parseDetailPage flatmates', () => {
  it('reads the flatmates from the title attribute of the page header', () => {
    expect(parseDetailPage(html).flatmates).toMatchObject({
      wgSize: 3,
      female: 0,
      male: 0,
      raw: '3er WG (0w,0m,0d,0n)',
    });
  });

  it('is null when the page has none', () => {
    expect(parseDetailPage('<html><body><p>nothing</p></body></html>').flatmates).toBeNull();
  });
});
