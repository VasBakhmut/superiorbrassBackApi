import type { CatalogItem } from './catalog.types.js';

/** "42330E" -> "2330E": the digit in front of a 4-digit base is the finish digit, letters are the variant */
export function familyKeyOf(code: string): string | null {
  const m = code.toUpperCase().match(/^(\d{4,5})([A-Z]{0,3})$/);
  return m ? (m[1].length === 5 ? m[1].slice(1) : m[1]) + m[2] : null;
}

/** product-code-shaped words in free text: "49217", "x2300", "42330e" */
export function extractCodeTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.#])(x?\d{4,6}[A-Za-z]{0,3})(?![\w.])/gi)) {
    const t = m[1];
    out.add(/^x/i.test(t) ? 'x' + t.slice(1).toUpperCase() : t.toUpperCase());
  }
  return [...out];
}

export interface ResolvedCode {
  token: string;
  /** exact: a catalog item has this code; family: only variants of it exist; unknown: nothing */
  kind: 'exact' | 'family' | 'unknown';
  /** the item itself (exact) or all members of the family */
  items: CatalogItem[];
  /** key used to look up drawings/instructions, e.g. "2300" */
  familyKey: string | null;
}

export interface CodeIndex {
  byCode: Map<string, CatalogItem>;
  byFamily: Map<string, CatalogItem[]>;
}

export function resolveCode(token: string, index: CodeIndex): ResolvedCode {
  const upper = token.toUpperCase();
  const isX = upper.startsWith('X');
  const bare = isX ? upper.slice(1) : upper;
  const familyKey = familyKeyOf(bare);

  const exact = !isX ? index.byCode.get(upper) : undefined;
  if (exact) return { token: upper, kind: 'exact', items: [exact], familyKey: exact.familyKey ?? familyKey };

  // A family is a guess about a *base* code ("2300", "x2300"). A five-digit code that isn't an item
  // ("99999") is just a code we don't have: guessing its family would show unrelated products.
  const isBase = isX || /^\d{4}[A-Z]{0,3}$/.test(bare);
  const members = familyKey && isBase ? (index.byFamily.get(familyKey) ?? []) : [];
  if (members.length) return { token: upper, kind: 'family', items: members, familyKey };
  return { token: upper, kind: 'unknown', items: [], familyKey };
}

export function resolveCodes(tokens: string[], index: CodeIndex): ResolvedCode[] {
  return tokens.map((t) => resolveCode(t, index));
}

/** keys (as stored in product_drawings.family_keys) for every code the customer mentioned */
export function familyKeysOf(resolved: ResolvedCode[]): string[] {
  const keys = new Set<string>();
  for (const r of resolved) {
    if (r.familyKey) keys.add(r.familyKey);
    r.items.forEach((i) => i.familyKey && keys.add(i.familyKey));
  }
  return [...keys];
}
