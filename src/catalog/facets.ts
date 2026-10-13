import type { Facets } from './catalog.types.js';

export interface FacetInput {
  name: string;
  category: string | null;
  finish: string | null;
  material: string | null;
  features: string[];
  brand: string | null;
}

export function deriveType(nameRaw: string, categoryRaw: string | null): string | null {
  const n = nameRaw.toLowerCase();
  const c = (categoryRaw ?? '').toLowerCase();

  if (/digital smart/.test(c) || /\bdigital\b/.test(n)) return 'digital-lock';
  if (/hinge/.test(c) || /\bhinge/.test(n)) return 'hinge';
  if (/escutcheon/.test(c) || /escutcheon/.test(n)) return 'escutcheon';
  if (/\bsnib\b/.test(n)) return 'snib';
  if (/dead ?bolt|deadlock/.test(n)) return 'lock';
  if (/\bbolt/.test(n) || /door bolts/.test(c)) return 'bolt';
  if (/cylinder|\bcyl\b|thumb ?turn/.test(n)) return 'cylinder';
  if (/flush pull/.test(n) || /flush pulls/.test(c)) return 'flush-pull';
  if (/door stops/.test(c) || /door ?stop|stopper/.test(n)) return 'door-stop';
  if (/knocker/.test(n) || /knockers/.test(c)) return 'knocker';
  if (/\bhook/.test(n) || /hooks/.test(c)) return 'hook';
  if (/castor|caster/.test(n) || /castors/.test(c)) return 'castor';
  if (/letter & mail|letter box|mail ?box|letter slot|letter plate/.test(`${c} ${n}`)) return 'letter-box';
  if (/numerals/.test(c)) return 'numeral';
  if (/alphabet/.test(c)) return 'letter';
  if (/window fittings/.test(c)) return 'window-fitting';
  if (/push plates/.test(c) || /push plate|finger plate|kick plate/.test(n)) return 'push-plate';
  if (/shelves|bracket/.test(c)) return 'bracket';
  if (/curtain/.test(c)) return 'curtain';
  if (/gate/.test(c)) return 'gate';
  if (/bell/.test(c) || /\bbell\b/.test(n)) return 'bell';
  if (/\bsigns?\b/.test(c)) return 'sign';
  if (/spare parts/.test(c)) return 'spare-part';
  if (/cupboard pull|cupboard|drawer|cabinet/.test(c)) return 'cabinet-handle';
  if (/entry pull/.test(c)) return 'entry-handle';
  if (/\blever/.test(n)) return 'lever';
  if (/\bknob/.test(n)) return 'knob';
  if (/\blatch/.test(n)) return 'latch';
  if (/\block\b|deadbolt|dead ?lock/.test(n) || /security locks/.test(c)) return 'lock';
  if (/door handles/.test(c)) return 'handle';
  if (/pull|handle/.test(n)) return 'entry-handle';
  return null;
}

export function deriveMaterial(
  materialRaw: string | null,
  nameRaw: string,
  featuresText: string,
): string | null {
  const m = (materialRaw ?? '').toLowerCase();
  let g: string | null = null;
  if (/316/.test(m)) g = '316';
  else if (/304/.test(m)) g = '304';
  else if (/stain|stanl|\bss\b/.test(m)) g = 'stainless';
  else if (/brass/.test(m)) g = 'brass';
  else if (/zinc/.test(m)) g = 'zinc';
  else if (/iron/.test(m)) g = 'iron';
  else if (/alumin/.test(m)) g = 'aluminium';
  else if (/porcelain/.test(m)) g = 'porcelain';
  else if (/timber|wood/.test(m)) g = 'timber';
  else if (/glass/.test(m)) g = 'glass';
  else if (/electronic/.test(m)) g = 'electronic';
  else if (/acrylic/.test(m)) g = 'acrylic';
  else if (/steel/.test(m)) g = 'steel';

  const n = nameRaw.toLowerCase();
  if (!g) {
    if (/\b316/.test(n)) g = '316';
    else if (/\b304/.test(n)) g = '304';
  }
  // a 316 note in the features upgrades a generic stainless/steel/unknown material
  if ((!g || g === 'stainless' || g === 'steel') && /316/.test(featuresText)) g = '316';
  return g;
}

