/**
 * Scrapes every PDF drawing listed under austyle.com.au/support/product-drawings/<category>/,
 * downloads each file, re-hosts it in Supabase Storage (bucket `product-drawings`), and
 * upserts one row per drawing into the `product_drawings` table.
 *
 * The site's own "Download" links only work with a short-lived `refresh` token minted fresh
 * on every page load (confirmed by diffing two loads of the same page — the token changes,
 * the underlying file id doesn't), so we can't store the site's URL directly. We fetch the
 * file immediately after discovering the link and keep our own permanent copy instead.
 *
 * digital-locks is deliberately skipped: those PDFs (install manuals/SOPs) are already
 * scraped and parsed into the `documents` table by ingest.ts, via a separate pipeline.
 *
 * Run with: pnpm ingest-product-drawings (safe to re-run — upserts by code+category)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));

const BASE = 'https://austyle.com.au/support/product-drawings';
const CATEGORIES = [
  'accessories',
  'bolts',
  'door-levers',
  'door-stops',
  'entry-pull-handles',
  'flush-pulls',
  'hinges',
  'locks-latches',
  'snibs',
  'window-fittings',
];

const BRAND_PREFIX = /^(austyle|superior brass|builders choice)\s+/i;
// pairs each card's title with the download link that follows it, non-greedy so it can't
// jump past the next card
const CARD_RE = /<h3 class="package-title">([^<]+)<\/h3>[\s\S]*?data-downloadurl="([^"]+)"/g;
const MAX_PAGES_PER_CATEGORY = 20; // safety cap against an infinite pagination loop

interface DrawingItem {
  title: string;
  code: string;
  category: string;
  downloadUrl: string;
  sourceUrl: string;
}

function sanitizeFilename(code: string): string {
  return code.replace(/[^a-z0-9._-]+/gi, '_');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listCategory(category: string): Promise<DrawingItem[]> {
  const items: DrawingItem[] = [];

  for (let page = 1; page <= MAX_PAGES_PER_CATEGORY; page++) {
    const sourceUrl = page === 1 ? `${BASE}/${category}/` : `${BASE}/${category}/?cp=${page}`;
    const res = await fetch(sourceUrl);
    if (!res.ok) break;
    const html = await res.text();

    const matches = [...html.matchAll(CARD_RE)];
    if (matches.length === 0) break;

    for (const m of matches) {
      const rawTitle = m[1].trim();
      const code = rawTitle.replace(BRAND_PREFIX, '').trim();
      items.push({ title: rawTitle, code, category, downloadUrl: m[2], sourceUrl });
    }

    const hasNextPage = new RegExp(`\\?cp=${page + 1}"`).test(html);
    if (!hasNextPage) break;
  }

  return items;
}

async function run() {
  let totalOk = 0;
  let totalFailed = 0;
  const failures: string[] = [];

  for (const category of CATEGORIES) {
    console.log(`\n=== ${category} ===`);
    const items = await listCategory(category);
    console.log(`Found ${items.length} drawings`);

    for (const item of items) {
      try {
        const fileRes = await fetch(item.downloadUrl);
        if (!fileRes.ok) throw new Error(`download failed: HTTP ${fileRes.status}`);
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        const path = `${item.category}/${sanitizeFilename(item.code)}.pdf`;
        const { error: uploadError } = await supabase.storage
          .from('product-drawings')
          .upload(path, buffer, { contentType: 'application/pdf', upsert: true });
        if (uploadError) throw uploadError;

        const { data: pub } = supabase.storage.from('product-drawings').getPublicUrl(path);

        const { error: dbError } = await supabase.from('product_drawings').upsert(
          {
            code: item.code,
            title: item.title,
            category: item.category,
            pdf_url: pub.publicUrl,
            source_url: item.sourceUrl,
            file_size_bytes: buffer.length,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'category,code' },
        );
        if (dbError) throw dbError;

        totalOk++;
        process.stdout.write('.');
      } catch (err) {
        totalFailed++;
        failures.push(`${item.category}/${item.title}: ${(err as Error).message}`);
        process.stdout.write('x');
      }

      await sleep(150); // be polite to austyle.com.au
    }
  }

  console.log(`\n\nDone. ${totalOk} ingested, ${totalFailed} failed.`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
