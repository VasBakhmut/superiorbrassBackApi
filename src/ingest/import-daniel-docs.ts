/**
 * Loads the PDFs Daniel sent (data/from-daniel/Product Drawings Specifications) into Supabase:
 *   - "Product Outline PDF's"  -> product_drawings (kind 'outline')   one drawing per base code
 *   - templates (little text)  -> product_drawings (kind 'template')
 *   - installation instructions (real text) -> documents (so the chat can read them), linked to
 *     every product code of the family (9217 -> 49217, 59217, ...)
 * Every file is also uploaded to the public bucket `product-drawings` (prefix daniel/) so the
 * bot can hand out a permanent link.
 *
 * Run with:  pnpm import-daniel-docs -- --dry   (parse + classify only)
 *            pnpm import-daniel-docs            (upload + write)
 * Safe to re-run: storage uploads and rows are upserted. Existing documents are never overwritten.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DANIEL_DOCS_DIR ?? path.resolve(__dirname, '../../../../data/from-daniel/Product Drawings Specifications');
const DRY = process.argv.includes('--dry');
const SOURCE = 'daniel-2026-10';
const BUCKET = 'product-drawings';

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

const slug = (v: string) => v.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

// "42330E" -> "2330E": the digit in front of a 4-digit base is the finish digit, letters are the variant
function familyKeyOf(code: string): string | null {
  const m = code.toUpperCase().match(/^(\d{4,5})([A-Z]{0,3})$/);
  return m ? (m[1].length === 5 ? m[1].slice(1) : m[1]) + m[2] : null;
}

function codesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![\w.])(\d{4,5}[A-Za-z]{0,3})(?![\w.])/g)].map((m) => m[1].toUpperCase()))];
}

function brandOf(text: string): string | null {
  if (/superior brass/i.test(text)) return 'Superior Brass';
  if (/builders ?choice/i.test(text)) return 'Builders Choice';
  if (/austyle/i.test(text)) return 'Austyle';
  return null;
}

const issueOf = (text: string) => text.match(/Issue\s+\d+\.?\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}/i)?.[0] ?? null;

function nameOf(text: string): string | null {
  const a = text.match(/PRODUCT CODE:\s*[0-9A-Z\/-]+\s+(.+?)\s+APPLICABLE TO ALL FINISHES/i)?.[1];
  const b = text.match(/^(.+?)\s+APPLICABLE TO ALL FINISHES/i)?.[1];
  const pick = (a ?? b ?? '').replace(/PRODUCT CODE:.*$/i, '').replace(/\b(austyle architectural hardware a)\b/gi, '').replace(/[\d.\s]{6,}/g, ' ').replace(/\s+/g, ' ').trim();
  return pick && pick.length < 120 ? pick : null;
}

interface Item {
  abs: string; rel: string; area: 'outline' | 'template'; history: boolean; folder: string;
  base: string; text: string; kind: 'outline' | 'template' | 'instruction'; size: number;
  productCode: string | null; familyKeys: string[]; brand: string | null; name: string | null; issue: string | null;
}

/**
 * Some PDFs store whole sentences as the font's glyph numbers instead of letters (glyph = char - 29),
 * which comes out as "(QVXUH\u0003³6FDOH´" for 'Ensure "Scale"'. Such a run is one "word" containing
 * control characters, so every character in it is shifted back.
 */
export function fixShiftedText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((w) => {
      if (!/[\u0001-\u001f]/.test(w)) return w;
      return [...w]
        .map((ch) => {
          const c = ch.charCodeAt(0);
          if (c === 0xb3 || c === 0xb4) return '"';
          return c >= 0x01 && c < 0x62 ? String.fromCharCode(c + 29) : ch;
        })
        .join('');
    })
    .join('');
}

async function textOf(file: string): Promise<string> {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  try { return fixShiftedText((await parser.getText()).text.replace(/\s+/g, ' ').trim()); } catch { return ''; } finally { await parser.destroy(); }
}

/**
 * Instructions and templates that cover a whole range rather than one code ("Builders Choice Long
 * Plate Installation Instructions") have no product code in their name. They are linked to the
 * families Daniel filed under the matching drawings folder, so the bot offers them for every
 * product of that range.
 */
