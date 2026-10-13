import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';
import type { CatalogItem, ParsedQuery, SearchResult } from './catalog.types.js';
import { type CodeIndex, type ResolvedCode, extractCodeTokens, resolveCode, resolveCodes } from './codes.js';
import { type Concept, DEFAULT_CONCEPTS } from './concepts.js';
import { rowToItem } from './item.js';
import { type ParserContext, buildParserContext, parseQuery } from './query-parser.js';
import { type SearchOptions, searchCatalog } from './search.js';

const COLUMNS =
  'code, name, category, category_path, brand, finish, material, size, status, features, related_text, related_codes, alternative_codes, replaced_by_codes, family_key, product_url, site_image_url, url';
const TTL_MS = 10 * 60 * 1000;

/**
 * In-memory copy of the product catalog (a few MB). Searching it directly lets us rank results
 * properly, forgive typos and group variants, none of which a LIMIT-5 SQL query can do.
 * Refreshed every few minutes; the database stays the source of truth.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private items: CatalogItem[] = [];
  private index: CodeIndex = { byCode: new Map(), byFamily: new Map() };
  private reverseRelated = new Map<string, CatalogItem[]>();
  private parser: ParserContext = buildParserContext(DEFAULT_CONCEPTS, new Map());
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  async ready(): Promise<void> {
    if (this.items.length && Date.now() - this.loadedAt < TTL_MS) return;
    this.loading ??= this.load().finally(() => (this.loading = null));
    try {
      await this.loading;
    } catch (err) {
      if (!this.items.length) throw err;
      this.logger.warn(`catalog refresh failed, serving the previous copy: ${(err as Error).message}`);
    }
  }

  private async load(): Promise<void> {
    const rows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await this.supabase.client.from('products').select(COLUMNS).range(from, from + 999);
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }

    let concepts: Concept[] = DEFAULT_CONCEPTS;
    const { data: syn } = await this.supabase.client.from('search_synonyms').select('term, facet, value').eq('active', true);
    if (syn?.length) concepts = [...DEFAULT_CONCEPTS, ...syn.map((s) => ({ terms: [s.term], facet: s.facet, value: s.value }) as Concept)];

    const items = rows.map(rowToItem);
    const byCode = new Map<string, CatalogItem>();
    const byFamily = new Map<string, CatalogItem[]>();
    const vocab = new Map<string, number>();
    for (const it of items) {
      byCode.set(it.code.toUpperCase(), it);
      if (it.familyKey) (byFamily.get(it.familyKey) ?? byFamily.set(it.familyKey, []).get(it.familyKey)!).push(it);
      for (const t of it.tokens) vocab.set(t, (vocab.get(t) ?? 0) + 1);
    }
    const reverse = new Map<string, CatalogItem[]>();
    for (const it of items) {
      for (const code of it.relatedCodes) {
        const target = byCode.get(code.toUpperCase());
        if (target && target !== it) (reverse.get(target.code) ?? reverse.set(target.code, []).get(target.code)!).push(it);
      }
    }

    this.items = items;
    this.index = { byCode, byFamily };
    this.reverseRelated = reverse;
    this.parser = buildParserContext(concepts, vocab);
    this.loadedAt = Date.now();
    this.logger.log(`catalog loaded: ${items.length} items, ${byFamily.size} families, ${concepts.length} concepts`);
  }

  // --- lookups -----------------------------------------------------------------------------

  async parse(text: string): Promise<ParsedQuery> {
    await this.ready();
    return parseQuery(text, this.parser);
  }

  async search(parsed: ParsedQuery, opts?: SearchOptions): Promise<SearchResult> {
    await this.ready();
    return searchCatalog(this.items, parsed, opts);
  }

  async resolveText(text: string, extraCodes: (string | undefined)[] = []): Promise<ResolvedCode[]> {
    await this.ready();
    const tokens = [...extractCodeTokens(text), ...extraCodes.filter((c): c is string => !!c).map((c) => c.toUpperCase())];
    return resolveCodes([...new Set(tokens)], this.index);
  }

  async getByCode(code: string): Promise<CatalogItem | undefined> {
    await this.ready();
    return this.index.byCode.get(code.toUpperCase());
  }

  async familyMembers(key: string): Promise<CatalogItem[]> {
    await this.ready();
    return this.index.byFamily.get(key) ?? [];
  }

  /** products linked to `item` by the Sage "used in conjunction with" field, in either direction */
  async relatedFor(item: CatalogItem): Promise<{ forward: CatalogItem[]; backward: CatalogItem[]; alternatives: CatalogItem[]; replacedBy: CatalogItem[] }> {
    await this.ready();
    const pick = (codes: string[]) => {
      const out: CatalogItem[] = [];
      for (const code of codes) {
        const r = resolveCode(code, this.index);
        if (r.kind === 'exact') out.push(r.items[0]);
        else if (r.kind === 'family') out.push(...this.matchFinish(item, r.items));
      }
      return [...new Map(out.map((i) => [i.code, i])).values()];
    };
    const forward = pick(item.relatedCodes);
    const backward = (this.reverseRelated.get(item.code) ?? []).filter((i) => !forward.includes(i));
    return { forward, backward, alternatives: pick(item.alternativeCodes), replacedBy: pick(item.replacedByCodes) };
  }

  /** among the variants of a family, prefer the ones in the same finish as `target` */
  private matchFinish(target: CatalogItem, members: CatalogItem[]): CatalogItem[] {
    const live = members.filter((m) => m.status !== 'Deleted');
    const same = live.filter((m) => target.facets.finish && m.facets.finish === target.facets.finish);
    return (same.length ? same : live).slice(0, 3);
  }

  async logMiss(entry: {
    sessionId?: string;
    entryPoint?: string;
    query: string;
    intent: string;
    unknownTokens: string[];
    constraints: unknown;
    topCodes: string[];
    exact: boolean;
    translated?: unknown;
  }): Promise<void> {
    try {
      await this.supabase.client.from('search_misses').insert({
        session_id: entry.sessionId ?? null,
        entry_point: entry.entryPoint ?? null,
        query: entry.query,
        intent: entry.intent,
        unknown_tokens: entry.unknownTokens,
        constraints: entry.constraints,
        top_codes: entry.topCodes,
        exact: entry.exact,
        translated: entry.translated ?? null,
      });
    } catch (err) {
      this.logger.warn(`could not log search miss: ${(err as Error).message}`);
    }
  }

  /** facet words the catalog really contains, offered to the AI translator so it cannot invent values */
  async vocabulary(): Promise<{ types: string[]; materials: string[]; finishes: string[]; functions: string[]; tags: string[] }> {
    await this.ready();
    const set = (f: (i: CatalogItem) => string | string[] | null) => [...new Set(this.items.flatMap((i) => [f(i)].flat().filter((x): x is string => !!x)))].sort();
    return {
      types: set((i) => i.facets.type),
      materials: set((i) => i.facets.material),
      finishes: set((i) => i.facets.finish),
      functions: set((i) => i.facets.functions),
      tags: set((i) => i.facets.tags),
    };
  }
}
