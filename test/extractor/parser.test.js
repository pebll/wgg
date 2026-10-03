import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cheerio from 'cheerio';

vi.mock('../../lib/services/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { parse, extractField } = await import('../../lib/services/extractor/parser/parser.js');
const logger = (await import('../../lib/services/logger.js')).default;

const HTML = `
<ul>
  <li class="card" data-id="11"><a class="t" href="/a">  Alpha
     title </a><span class="n">12</span><span class="n">3</span><i class="e"></i></li>
  <li class="card" data-id="22"><a class="t" href="/b">Beta</a><span class="n">7x</span></li>
  <li class="card"><a class="t" href="/ad">Advert</a></li>
</ul>`;
const FIELDS = { id: '@data-id', title: 'a.t | trim', link: 'a.t@href', num: '.n | int', empty: '.e' };

beforeEach(() => vi.clearAllMocks());

describe('parse', () => {
  it('returns one object per card with an id, in order', () => {
    const rows = parse('.card', FIELDS, HTML, 'u');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: '11', title: 'Alpha title', link: '/a', num: 123, empty: null });
    expect(rows[1].id).toBe('22');
  });

  it('returns null for missing text, container, fields or matches', () => {
    expect(parse('.card', FIELDS, '', 'u')).toBeNull();
    expect(parse('.card', FIELDS, null, 'u')).toBeNull();
    expect(parse('', FIELDS, HTML, 'u')).toBeNull();
    expect(parse('.card', null, HTML, 'u')).toBeNull();
    expect(parse('.nothing', FIELDS, HTML, 'u')).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('returns an empty array when no card has an id', () => {
    expect(parse('.card', { id: '@data-missing' }, HTML, 'u')).toEqual([]);
  });

  it('keeps the card when one field fails and reports it', () => {
    const rows = parse('.card', { id: '@data-id', bad: '[[[' }, HTML, 'u');
    expect(rows).toHaveLength(2);
    expect(rows[0].bad).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('extractField', () => {
  const $ = cheerio.load(HTML);
  const first = $('.card').first();

  it('reads text of all matches, attributes of the first match, and the card attribute', () => {
    expect(extractField(first, '.n')).toBe('123');
    expect(extractField(first, 'a.t@href')).toBe('/a');
    expect(extractField(first, '@data-id')).toBe('11');
  });

  it('applies modifiers left to right', () => {
    const doc = cheerio.load('<p class="x">\n a\n\n b  </p>');
    const scope = doc.root();
    expect(extractField(scope, '.x | removeNewline')).toBe('  a   b  ');
    expect(extractField(scope, '.x | trim')).toBe('a b');
    expect(extractField(scope, '.x | trim | removeNewline')).toBe('a b');
    expect(extractField(first, '.n | int')).toBe(123);
  });

  it('warns about unknown modifiers and keeps the value', () => {
    expect(extractField(first, '.n | shout')).toBe('123');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('turns empty, missing, zero and NaN into null', () => {
    expect(extractField(first, '.none')).toBeNull();
    expect(extractField(first, 'a@data-nothing')).toBeNull();
    expect(extractField($('.card').eq(1), '.n | int')).toBe(7);
    expect(extractField(cheerio.load('<b class="z">0</b>').root(), '.z | int')).toBeNull();
    expect(extractField(first, '')).toBeNull();
    expect(extractField(first, null)).toBeNull();
  });
});