const RANGE_LINKS: { file: RegExp; folders: string[]; names?: RegExp }[] = [
  { file: /^Builders Choice-4$/, folders: ['Door Handles / Builders Choice / 52mm', 'Door Handles / Builders Choice / 63mm'] },
  { file: /^Builders Choice-3$/, folders: ['Door Handles / Builders Choice / History'] },
  { file: /Knob Passage 73mm/, folders: ['Door Handles / Builders Choice / 73mm'] },
  { file: /Long Plate/, folders: ['Door Handles / Builders Choice / Long Plate'] },
  { file: /^Austyle SS Round/, folders: ['Door Handles / Austyle'], names: /^Austyle (SS Door Handle|Door Handle SS)$/ },
  { file: /^Entry Handle Pairs/, folders: ['Entry Handles'], names: /Double/ },
];

function linkRanges(items: Item[]): void {
  const outlines = items.filter((i) => i.kind === 'outline');
  for (const item of items) {
    if (item.kind === 'outline' || item.familyKeys.length) continue;
    const link = RANGE_LINKS.find((l) => l.file.test(item.base));
    if (!link) continue;
    const keys = new Set<string>();
    for (const o of outlines) {
      if (!link.folders.includes(o.folder)) continue;
      if (link.names && !(o.name && link.names.test(o.name))) continue;
      o.familyKeys.forEach((k) => keys.add(k));
    }
    item.familyKeys = [...keys];
  }
}

async function load(): Promise<Item[]> {
  const items: Item[] = [];
  for (const abs of walk(ROOT)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const parts = rel.split('/');
    const area = parts[0].startsWith('Product Outline') ? 'outline' : 'template';
    const base = path.basename(abs, path.extname(abs));
    const text = await textOf(abs);
    const history = parts.some((p) => /^history$/i.test(p));
    const folder = parts.slice(1, -1).join(' / ') || (area === 'outline' ? 'Product Outline' : 'Templates & Instructions');

    let kind: Item['kind'] = 'outline';
    if (area === 'template') {
      const wordy = /installation|instruction|set-?up|retro-?fit/i.test(base);
      kind = (wordy && text.length >= 300) || text.length > 800 ? 'instruction' : 'template';
    }

    const productCode = area === 'outline'
      ? (text.match(/PRODUCT CODE:\s*([0-9A-Z][0-9A-Z\/-]*)/i)?.[1]?.toUpperCase().replace(/-+$/, '') ?? base.match(/^(\d{3,5}[A-Za-z]{0,3})/)?.[1]?.toUpperCase() ?? null)
      : (codesIn(base)[0] ?? null);
    const keys = new Set<string>();
    if (area === 'outline') { if (productCode) keys.add(familyKeyOf(productCode) ?? productCode); }
    else codesIn(base).forEach((c) => { const k = familyKeyOf(c); if (k) keys.add(k); });

    items.push({
      abs, rel, area, history, folder, base, text, kind, size: fs.statSync(abs).size, productCode,
      familyKeys: [...keys], brand: brandOf(text), name: area === 'outline' ? nameOf(text) : null, issue: issueOf(text),
    });
  }
  linkRanges(items);
  return items;
}

