import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface ProductMatch {
  code: string;
  name: string;
  category: string | null;
  finish: string | null;
  size: string | null;
  material: string | null;
  features: string[];
  stockMessage: string | null;
  url: string | null;
  usedWith: string | null;
}

// words too generic to usefully narrow a product search
const STOPWORDS = new Set([
  'the', 'a', 'an', 'for', 'my', 'i', 'im', 'need', 'want', 'help', 'me', 'to', 'of', 'is',
  'are', 'with', 'and', 'or', 'door', 'lock', 'looking', 'find', 'good', 'best', 'please',
  // generic terms that are also common boilerplate inside unrelated product names/descriptions
  // (e.g. "(specify product# to suit)") — without these, a request like "I need a drawing/spec
  // for product X" would ILIKE-match any product whose text happens to contain that filler word.
  'product', 'products', 'drawing', 'drawings', 'specification', 'specifications', 'spec',
  'specs', 'code', 'codes', 'item', 'items',
]);

const SELECT_COLUMNS = 'code, name, category, finish, size, material, features, stock_message, url, status, specs';

// matches a product code as the customer would write it (e.g. "59405", "13073A") — used to
// try an exact lookup before falling back to fuzzy keyword search.
const CODE_PATTERN = /\b\d{4,6}[a-z]?\b/gi;

function toMatch(p: any): ProductMatch {
  return {
    code: p.code,
    name: p.name,
    category: p.category,
    finish: p.finish,
    size: p.size,
    material: p.material,
    features: p.features ?? [],
    stockMessage: p.stock_message,
    url: p.url,
    usedWith: p.specs?.['Used in conjunction with'] ?? null,
  };
}

@Injectable()
export class ProductsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Exact product-code lookup first (customers often quote the code verbatim, and a fuzzy
   * ILIKE across name/category/finish/material never matched against the code column at
   * all), then fuzzy keyword search over name/category/finish/material/code to fill any
   * remaining slots. No embeddings — good enough at ~2000 rows.
   */
  async search(conversationText: string, limit = 5): Promise<ProductMatch[]> {
    const found = new Map<string, ProductMatch>();

    const explicitCodes = [...new Set(conversationText.match(CODE_PATTERN) ?? [])];
    if (explicitCodes.length > 0) {
      const { data, error } = await this.supabase.client
        .from('products')
        .select(SELECT_COLUMNS)
        .not('status', 'ilike', '%delete%')
        .in('code', explicitCodes);
      if (error) throw error;
      (data ?? []).forEach((p) => found.set(p.code, toMatch(p)));
    }

    if (found.size < limit) {
      const keywords = [...new Set(conversationText.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter(
        (w) => !STOPWORDS.has(w),
      );
      if (keywords.length > 0) {
        const orFilter = keywords
          .slice(0, 12) // keep the query reasonable in size
          .flatMap((kw) => [
            `name.ilike.%${kw}%`,
            `category.ilike.%${kw}%`,
            `finish.ilike.%${kw}%`,
            `material.ilike.%${kw}%`,
            `code.ilike.%${kw}%`,
          ])
          .join(',');

        const { data, error } = await this.supabase.client
          .from('products')
          .select(SELECT_COLUMNS)
          .not('status', 'ilike', '%delete%')
          .or(orFilter)
          .limit(limit);
        if (error) throw error;
        (data ?? []).forEach((p) => {
          if (!found.has(p.code)) found.set(p.code, toMatch(p));
        });
      }
    }

    return [...found.values()].slice(0, limit);
  }

  formatForPrompt(matches: ProductMatch[]): string {
    if (matches.length === 0) return '(no matching products found in the catalog snapshot)';
    return matches
      .map((p) => {
        const parts = [`${p.name} (code ${p.code})`];
        if (p.category) parts.push(`category: ${p.category}`);
        if (p.finish) parts.push(`finish: ${p.finish}`);
        if (p.size) parts.push(`size: ${p.size}`);
        if (p.features.length) parts.push(`features: ${p.features.join('; ')}`);
        if (p.usedWith) parts.push(`used in conjunction with: ${p.usedWith}`);
        if (p.url) parts.push(`link: ${p.url}`);
        return `- ${parts.join(', ')}`;
      })
      .join('\n');
  }
}
