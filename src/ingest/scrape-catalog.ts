/**
 * Crawls the full live product catalog at www.superiorbrass.com.au (category pages ->
 * product detail pages) and upserts every product into the `products` table.
 *
 * The earlier products.json snapshot (ingest-products.ts) was partial — e.g. 42300, 43736 and
 * 49217 were missing — so this reads the source site directly instead.
 *
 * Run with:  pnpm scrape-catalog            (writes to DB)
 *            pnpm scrape-catalog -- --dry   (crawl + report only, no DB writes)
 *
 * Safe to re-run: upserts by product code, never deletes. Existing rows keep their `url` /
 * `image_url` (those point at the prototype site); the real superiorbrass.com.au link is
 * stored separately in `source_url`.
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const BASE = 'https://www.superiorbrass.com.au';
const DRY = process.argv.includes('--dry');
const CONCURRENCY = 2;
const DELAY_MS = 400;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const supabase = DRY
  ? null
  : createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Circuit breaker: if many pages in a row fail even after retries, the site is down (or
// throttling us) — stop instead of hammering it further.
let consecutiveFailures = 0;
let siteDown = false;

async function fetchHtml(url: string): Promise<string> {
  if (siteDown) throw new Error('site appears down — skipping');
  const html = await fetchWithRetries(url).catch((err) => {
    if (++consecutiveFailures >= 6) siteDown = true;
    throw err;
  });
  consecutiveFailures = 0;
  return html;
}

async function fetchWithRetries(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (catalog-sync)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000), // a single hung connection must not stall the whole crawl
      });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(attempt * 1500);
  }
  throw new Error(`failed to fetch ${url}: ${(lastErr as Error).message}`);
}

async function mapPool<T, R>(items: T[], worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return results;
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PL_RE = /href="(https:\/\/www\.superiorbrass\.com\.au\/[^"]*pl\.php)"/g;
const PD_RE = /href="(https:\/\/www\.superiorbrass\.com\.au\/[^"]+\/pd\.php)"/g;

interface CrawlState {
  seen: string[];
  queue: string[];
  productUrls: string[];
  failed: string[];
}

/**
 * Walks every category listing (following "?pager=N" pagination). State is handed to `persist`
 * after each round so a crash, a timeout or a site outage doesn't throw the progress away, and
 * a re-run picks up from the saved queue (retrying whatever failed).
 */
