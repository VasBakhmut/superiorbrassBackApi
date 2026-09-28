/**
 * One-off ingestion script: parses every PDF listed in data/knowledge-base/manifest.json
 * and upserts its full extracted text into Supabase (documents.full_text). No embeddings —
 * the chat backend passes the full corpus straight into the model's context, which is fine
 * at this corpus size (tens of KB per document, ~40 documents total).
 *
 * Run with: pnpm --filter api ingest
 *
 * When Austyle sends the full document set, add new entries to manifest.json
 * (with the correct sourceType/productCodes) and re-run this script — it's safe to run
 * repeatedly, it upserts by title.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.resolve(__dirname, '../../../../data/knowledge-base');

interface ManifestEntry {
  file: string;
  title: string;
  sourceType: 'sop' | 'install_manual' | 'brochure' | 'product_spec' | 'other';
  productCodes: string[];
  version: string | null;
}

async function run() {
  const manifestRaw = await readFile(path.join(KB_DIR, 'manifest.json'), 'utf-8');
  const manifest: ManifestEntry[] = JSON.parse(manifestRaw);

  for (const entry of manifest) {
    console.log(`\n--- ${entry.title} ---`);
    const filePath = path.join(KB_DIR, entry.file);
    const buffer = await readFile(filePath);

    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();

    const fullText = result.text.replace(/\s+/g, ' ').trim();
    console.log(`Parsed ${result.total} pages -> ${fullText.length} chars`);

    if (fullText.length < 20) {
      console.log('  SKIPPED (no extractable text, likely an image-only PDF)');
      continue;
    }

    const { error } = await supabase.from('documents').upsert(
      {
        title: entry.title,
        source_type: entry.sourceType,
        product_codes: entry.productCodes,
        version: entry.version,
        file_path: entry.file,
        full_text: fullText,
      },
      { onConflict: 'title' },
    );
    if (error) throw error;

    console.log(`  Saved (${fullText.length} chars)`);
  }

  console.log('\nIngestion complete.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
