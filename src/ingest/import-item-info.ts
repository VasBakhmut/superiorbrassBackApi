/**
 * Imports the Sage "Item Info List" (the full item master Daniel sent) into the `products`
 * table. The Excel file is first converted to JSON (outside the repo) so this script needs
 * no spreadsheet dependency: data/from-daniel/item-info-261007.json.
 *
 * Run with:  pnpm import-item-info -- --dry    (parse + report only, no DB writes)
 *            pnpm import-item-info             (upsert by item code)
 *
 * Safe to re-run. Existing rows keep their `url`, `image_url` and `stock_message` (those came
 * from the earlier site snapshot); new rows get the real site link in `url`/`image_url`.
 * Stock is deliberately NOT stored: it is read live from the product page when asked.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.ITEM_INFO_JSON ?? path.resolve(__dirname, '../../../../data/from-daniel/item-info-261007.json');
const DRY = process.argv.includes('--dry');
const SOURCE = 'sage-item-info-261007';
const SITE = 'https://www.superiorbrass.com.au';

type Raw = Record<string, string>;
const s = (v: unknown) => String(v ?? '').trim();

const STATUS: Record<string, string> = {
  'stock item': 'Stock Item',
  deleted: 'Deleted',
  'near discontinued': 'Near Discontinued',
  'punched in-house from passage set': 'Punched In-House from Passage Set',
  'punched in house': 'Punched In-House from Passage Set',
  'punched in-house': 'Punched In-House from Passage Set',
  'locally plated': 'Locally Plated',
  'plated to order': 'Plated To Order',
  'kitting item': 'Kitting Item',
  'customer order': 'Customer Order',
  'spare part': 'Spare Part',
  admin: 'Admin',
};
// Sage statuses were typed by hand: "Deleted item", "Stock iterm", a cell damaged by a bad
// find-and-replace ("PuncPunched In-House from Passage Sethed Locally"), etc. Fold them by pattern.
function normStatus(v: string): string | null {
  if (!v) return null;
  const k = v.toLowerCase();
  if (/delet/.test(k)) return 'Deleted';
  if (/^stock/.test(k)) return 'Stock Item';
  if (/near discontinu/.test(k)) return 'Near Discontinued';
  if (/punch/.test(k) && /locally$/.test(k)) return 'Punched Locally';
  if (/in-?\s?house/.test(k)) return 'Punched In-House from Passage Set';
  return STATUS[k] ?? v;
}

const normUnit = (v: string) => {
  const k = v.toLowerCase();
  return k === 'ea' ? 'Each' : k === 'pr' ? 'Pair' : k === 'set' ? 'Set' : v || null;
};

const VALID_BRANDS = new Map([
  ['austyle', 'Austyle'],
  ['superior brass', 'Superior Brass'],
  ['builders choice', 'Builders Choice'],
]);
function cleanBrand(raw: string, itemType: string): { brand: string | null; repaired: boolean } {
  const ok = VALID_BRANDS.get(raw.toLowerCase());
  if (ok) return { brand: ok, repaired: false };
  const t = itemType.toLowerCase();
  const derived = t.includes('austyle') ? 'Austyle' : t.includes('superior') ? 'Superior Brass' : t.includes('builders choice') ? 'Builders Choice' : null;
  return { brand: derived, repaired: raw !== '' };
}

// product codes inside free text: "x9028", "49217", "#15111", "9020/45mm"; skips sizes like 60mm / 2.5mm
function extractCodes(text: string, self: string): string[] {
  const out = new Set<string>();
  for (const m of text.replace(/#/g, ' ').matchAll(/(?<![\w.])(x?\d{4,6}[A-Za-z]{0,3})(?![\w.])/gi)) {
    const t = m[1];
    const code = /^x/i.test(t) ? 'x' + t.slice(1).toUpperCase() : t.toUpperCase();
    if (code !== self) out.add(code);
  }
  return [...out];
}

// "42330E" -> "2330E": the digit in front of a 4-digit base is the finish digit, the letters are the variant
function familyKey(code: string): string | null {
  const m = code.match(/^(\d{4,5})([A-Z]{0,3})$/);
  if (!m) return null;
  return (m[1].length === 5 ? m[1].slice(1) : m[1]) + m[2];
}

// the site builds its URL slugs from the item name: spaces -> "-", "&" -> "_and_", "/" -> "_or_", "-" -> "_dash_"
function slugify(name: string): string {
  return name
    .replace(/&/g, '_and_')
    .replace(/\//g, '_or_')
    .replace(/["*]/g, '_')
    .replace(/-/g, '_dash_')
    .replace(/\s/g, '-');
}

function build(r: Raw, code: string) {
  const { brand, repaired } = cleanBrand(s(r['Brand']), s(r['Item Type']));
  const comments = ['Comments', 'Comments2', 'Comments3', 'Comments4'].map((c) => s(r[c])).filter(Boolean);
  const features = ['Features & Benefits', 'Features & Benefits2', 'Features & Benefits3'].map((c) => s(r[c])).filter(Boolean);
  const itemType = s(r['Item Type']);
  const related = s(r['Related Products or used In conjunction With']);
  const status = normStatus(s(r['Status']));
  const unit = normUnit(s(r['UOE']));

  const alternatives = new Set<string>();
  const replacedBy = new Set<string>();
  for (const c of comments) {
    if (/alternativ/i.test(c)) extractCodes(c.replace(/^.*?alternativ\w*/i, ''), code).forEach((x) => alternatives.add(x));
    else if (/^\s*(now|new code|new item|replaced)/i.test(c)) extractCodes(c, code).forEach((x) => replacedBy.add(x));
  }

  const name = s(r['Item Description']);
  const slug = slugify(name);
  const specs: Record<string, string> = {};
  const put = (k: string, v: string | null) => v && (specs[k] = v);
  put('UOM', unit === 'Pair' ? 'PR' : unit);
  put('Finish', s(r['Finish Colour']));
  put('Size', s(r['Size']));
  put('Brand', brand);
  put('Barcode', s(r['Barcode']));
  features.forEach((f, i) => put(`Item Feature ${i + 1}`, f));
  put('Item Base Material', s(r['Base Material']));
  put('Item Projection', s(r['Size Projection']));
  put('Item Status', status);
  comments.forEach((c, i) => put(`Additional Item Info ${i + 1}`, c));
  put('Used in conjunction with', related);

  return {
    brandRepaired: repaired,
    row: {
      code,
      name,
      category: itemType || null,
      category_path: [itemType, s(r['Range 1']), s(r['Range 2'])].filter(Boolean),
      finish: s(r['Finish Colour']) || null,
      size: s(r['Size']) || null,
      brand,
      material: s(r['Base Material']) || null,
      status,
      features,
      additional_info: comments,
      specs,
      // encodeURIComponent, not encodeURI: names can contain "#" which would otherwise cut the URL
      product_url: `${SITE}/${encodeURIComponent(code)}/${slug ? encodeURIComponent(slug) + '/' : ''}pd.php`,
      site_image_url: `${SITE}/productimages/${encodeURIComponent(code)}.jpg`,
      family_key: familyKey(code),
      related_text: related || null,
      related_codes: extractCodes(related, code),
      alternative_codes: [...alternatives],
      replaced_by_codes: [...replacedBy],
      unit,
      barcode: s(r['Barcode']) || null,
      projection: s(r['Size Projection']) || null,
      source: SOURCE,
      imported_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    slug,
  };
}