async function upload(item: Item, used: Set<string>): Promise<{ url: string; storagePath: string }> {
  let p = `daniel/${item.kind === 'outline' ? 'outlines' : item.kind === 'template' ? 'templates' : 'instructions'}/${slug(item.folder.replace(/ \/ /g, '__'))}/${slug(item.base)}.pdf`;
  if (used.has(p)) p = p.replace(/\.pdf$/, `_${used.size}.pdf`);
  used.add(p);
  if (!DRY) {
    const { error } = await sb.storage.from(BUCKET).upload(p, fs.readFileSync(item.abs), { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error(`upload ${p}: ${error.message}`);
  }
  return { url: sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl, storagePath: p };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

async function main() {
  console.log(`${DRY ? 'DRY RUN - ' : ''}reading ${ROOT}`);
  const items = await load();
  const count = (f: (i: Item) => string) => { const m: Record<string, number> = {}; items.forEach((i) => { const k = f(i); m[k] = (m[k] ?? 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' | '); };
  console.log(`Files: ${items.length}   by kind: ${count((i) => i.kind)}`);
  console.log(`Outline brands: ${count((i) => (i.kind === 'outline' ? (i.brand ?? 'unknown') : 'n/a')).replace(/n\/a: \d+ \| ?/, '')}`);
  console.log(`History files: ${items.filter((i) => i.history).length}`);
  console.log(`Outlines without a product code: ${items.filter((i) => i.kind === 'outline' && !i.productCode).length}`);
  console.log(`Outlines with a readable name: ${items.filter((i) => i.kind === 'outline' && i.name).length}/${items.filter((i) => i.kind === 'outline').length}`);

  // products -> family map, used to expand "9217" into 49217, 59217, ...
  const products: { code: string; family_key: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('products').select('code, family_key').range(from, from + 999);
    if (error) throw error;
    products.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const byFamily = new Map<string, string[]>();
  products.forEach((p) => p.family_key && (byFamily.get(p.family_key) ?? byFamily.set(p.family_key, []).get(p.family_key)!).push(p.code));

  const instructions = items.filter((i) => i.kind === 'instruction');
  const currentFamilies = new Set(instructions.filter((i) => !i.history).flatMap((i) => i.familyKeys));
  console.log(`\nInstructions: ${instructions.length}   scoped to a family: ${instructions.filter((i) => i.familyKeys.length).length}   without any code: ${instructions.filter((i) => !i.familyKeys.length).length}`);
  console.log(`Families with a matching product in the DB: ${[...new Set(instructions.flatMap((i) => i.familyKeys))].filter((k) => byFamily.has(k)).length}/${new Set(instructions.flatMap((i) => i.familyKeys)).size}`);
  const outlineKeys = new Set(items.filter((i) => i.kind === 'outline').flatMap((i) => i.familyKeys));
  console.log(`Outline families that match a product: ${[...outlineKeys].filter((k) => byFamily.has(k)).length}/${outlineKeys.size}`);
  console.log('Unscoped instructions:', instructions.filter((i) => !i.familyKeys.length).map((i) => i.base).join(' | ') || 'none');

  if (DRY) { console.log('\nDry run, nothing uploaded or written.'); return; }

  // --- upload every file, then write rows
  const used = new Set<string>();
  const placed = new Map<Item, { url: string; storagePath: string }>();
  let done = 0;
  await pool(items, 5, async (item) => {
    placed.set(item, await upload(item, used));
    if (++done % 100 === 0) console.log(`  uploaded ${done}/${items.length}`);
  });
  console.log(`Uploaded ${done} files`);

  const now = new Date().toISOString();
  const drawingRows = items.filter((i) => i.kind !== 'instruction').map((i) => ({
    code: i.base,
    title: i.kind === 'outline' ? `${i.productCode ?? i.base}${i.name ? ' ' + i.name : ''}` : i.base,
    category: i.folder,
    pdf_url: placed.get(i)!.url,
    storage_path: placed.get(i)!.storagePath,
    file_size_bytes: i.size,
    product_code: i.productCode,
    family_key: i.familyKeys[0] ?? null,
    family_keys: i.familyKeys,
    brand: i.brand,
    product_name: i.name,
    issue: i.issue,
    is_history: i.history,
    kind: i.kind,
    source: SOURCE,
    folder: i.folder,
    updated_at: now,
  }));
  for (let i = 0; i < drawingRows.length; i += 200) {
    const { error } = await sb.from('product_drawings').upsert(drawingRows.slice(i, i + 200), { onConflict: 'category,code' });
    if (error) throw error;
  }
  console.log(`Upserted ${drawingRows.length} drawings/templates`);

  // documents: never overwrite one that already exists from another source
  const { data: existingDocs, error: edErr } = await sb.from('documents').select('title, source');
  if (edErr) throw edErr;
  const taken = new Map((existingDocs ?? []).map((d) => [d.title, d.source as string | null]));
  const docRows = instructions.map((i) => {
    let title = i.base;
    if (taken.has(title) && taken.get(title) !== SOURCE) title = `${i.base} (Daniel)`;
    const literal = codesIn(i.base);
    const expanded = i.familyKeys.flatMap((k) => byFamily.get(k) ?? []);
    const productCodes = [...new Set([...literal, ...expanded])].slice(0, 400);
    // an old (HISTORY) instruction stays in the DB but is kept out of the chat context when a
    // current instruction exists for the same family, so the bot never gets two versions
    const supersededByCurrent = i.history && i.familyKeys.some((k) => currentFamilies.has(k));
    return {
      title,
      source_type: 'install_manual',
      product_codes: productCodes,
      file_path: i.rel,
      file_url: placed.get(i)!.url,
      version: i.issue,
      full_text: i.text,
      include_in_chat_context: !supersededByCurrent,
      family_keys: i.familyKeys,
      source: SOURCE,
      is_history: i.history,
      doc_kind: 'installation',
      issue: i.issue,
    };
  });
  const { error: docErr } = await sb.from('documents').upsert(docRows, { onConflict: 'title' });
  if (docErr) throw docErr;
  console.log(`Upserted ${docRows.length} instruction documents (${docRows.filter((d) => d.product_codes.length).length} with product codes)`);
  console.log('\nDone.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
