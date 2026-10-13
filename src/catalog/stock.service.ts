import { Injectable, Logger } from '@nestjs/common';
import type { Availability, CatalogItem } from './catalog.types.js';
import { SITE } from './search.js';

export interface StockResult {
  availability: Availability;
  /** the exact words the site shows, e.g. "In Stock" */
  message: string | null;
  checkedAt: number;
}

/** Reads the live availability line off a product page on the website. Pure, so it can be tested. */
export function parseStockHtml(html: string): { availability: Availability; message: string | null; code: string | null } {
  const code = html.match(/<p class="product-code"><strong>Product Code:\s*<\/strong>([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? null;
  const raw = html.match(/<p class="InStockMessage"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  const message = raw ? raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  let availability: Availability = 'unknown';
  if (message) {
    if (/sold out|out of stock|no stock|unavailable/i.test(message)) availability = 'sold_out';
    else if (/in stock|available/i.test(message)) availability = 'in_stock';
  }
  return { availability, message, code };
}

const DEFINITE_TTL = 5 * 60 * 1000;
const SHORT_TTL = 60 * 1000;
const MAX_PARALLEL = 3;

/**
 * Stock is never stored: it changes by the hour, so a saved value would be wrong by next month.
 * When a customer asks, we open the product page and read what the website says right now.
 * Answers are cached for a few minutes so a busy chat can't hammer the website.
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);
  private readonly cache = new Map<string, StockResult>();
  private active = 0;
  private waiting: (() => void)[] = [];

  async check(item: CatalogItem): Promise<StockResult> {
    const key = item.code.toUpperCase();
    const hit = this.cache.get(key);
    if (hit) {
      const ttl = hit.availability === 'in_stock' || hit.availability === 'sold_out' ? DEFINITE_TTL : SHORT_TTL;
      if (Date.now() - hit.checkedAt < ttl) return hit;
    }
    const result = await this.limited(() => this.fetchStock(item));
    this.cache.set(key, result);
    return result;
  }

  async checkMany(items: CatalogItem[]): Promise<Map<string, StockResult>> {
    const results = await Promise.all(items.map(async (i) => [i.code, await this.check(i)] as const));
    return new Map(results);
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_PARALLEL) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async fetchStock(item: CatalogItem): Promise<StockResult> {
    const url = item.productUrl ?? `${SITE}/${encodeURIComponent(item.code)}/pd.php`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (support-chat stock check)' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 404) return { availability: 'not_listed', message: null, checkedAt: Date.now() };
        if (res.ok) {
          const parsed = parseStockHtml(await res.text());
          // a redirect to another product must never be read as this product's stock
          if (parsed.code && parsed.code.toUpperCase() !== item.code.toUpperCase()) {
            return { availability: 'not_listed', message: null, checkedAt: Date.now() };
          }
          return { availability: parsed.availability, message: parsed.message, checkedAt: Date.now() };
        }
        this.logger.warn(`stock check ${item.code}: HTTP ${res.status}`);
      } catch (err) {
        this.logger.warn(`stock check ${item.code}: ${(err as Error).message}`);
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 600));
    }
    return { availability: 'unavailable', message: null, checkedAt: Date.now() };
  }
}