async function main() {
  const raw: Raw[] = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  console.log(`Read ${raw.length} rows from ${path.basename(FILE)}`);

  const built = new Map<string, ReturnType<typeof build>>();
  const dupes: string[] = [];
  let brandRepaired = 0;
  for (const r of raw) {
    // codes are kept exactly as written: "3064 &" is the ampersand letter of the Alphabet range,
    // a real item that is different from "3064"
    const code = s(r['Item Number']);
    if (!code) continue;
    if (built.has(code)) { dupes.push(code); continue; }
    const b = build(r, code);
    if (b.brandRepaired) brandRepaired++;
    built.set(code, b);
  }
  const all = [...built.values()];

  // an item with no brand takes the brand of its family when every branded member agrees
  const familyBrands = new Map<string, Set<string>>();
  for (const b of all) if (b.row.family_key && b.row.brand) (familyBrands.get(b.row.family_key) ?? familyBrands.set(b.row.family_key, new Set()).get(b.row.family_key)!).add(b.row.brand);
  let brandFromFamily = 0;
  for (const b of all) {
    const set = b.row.family_key ? familyBrands.get(b.row.family_key) : undefined;
    if (!b.row.brand && set?.size === 1) { b.row.brand = [...set][0]; b.row.specs['Brand'] = b.row.brand; brandFromFamily++; }
  }

  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const existing = new Map<string, { url: string | null }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('products').select('code, url').range(from, from + 999);
    if (error) throw error;
    (data ?? []).forEach((d) => existing.set(d.code, { url: d.url }));
    if (!data || data.length < 1000) break;
  }

  const countBy = (f: (b: (typeof all)[number]) => string) => {
    const m: Record<string, number> = {};
    all.forEach((b) => { const k = f(b); m[k] = (m[k] ?? 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' | ');
  };
  const newCodes = all.filter((b) => !existing.has(b.row.code));
  console.log(`\nUnique items: ${all.length}  (duplicates skipped: ${dupes.length} -> ${dupes.join(', ')})`);
  console.log(`Already in DB: ${all.length - newCodes.length}   New: ${newCodes.length}   In DB but not in this list: ${[...existing.keys()].filter((c) => !built.has(c)).length}`);
  console.log(`Brand repaired from item type (garbage or empty): ${brandRepaired}   taken from the item's family: ${brandFromFamily}`);
  console.log(`Brands now: ${countBy((b) => b.row.brand ?? '(unknown)')}`);
  console.log(`Statuses now: ${countBy((b) => b.row.status ?? '(none)')}`);
  console.log(`With related codes: ${all.filter((b) => b.row.related_codes.length).length}   alternatives: ${all.filter((b) => b.row.alternative_codes.length).length}   replaced-by: ${all.filter((b) => b.row.replaced_by_codes.length).length}   family key: ${all.filter((b) => b.row.family_key).length}`);

  // does our slug rule reproduce the real slugs we already have in the DB?
  let match = 0, compared = 0;
  const bad: string[] = [];
  for (const b of all) {
    const prev = existing.get(b.row.code)?.url;
    const theirs = prev?.match(/\/([^/]+)\/pd\.(?:html|php)$/)?.[1];
    if (!theirs) continue;
    compared++;
    if (decodeURI(theirs) === b.slug) match++; else if (bad.length < 12) bad.push(`${b.row.code}\n     mine : ${b.slug}\n     site : ${decodeURI(theirs)}`);
  }
  console.log(`\nSlug rule vs real site slugs: ${match}/${compared} identical`);
  bad.forEach((x) => console.log('  ' + x));

  for (const code of ['42300', '43736', '49217', '45108', '42330E', '3064']) {
    const b = built.get(code)?.row;
    if (b) console.log(`\n[${code}] ${b.name} | ${b.status} | ${b.brand} | family ${b.family_key}\n   path: ${b.category_path.join(' > ')}\n   related: ${JSON.stringify(b.related_codes)} alt: ${JSON.stringify(b.alternative_codes)} now: ${JSON.stringify(b.replaced_by_codes)}\n   ${b.product_url}`);
  }

  if (DRY) { console.log('\nDry run, nothing written.'); return; }

  const toInsert = all.filter((b) => !existing.has(b.row.code)).map((b) => ({ ...b.row, url: b.row.product_url, image_url: b.row.site_image_url }));
  const toUpdate = all.filter((b) => existing.has(b.row.code)).map((b) => b.row);
  for (const [label, rows] of [['new', toInsert], ['existing', toUpdate]] as const) {
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await sb.from('products').upsert(rows.slice(i, i + 400), { onConflict: 'code' });
      if (error) throw error;
    }
    console.log(`Upserted ${rows.length} ${label} items`);
  }
  console.log('\nDone.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