export function deriveFinish(finishRaw: string | null): { group: string | null; detail: string[] } {
  const f = (finishRaw ?? '').toLowerCase();
  if (!f) return { group: null, detail: [] };
  const detail = ['satin', 'polished', 'matt', 'pvd', 'antique', 'gloss'].filter((d) => new RegExp(`\\b${d}`).test(f.replace('matte', 'matt')));
  let group: string | null = null;
  if (/chrome/.test(f)) group = 'chrome';
  else if (/stain|stanl|\bsss\b|\bpss\b|p\/\s*s\/\s*s|^ss$|316 sss/.test(f)) group = 'stainless';
  else if (/pewter/.test(f)) group = 'pewter';
  else if (/graphite|gun ?metal/.test(f)) group = 'graphite';
  else if (/black/.test(f) && !/brass/.test(f)) group = 'black';
  else if (/white|ivory/.test(f)) group = 'white';
  else if (/copper/.test(f)) group = 'copper';
  else if (/bronze/.test(f)) group = 'bronze';
  else if (/brass/.test(f)) group = 'brass';
  else if (/silver/.test(f)) group = 'silver';
  else if (/timber|oak|wood/.test(f)) group = 'timber';
  return { group, detail };
}

export function deriveFunctions(nameRaw: string, featuresText: string): string[] {
  const t = `${nameRaw} ${featuresText}`.toLowerCase();
  const out: string[] = [];
  if (/passage/.test(t)) out.push('passage');
  if (/privacy|bathroom/.test(t)) out.push('privacy');
  if (/entrance|euro lock|entrance lock/.test(t)) out.push('entrance');
  if (/dummy/.test(t)) out.push('dummy');
  if (/sliding/.test(t)) out.push('sliding');
  if (/pivot/.test(t)) out.push('pivot');
  return out;
}

export function deriveTags(nameRaw: string, featuresText: string, finishDetail: string[]): string[] {
  const n = nameRaw.toLowerCase();
  const t = `${n} ${featuresText}`.toLowerCase();
  const out: string[] = [];
  if (/fire rat|fire test/.test(t)) out.push('fire-rated');
  if (/\bdda\b/.test(t)) out.push('dda');
  if (/\blh\b|left hand/.test(n)) out.push('left-hand');
  if (/\brh\b|right hand/.test(n)) out.push('right-hand');
  if (/keyed alike|key alike/.test(t)) out.push('keyed-alike');
  if (/mylock/.test(t)) out.push('mylock');
  if (/concealed fix/.test(t)) out.push('concealed-fix');
  if (/marin[eg]/.test(t)) out.push('marine');
  if (finishDetail.includes('pvd')) out.push('pvd');
  return out;
}

export function deriveBrand(brand: string | null, category: string | null): string | null {
  const b = (brand ?? '').toLowerCase();
  if (b === 'austyle') return 'Austyle';
  if (b === 'superior brass') return 'Superior Brass';
  if (b === 'builders choice') return 'Builders Choice';
  const c = (category ?? '').toLowerCase();
  if (c.includes('austyle')) return 'Austyle';
  if (c.includes('superior')) return 'Superior Brass';
  if (c.includes('builders choice')) return 'Builders Choice';
  return null;
}

export function deriveFacets(r: FacetInput): Facets {
  const featuresText = r.features.join(' ');
  const finish = deriveFinish(r.finish);
  return {
    type: deriveType(r.name, r.category),
    material: deriveMaterial(r.material, r.name, featuresText),
    finish: finish.group,
    finishDetail: finish.detail,
    functions: deriveFunctions(r.name, featuresText),
    tags: deriveTags(r.name, featuresText, finish.detail),
    brand: deriveBrand(r.brand, r.category),
  };
}