async function crawlCategories(
  state: CrawlState | undefined,
  persist: (s: CrawlState) => void,
): Promise<CrawlState> {
  // Seeded with an ordinary category page rather than /pl.php: the site-wide menu on every
  // page links to all categories, and the bare /pl.php root intermittently returns 525.
  const failedBefore = new Set(state?.failed ?? []);
  const seen = new Set((state?.seen ?? []).filter((u) => !failedBefore.has(u)));
  const queue: string[] = [...(state?.queue ?? []), ...failedBefore];
  if (!state) queue.push(`${BASE}/Hinges/pl.php`);
  const productUrls = new Set<string>(state?.productUrls ?? []);
  const failed = new Set<string>();

  const snapshot = (): CrawlState => ({
    seen: [...seen],
    queue: [...queue],
    productUrls: [...productUrls],
    failed: [...failed],
  });

  const processPage = (url: string, html: string) => {
    [...html.matchAll(PD_RE)].forEach((m) => productUrls.add(m[1]));
    for (const m of html.matchAll(PL_RE)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
    // listings are paginated (24 per page, "?pager=N"); follow the "Next" link until it ends
    const next = html.match(/<a class="page-link" href="(\?pager=\d+)" title="Next"/)?.[1];
    if (next) {
      const nextUrl = `${url.split('?')[0]}${next}`;
      if (!seen.has(nextUrl)) queue.push(nextUrl);
    }
  };

  while (queue.length) {
    const batch = [...new Set(queue.splice(0, queue.length))].filter((u) => !seen.has(u));
    batch.forEach((u) => seen.add(u));
    if (batch.length === 0) break;

    let batchDone = 0;
    const pages = await mapPool(batch, async (url) => {
      try {
        return { url, html: await fetchHtml(url) };
      } catch {
        failed.add(url);
        return null;
      } finally {
        if (++batchDone % 100 === 0) console.log(`    ...${batchDone}/${batch.length} in this round`);
      }
    });
    for (const page of pages) if (page) processPage(page.url, page.html);
    persist(snapshot());
    console.log(`  crawled ${seen.size} category pages, ${productUrls.size} products found so far, ${failed.size} failed`);
    if (siteDown) throw new Error('The site appears to be down (repeated failures) — progress saved, re-run later.');
  }

  return snapshot();
}

interface ScrapedProduct {
  code: string;
  name: string;
  category: string | null;
  category_path: string[];
  finish: string | null;
  size: string | null;
  brand: string | null;
  material: string | null;
  status: string | null;
  stock_message: string | null;
  features: string[];
  additional_info: string[];
  source_url: string;
  image_url: string | null;
  specs: Record<string, string>;
}

function parseProduct(url: string, html: string): ScrapedProduct | null {
  const name = decode(html.match(/<h1 itemprop="name">([\s\S]*?)<\/h1>/)?.[1] ?? '');
  const code = decode(html.match(/<p class="product-code"><strong>Product Code:\s*<\/strong>([\s\S]*?)<\/p>/)?.[1] ?? '');
  if (!name || !code) return null;

  const stock = decode(html.match(/<p class="InStockMessage"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '') || null;

  const specs: Record<string, string> = {};
  for (const m of html.matchAll(/<tr>\s*<td><strong>([\s\S]*?)<\/strong><\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const key = decode(m[1]);
    const value = decode(m[2]);
    if (key && value) specs[key] = value;
  }

  const crumbBlock = html.match(/<ol class="breadcrumb[\s\S]*?<\/ol>/)?.[0] ?? '';
  const crumbs = [...crumbBlock.matchAll(/<span itemprop="name">([\s\S]*?)<\/span>/g)].map((m) => decode(m[1]));
  const path = crumbs.slice(2, -1); // drop "Home", "Product Ranges" and the product itself

  const pick = (re: RegExp) =>
    Object.entries(specs)
      .filter(([k]) => re.test(k))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([, v]) => v);

  return {
    code,
    name,
    category: path[0] ?? null,
    category_path: path,
    finish: specs['Finish'] ?? null,
    size: specs['Size'] ?? null,
    brand: specs['Brand'] ?? null,
    material: specs['Item Base Material'] ?? null,
    status: specs['Item Status'] ?? null,
    stock_message: stock,
    features: pick(/^Item Feature \d+$/),
    additional_info: pick(/^Additional Item Info \d+$/),
    source_url: url,
    image_url: `${BASE}/productimages/${encodeURIComponent(code)}.jpg`,
    specs,
  };
}

// A full crawl takes longer than one tool run, so progress is cached on disk and a re-run
// resumes where it stopped. Pass --fresh to ignore the cache.
const CACHE_FILE = path.join(os.tmpdir(), 'sb-catalog-cache.json');
interface Cache {
  crawl?: CrawlState;
  products: Record<string, ScrapedProduct>;
}

function loadCache(): Cache {
  if (process.argv.includes('--fresh') || !fs.existsSync(CACHE_FILE)) return { products: {} };
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
}

function saveCache(cache: Cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

async function main() {
  console.log(`Crawling ${BASE} ${DRY ? '(dry run — no DB writes)' : ''}`);
  const cache = loadCache();

  const complete = (s?: CrawlState) => !!s && s.queue.length === 0 && s.failed.length === 0;
  if (complete(cache.crawl)) {
    console.log('Using cached category crawl.');
  } else {
    cache.crawl = await crawlCategories(cache.crawl, (s) => {
      cache.crawl = s;
      saveCache(cache);
    });
    saveCache(cache);
  }
  const crawl = {
    categoryPages: cache.crawl!.seen,
    productUrls: cache.crawl!.productUrls,
    failedPages: cache.crawl!.failed,
  };
  console.log(`\nCategory pages: ${crawl.categoryPages.length}, unique product URLs: ${crawl.productUrls.length}`);
  if (crawl.failedPages.length) {
    console.log(`Category pages that still failed after retries (${crawl.failedPages.length}):`);
    crawl.failedPages.forEach((u) => console.log(`  - ${u}`));
  }

  const todo = crawl.productUrls.filter((u) => !cache.products[u]);
  console.log(`\nFetching product pages: ${todo.length} to fetch, ${crawl.productUrls.length - todo.length} already cached...`);
  let done = 0;
  await mapPool(todo, async (url) => {
    try {
      const product = parseProduct(url, await fetchHtml(url));
      if (product) cache.products[url] = product;
    } catch {
      /* stays uncached; reported below and retried on the next run */
    } finally {
      if (++done % 150 === 0) {
        saveCache(cache);
        console.log(`  ${done}/${todo.length}`);
      }
    }
  });
  saveCache(cache);

  const failures = crawl.productUrls.filter((u) => !cache.products[u]).map((u) => `${u}: not fetched/parsed`);
  const parsed = crawl.productUrls.map((u) => cache.products[u]).filter((p): p is ScrapedProduct => !!p);

  const byCode = new Map<string, ScrapedProduct>();
  parsed.forEach((p) => byCode.set(p.code, p));
  console.log(`\nParsed ${parsed.length} products (${byCode.size} unique codes), ${failures.length} failures`);

  const existing = new Map<string, { url: string | null; image_url: string | null }>();
  if (supabase) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('products').select('code, url, image_url').range(from, from + 999);
      if (error) throw error;
      (data ?? []).forEach((r) => existing.set(r.code, { url: r.url, image_url: r.image_url }));
      if (!data || data.length < 1000) break;
    }
  }
  const newCodes = [...byCode.keys()].filter((c) => !existing.has(c));
  const missingFromSite = [...existing.keys()].filter((c) => !byCode.has(c));
  console.log(`Already in DB: ${existing.size}. New from scrape: ${newCodes.length}. In DB but not found on site: ${missingFromSite.length}`);
  console.log(`Spot check -> 42300:${byCode.has('42300')} 43736:${byCode.has('43736')} 49217:${byCode.has('49217')} 45108:${byCode.has('45108')}`);

  if (DRY || !supabase) {
    console.log('\nDry run — nothing written.');
    return;
  }

  // Sanity guard: a healthy crawl should find at least most of what we already have. If it
  // doesn't, the markup/pagination assumption is wrong and we must not write half-parsed data.
  if (crawl.failedPages.length > 0 || byCode.size < existing.size * 0.8 || failures.length > byCode.size * 0.05) {
    console.log('\nABORTED: crawl looks incomplete (too few products or too many failures). Nothing written.');
    failures.slice(0, 20).forEach((f) => console.log(`  - ${f}`));
    return;
  }

  const now = new Date().toISOString();
  const rows = [...byCode.values()].map((p) => {
    const prev = existing.get(p.code);
    return {
      code: p.code,
      name: p.name,
      category: p.category,
      category_path: p.category_path,
      finish: p.finish,
      size: p.size,
      brand: p.brand,
      material: p.material,
      status: p.status,
      stock_message: p.stock_message,
      features: p.features,
      additional_info: p.additional_info,
      url: prev?.url ?? p.source_url,
      image_url: prev?.image_url ?? p.image_url,
      source_url: p.source_url,
      specs: p.specs,
      scraped_at: now,
      updated_at: now,
    };
  });

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('products').upsert(rows.slice(i, i + 500), { onConflict: 'code' });
    if (error) throw error;
    console.log(`Upserted ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }

  if (failures.length) {
    console.log('\nFailures:');
    failures.slice(0, 30).forEach((f) => console.log(`  - ${f}`));
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
