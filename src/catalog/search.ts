import type { CatalogItem, Constraint, ParsedQuery, ProductCard, SearchResult } from './catalog.types.js';
import { MATERIAL_EXPANSION, TYPE_EXPANSION } from './concepts.js';

export const SITE = 'https://www.superiorbrass.com.au';

/** the site's URL slug rule: spaces -> "-", "&" -> "_and_", "/" -> "_or_", "-" -> "_dash_" */
export function siteSlug(name: string): string {
  return name
    .replace(/&/g, '_and_')
    .replace(/\//g, '_or_')
    .replace(/["*]/g, '_')
    .replace(/-/g, '_dash_')
    .replace(/\s/g, '-');
}

export function categoryUrl(path: string[]): string | null {
  if (!path.length) return null;
  return `${SITE}/${path.map((p) => encodeURIComponent(siteSlug(p))).join('/')}/pl.php`;
}

const HIDDEN_STATUSES = new Set(['Deleted', 'Admin', 'Customer Order']);
export const isRecommendable = (status: string | null) => !status || !HIDDEN_STATUSES.has(status);

const STATUS_ADJUST: Record<string, number> = {
  'Stock Item': 1,
  'Near Discontinued': -0.5,
  'To Be Discontinued': -1,
  'Spare Part': -3,
  'Kitting Item': -2,
  Display: -2,
};

export function toCard(item: CatalogItem, variants?: CatalogItem[]): ProductCard {
  return {
    code: item.code,
    name: item.name,
    brand: item.brand,
    finish: item.finish,
    material: item.material,
    size: item.size,
    url: item.productUrl,
    imageUrl: item.imageUrl,
    ...(variants && variants.length
      ? { variants: variants.map((v) => ({ code: v.code, finish: v.finish, url: v.productUrl })) }
      : {}),
  };
}

interface Expanded {
  types: Set<string> | null;
  materials: Set<string> | null;
  finishes: Set<string> | null;
  functions: Set<string> | null;
  brands: Set<string> | null;
  tags: string[];
  softMaterials: Set<string>;
  softFinishes: Set<string>;
  softTags: string[];
  details: string[];
  marine: boolean;
}

function expand(constraints: Constraint[]): Expanded {
  const hard = constraints.filter((c) => !c.soft);
  const soft = constraints.filter((c) => c.soft);
  const union = (facet: string, pool: Constraint[], map?: Record<string, string[]>) => {
    const vals = pool.filter((c) => c.facet === facet).flatMap((c) => c.values.flatMap((v) => map?.[v] ?? [v]));
    return vals.length ? new Set(vals) : null;
  };

  // several hard material constraints must all hold (316 AND stainless); if they contradict, accept any
  const materialSets = hard.filter((c) => c.facet === 'material').map((c) => new Set(c.values.flatMap((v) => MATERIAL_EXPANSION[v] ?? [v])));
  let materials: Set<string> | null = null;
  if (materialSets.length) {
    materials = materialSets.reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
    if (!materials.size) materials = new Set(materialSets.flatMap((s) => [...s]));
  }

  return {
    types: union('type', hard, TYPE_EXPANSION),
    materials,
    finishes: union('finish', hard),
    functions: union('function', hard),
    brands: union('brand', hard),
    tags: hard.filter((c) => c.facet === 'tag').flatMap((c) => c.values),
    softMaterials: union('material', soft, MATERIAL_EXPANSION) ?? new Set(),
    softFinishes: union('finish', soft) ?? new Set(),
    softTags: soft.filter((c) => c.facet === 'tag').flatMap((c) => c.values),
    details: constraints.filter((c) => c.facet === 'finishDetail').flatMap((c) => c.values),
    marine: constraints.some((c) => c.facet === 'material' && c.values[0] === '316' && /marine|maring|coast|salt|sea|pool|beach|ocean|rust|corros/.test(c.term)),
  };
}

interface Scored {
  item: CatalogItem;
  score: number;
  exact: boolean;
}

function scoreItem(item: CatalogItem, parsed: ParsedQuery, e: Expanded, hasHard: boolean): Scored {
  const f = item.facets;
  let score = 0;
  let exact = true;

  if (e.types) {
    const generic = e.types.size > 1;
    if (f.type && e.types.has(f.type)) score += generic ? 4 : 6;
    else exact = false;
  }
  if (e.materials) {
    if (f.material && e.materials.has(f.material)) score += 5;
    else exact = false;
  }
  if (e.finishes) {
    if (f.finish && e.finishes.has(f.finish)) score += 5;
    else exact = false;
  }
  if (e.functions) {
    if (f.functions.some((x) => e.functions!.has(x))) score += 3;
    else exact = false;
  }
  if (e.brands) {
    if (f.brand && e.brands.has(f.brand)) score += 4;
    else exact = false;
  }
  for (const tag of e.tags) {
    if (f.tags.includes(tag)) score += 3;
    else exact = false;
  }

  if (f.material && e.softMaterials.has(f.material)) score += 1.5;
  if (f.finish && e.softFinishes.has(f.finish)) score += 1.5;
  for (const tag of e.softTags) if (f.tags.includes(tag)) score += e.marine && tag === 'marine' ? 3 : 1;
  for (const d of e.details) if (f.finishDetail.includes(d)) score += 1;

  let freeHits = 0;
  for (const t of parsed.freeTokens) {
    if (item.nameTokens.has(t)) { score += 2; freeHits++; }
    else if (item.tokens.has(t)) { score += 1.5; freeHits++; }
  }
  if (!hasHard && parsed.freeTokens.length) exact = freeHits === parsed.freeTokens.length;
  if (parsed.freeTokens.length && freeHits === parsed.freeTokens.length) score += 1;

  if (score > 0) score += STATUS_ADJUST[item.status ?? ''] ?? 0;
  return { item, score, exact };
}

export interface SearchOptions {
  limit?: number;
  variantLimit?: number;
}

export function searchCatalog(items: CatalogItem[], parsed: ParsedQuery, opts: SearchOptions = {}): SearchResult {
  const limit = opts.limit ?? 6;
  const variantLimit = opts.variantLimit ?? 6;
  const e = expand(parsed.constraints);
  const hasHard = !!(e.types || e.materials || e.finishes || e.functions || e.brands || e.tags.length);
  const base = { interpretation: parsed.interpretation, unknownTokens: parsed.unknownTokens };

  if (!hasHard && !parsed.freeTokens.length && !e.softMaterials.size && !e.softFinishes.size && !e.softTags.length) {
    return { cards: [], totalFamilies: 0, exact: false, exactCount: 0, topCodes: [], ...base };
  }

  const byScore = (a: Scored, b: Scored) => b.score - a.score || a.item.code.localeCompare(b.item.code, undefined, { numeric: true });
  const scored = items
    .filter((i) => isRecommendable(i.status))
    .map((i) => scoreItem(i, parsed, e, hasHard))
    .filter((s) => s.score > 0);

  const groupByFamily = (list: Scored[]) => {
    const families = new Map<string, Scored[]>();
    for (const s of list.sort(byScore)) {
      const key = s.item.familyKey ?? s.item.code;
      (families.get(key) ?? families.set(key, []).get(key)!).push(s);
    }
    return [...families.values()];
  };

  const exactFamilies = groupByFamily(scored.filter((s) => s.exact));
  const exactKeys = new Set(exactFamilies.map((m) => m[0].item.familyKey ?? m[0].item.code));
  // plenty of exact matches: show only those. Few: top them up with the closest partial ones, so the
  // customer is never left with one lonely result or nothing at all.
  const partialFamilies = exactFamilies.length >= 3 ? [] : groupByFamily(scored.filter((s) => !s.exact)).filter((m) => !exactKeys.has(m[0].item.familyKey ?? m[0].item.code));
  const ordered = [...exactFamilies, ...partialFamilies];
  const shown = ordered.slice(0, limit);

  const cards = shown.map((members) => {
    const [best, ...rest] = members;
    const variants = rest
      .map((m) => m.item)
      .sort((a, b) => (a.finish ?? '').localeCompare(b.finish ?? ''))
      .slice(0, variantLimit);
    const card = toCard(best.item, variants);
    return best.exact || !exactFamilies.length ? card : { ...card, note: 'Close match' };
  });

  // "see all" link: the category most of the shown products live in
  let moreUrl: string | undefined;
  let moreLabel: string | undefined;
  const first = shown.map((m) => m[0].item.categoryPath).filter((p) => p.length);
  if (first.length) {
    const top = mode(first.map((p) => p[0]));
    const inTop = first.filter((p) => p[0] === top);
    const second = inTop[0]?.[1] && mode(inTop.map((p) => p[1] ?? '')) === inTop[0][1] && inTop.filter((p) => p[1] === inTop[0][1]).length / inTop.length >= 0.6;
    const path = second ? [top, inTop[0][1]] : [top];
    moreUrl = categoryUrl(path) ?? undefined;
    moreLabel = path.join(' › ');
  }

  return {
    cards,
    totalFamilies: ordered.length,
    exact: exactFamilies.length > 0,
    exactCount: exactFamilies.length,
    topCodes: shown.flatMap((m) => m.slice(0, 1).map((x) => x.item.code)),
    moreUrl,
    moreLabel,
    ...base,
  };
}

function mode(values: string[]): string {
  const counts = new Map<string, number>();
  values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
