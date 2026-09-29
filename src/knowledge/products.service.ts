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
}

// words too generic to usefully narrow a product search
const STOPWORDS = new Set([
  'the', 'a', 'an', 'for', 'my', 'i', 'im', 'need', 'want', 'help', 'me', 'to', 'of', 'is',
  'are', 'with', 'and', 'or', 'door', 'lock', 'looking', 'find', 'good', 'best', 'please',
]);

@Injectable()
export class ProductsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Lightweight keyword search over the product catalog — no embeddings, just ILIKE across
   * name/category/finish/features/material. Good enough at ~2000 rows; revisit if/when the
   * catalog grows or needs real filtering (price range, availability, etc).
   */
  async search(conversationText: string, limit = 5): Promise<ProductMatch[]> {
    const keywords = [...new Set(conversationText.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter(
      (w) => !STOPWORDS.has(w),
    );
    if (keywords.length === 0) return [];

    const orFilter = keywords
      .slice(0, 12) // keep the query reasonable in size
      .flatMap((kw) => [
        `name.ilike.%${kw}%`,
        `category.ilike.%${kw}%`,
        `finish.ilike.%${kw}%`,
        `material.ilike.%${kw}%`,
      ])
      .join(',');

    const { data, error } = await this.supabase.client
      .from('products')
      .select('code, name, category, finish, size, material, features, stock_message, url, status')
      .not('status', 'ilike', '%delete%')
      .or(orFilter)
      .limit(limit);
    if (error) throw error;

    return (data ?? []).map((p) => ({
      code: p.code,
      name: p.name,
      category: p.category,
      finish: p.finish,
      size: p.size,
      material: p.material,
      features: p.features ?? [],
      stockMessage: p.stock_message,
      url: p.url,
    }));
  }

  formatForPrompt(matches: ProductMatch[]): string {
    if (matches.length === 0) return '(no matching products found in the catalog snapshot)';
    return matches
      .map(
        (p) =>
          `- ${p.name} (code ${p.code})${p.category ? `, category: ${p.category}` : ''}${p.finish ? `, finish: ${p.finish}` : ''}${p.size ? `, size: ${p.size}` : ''}${p.features.length ? `, features: ${p.features.join('; ')}` : ''}`,
      )
      .join('\n');
  }
}
