import { DEFAULT_CONCEPTS } from './concepts.js';
import { extractCodeTokens, resolveCode } from './codes.js';
import { deriveFacets } from './facets.js';
import { rowToItem } from './item.js';
import { buildParserContext, parseQuery } from './query-parser.js';
import { searchCatalog } from './search.js';
import { editDistance, stem, tokenize } from './text.js';
import type { CatalogItem } from './catalog.types.js';

// A small slice of the real catalog (names, finishes and features copied from the Sage list).
const ROWS = [
  { code: '42300', name: 'Architectural Lever 316SSS 52mm', category: 'Door Handles - Austyle', category_path: ['Door Handles - Austyle', '316SS Lever Handle Passage & Privacy 52mm'], finish: 'Satin Stainless Steel', material: '316 Stainless Steel', brand: 'Austyle', status: 'Stock Item', family_key: '2300', features: ['All In One Passage/Privacy Lever Set', 'Fire Rated 4 Hours / DDA Compliant'] },
  { code: '12309', name: 'Architectural Lever 316SS PVD PB 52mm', category: 'Door Handles - Austyle', category_path: ['Door Handles - Austyle', '316SS Lever Handle Passage & Privacy 52mm'], finish: 'PVD Anti-Tarnish Brass', material: '316 Stainless Steel', brand: 'Austyle', status: 'Stock Item', family_key: '2309', features: ['316 Maring Grade SS'] },
  { code: '42309', name: 'Architectural Lever 316SS SSS 52mm', category: 'Door Handles - Austyle', category_path: ['Door Handles - Austyle', '316SS Lever Handle Passage & Privacy 52mm'], finish: 'Satin Stainless Steel', material: '316 Stainless Steel', brand: 'Austyle', status: 'Stock Item', family_key: '2309', features: ['316 Maring Grade SS'] },
  { code: '43660', name: 'Lever Passage Set 304SS 52mm', category: 'Door Handles - Austyle', category_path: ['Door Handles - Austyle'], finish: 'Satin Stainless Steel', material: '304 Stainless Steel', brand: 'Austyle', status: 'Stock Item', family_key: '3660', features: [] },
  { code: '13094', name: 'Lever Latch Passage Set PVD PB 150x42mm', category: 'Door Handles - Superior', category_path: ['Door Handles - Superior'], finish: 'PVD Anti-Tarnish Brass', material: 'Solid Brass', brand: 'Superior Brass', status: 'Stock Item', family_key: '3094', features: ['Passage Lever Set'] },
  { code: '53073', name: 'Knob Latch Passage Set Black 150x42mm', category: 'Door Handles - Superior', category_path: ['Door Handles - Superior'], finish: 'Matt Black', material: 'Solid Brass', brand: 'Superior Brass', status: 'Stock Item', family_key: '3073', features: [] },
  { code: '45108', name: 'Butt Hinge Fixed Pin inc screws (pair) SSS 100x75x2.5mm', category: 'Hinges', category_path: ['Hinges', 'Hinges Fixed Pin'], finish: 'Satin Stainless Steel', material: '304 Stainless Steel', brand: 'Austyle', status: 'Stock Item', family_key: '5108', features: ['4 Hour Australian Fire Rating'] },
  { code: '3045', name: 'Knocker Classic PB', category: 'Door Knockers', category_path: ['Door Knockers'], finish: 'Polished Brass', material: 'Solid Brass', brand: 'Superior Brass', status: 'Stock Item', family_key: '3045', features: [] },
  { code: '9999', name: 'Lever Old Model PB', category: 'Door Handles - Superior', category_path: ['Door Handles - Superior'], finish: 'Polished Brass', material: 'Solid Brass', brand: 'Superior Brass', status: 'Deleted', family_key: '9999', features: [] },
  { code: '49217', name: '304SS myLOCK Integrated Roller/Privacy/Dead Lock SSS 60mm', category: 'Security Locks Latches Cylinders', category_path: ['Security Locks Latches Cylinders'], finish: 'Satin Stainless Steel', material: '304 Stainless Steel', brand: 'Austyle', status: 'Stock Item', family_key: '9217', features: [] },
];

const items: CatalogItem[] = ROWS.map(rowToItem);
const vocab = new Map<string, number>();
items.forEach((i) => i.tokens.forEach((t) => vocab.set(t, (vocab.get(t) ?? 0) + 1)));
const ctx = buildParserContext(DEFAULT_CONCEPTS, vocab);
const find = (q: string, limit = 6) => searchCatalog(items, parseQuery(q, ctx), { limit });
const codesOf = (r: ReturnType<typeof find>) => r.cards.map((c) => c.code);

