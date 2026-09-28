/**
 * Downloads every PDF listed in data/knowledge-base/scrape-sources.json (scraped from
 * austyle.com.au/support/*) into data/knowledge-base/, and writes/updates
 * data/knowledge-base/manifest.json (the file ingest.ts reads) to match.
 *
 * Run with: pnpm --filter api scrape-download
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.resolve(__dirname, '../../../../data/knowledge-base');

interface ScrapeSource {
  category: string;
  sourceType: 'sop' | 'install_manual' | 'brochure' | 'product_spec' | 'other';
  title: string;
  url: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function run() {
  const raw = await readFile(path.join(KB_DIR, 'scrape-sources.json'), 'utf-8');
  const sources: ScrapeSource[] = JSON.parse(raw);

  const existingManifestRaw = await readFile(path.join(KB_DIR, 'manifest.json'), 'utf-8').catch(() => '[]');
  const manifest: any[] = JSON.parse(existingManifestRaw);
  const manifestByTitle = new Map(manifest.map((m) => [m.title, m]));

  for (const source of sources) {
    const filename = `${source.category}_${slugify(source.title)}.pdf`;
    const filePath = path.join(KB_DIR, filename);

    console.log(`Downloading: ${source.title}`);
    const res = await fetch(source.url, { redirect: 'follow' });
    if (!res.ok) {
      console.error(`  FAILED (${res.status}): ${source.url}`);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('pdf')) {
      console.error(`  SKIPPED (not a pdf, content-type=${contentType}): ${source.url}`);
      continue;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(filePath, buffer);
    console.log(`  Saved ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);

    manifestByTitle.set(source.title, {
      file: filename,
      title: source.title,
      sourceType: source.sourceType,
      productCodes: (source.title.match(/\b\d{4,5}\b/g) ?? []).filter((v, i, a) => a.indexOf(v) === i),
      version: null,
    });
  }

  await mkdir(KB_DIR, { recursive: true });
  await writeFile(
    path.join(KB_DIR, 'manifest.json'),
    JSON.stringify([...manifestByTitle.values()], null, 2),
  );

  console.log(`\nDone. manifest.json now has ${manifestByTitle.size} entries.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
