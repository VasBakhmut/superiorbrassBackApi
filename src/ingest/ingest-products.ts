/**
 * Fetches products.json (published by the frontend at its Vercel site root — a snapshot of
 * scraped superiorbrass.com.au product pages) and upserts it into the `products` table.
 *
 * Run with: pnpm ingest-products
 * Safe to re-run — upserts by product code.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));

const PRODUCTS_JSON_URL = process.env.PRODUCTS_JSON_URL ?? 'https://superiorbrass-proto.vercel.app/products.json';

interface SourceProduct {
  code: string;
  name: string;
  category: string | null;
  categoryPath: string[] | null;
  finish: string | null;
  size: string | null;
  brand: string | null;
  material: string | null;
  status: string | null;
  stockMessage: string | null;
  features: string[] | null;
  additionalInfo: string[] | null;
  url: string | null;
  images: string[] | null;
  specs: Record<string, unknown> | null;
}

async function run() {
  console.log(`Fetching ${PRODUCTS_JSON_URL} ...`);
  const res = await fetch(PRODUCTS_JSON_URL);
  if (!res.ok) throw new Error(`Failed to fetch products.json: ${res.status}`);
  const data = await res.json();

  const products: SourceProduct[] = data.products;
  console.log(`Fetched ${products.length} products (generatedAt: ${data.generatedAt})`);

  const rows = products.map((p) => ({
    code: p.code,
    name: p.name,
    category: p.category,
    category_path: p.categoryPath ?? [],
    finish: p.finish,
    size: p.size,
    brand: p.brand,
    material: p.material,
    status: p.status,
    stock_message: p.stockMessage,
    features: p.features ?? [],
    additional_info: p.additionalInfo ?? [],
    url: p.url,
    image_url: p.images?.[0] ?? null,
    specs: p.specs ?? {},
    updated_at: new Date().toISOString(),
  }));

  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('products').upsert(batch, { onConflict: 'code' });
    if (error) throw error;
    console.log(`Upserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }

  console.log('\nDone.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