describe('text helpers', () => {
  it('stems plurals the way customers write them', () => {
    expect(['levers', 'hinges', 'latches', 'sets', 'glass', 'brass', 'stainless'].map(stem)).toEqual(['lever', 'hinge', 'latch', 'set', 'glass', 'brass', 'stainless']);
  });
  it('splits 316SS but keeps sizes together', () => {
    expect(tokenize('316SS lever 52mm')).toEqual(['316', 'ss', 'lever', '52mm']);
  });
  it('measures small typos', () => {
    expect(editDistance('stainles', 'stainless', 2)).toBe(1);
    expect(editDistance('lever', 'hinge', 1)).toBeGreaterThan(1);
  });
});

describe('facets from catalog rows', () => {
  it('reads type, material and finish', () => {
    const f = deriveFacets({ name: 'Architectural Lever 316SSS 52mm', category: 'Door Handles - Austyle', finish: 'Satin Stainless Steel', material: '316 Stainless Steel', features: ['Fire Rated 4 Hours / DDA Compliant'], brand: 'Austyle' });
    expect(f).toMatchObject({ type: 'lever', material: '316', finish: 'stainless', brand: 'Austyle' });
    expect(f.tags).toEqual(expect.arrayContaining(['fire-rated', 'dda']));
  });
  it('survives typos in the Sage data', () => {
    expect(deriveFacets({ name: 'x Hinge', category: 'Hinges', finish: 'Polished Stainles Steel', material: 'Stanless Steel', features: [], brand: null })).toMatchObject({ finish: 'stainless', material: 'stainless' });
  });
  it('picks up the "maring grade" feature as marine', () => {
    const f = deriveFacets({ name: 'Lever', category: 'Door Handles - Austyle', finish: 'Satin Chrome', material: 'Stainless Steel', features: ['316 Maring Grade SS'], brand: null });
    expect(f.tags).toContain('marine');
    expect(f.material).toBe('316');
  });
  it('treats a dead bolt lock as a lock and a barrel bolt as a bolt', () => {
    expect(deriveFacets({ name: 'Square Dead Bolt Entrance Lock', category: 'Security Locks Latches Cylinders', finish: null, material: null, features: [], brand: null }).type).toBe('lock');
    expect(deriveFacets({ name: 'Barrel Bolt 100mm', category: 'Door Bolts', finish: null, material: null, features: [], brand: null }).type).toBe('bolt');
  });
});

describe('searching', () => {
  it('"marine grade stainless steel lever sets" finds only 316 levers (the case Daniel tried)', () => {
    const r = find("I'm looking for marine grade stainless steel lever sets");
    expect(r.exact).toBe(true);
    expect(r.exactCount).toBe(2); // 42300 and the 2309 family (12309 + 42309 are one product in two finishes)
    const exact = r.cards.filter((c) => c.note !== 'Close match').map((c) => c.code);
    expect(exact.sort()).toEqual(['12309', '42300'].sort());
    // few exact matches, so the rest are topped up and labelled
    expect(r.cards.slice(2).every((c) => c.note === 'Close match')).toBe(true);
    expect(r.interpretation.join(' ')).toMatch(/316/);
  });
  it('knows other words for the same thing', () => {
    for (const q of ['coastal lever handles', 'lever sets for a beach house', 'salt water resistant levers', 'rust proof lever handles']) {
      expect(codesOf(find(q))[0], q).toMatch(/^(42300|12309|42309)$/);
    }
  });
  it('forgives typos', () => {
    expect(codesOf(find('stainles steel levers'))).toEqual(expect.arrayContaining(['42300']));
  });
  it('groups finishes of one product into variants', () => {
    const card = find('316 lever').cards.find((c) => ['12309', '42309'].includes(c.code))!;
    expect(card.variants?.length).toBe(1);
  });
  it('never returns a deleted product', () => {
    expect(codesOf(find('lever old model brass'))).not.toContain('9999');
  });
  it('tops up with close matches instead of a lone result', () => {
    const r = find('black lever');
    expect(r.cards.length).toBeGreaterThan(1);
  });
  it('is not empty for a vague but real request', () => {
    expect(find('something nice for a front door').cards.length + find('door knocker').cards.length).toBeGreaterThan(0);
  });
  it('returns nothing when there is nothing to search for', () => {
    expect(find('hello there').cards).toHaveLength(0);
  });
});

describe('product codes', () => {
  const index = { byCode: new Map(items.map((i) => [i.code, i])), byFamily: new Map([['2300', [items[0]]], ['9217', [items[9]]]]) };
  it('finds codes in a sentence', () => {
    expect(extractCodeTokens('is 45108 in stock and x2300 drawing, 42330e?')).toEqual(['45108', 'x2300', '42330E']);
  });
  it('resolves exact codes, base codes and x-codes', () => {
    expect(resolveCode('42300', index).kind).toBe('exact');
    expect(resolveCode('x2300', index)).toMatchObject({ kind: 'family', familyKey: '2300' });
    expect(resolveCode('2300', index).kind).toBe('family');
  });
  it('does not guess a family for an unknown five-digit code', () => {
    expect(resolveCode('99217', index).kind).toBe('unknown');
  });
});
