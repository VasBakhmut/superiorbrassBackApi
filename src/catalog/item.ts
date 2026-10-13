import type { CatalogItem } from './catalog.types.js';
import { deriveFacets } from './facets.js';
import { stemTokens } from './text.js';

/** one `products` row -> the in-memory item the search works on */
export function rowToItem(r: any): CatalogItem {
  const features: string[] = r.features ?? [];
  const categoryPath: string[] = r.category_path ?? [];
  const facets = deriveFacets({
    name: r.name,
    category: r.category,
    finish: r.finish,
    material: r.material,
    features,
    brand: r.brand,
  });
  const nameTokens = new Set(stemTokens(r.name));
  const tokens = new Set([
    ...nameTokens,
    ...stemTokens([categoryPath.join(' '), features.join(' '), r.finish ?? '', r.material ?? '', r.brand ?? ''].join(' ')),
  ]);
  return {
    code: r.code,
    name: r.name,
    category: r.category,
    categoryPath,
    brand: facets.brand,
    finish: r.finish,
    material: r.material,
    size: r.size,
    status: r.status,
    features,
    relatedText: r.related_text ?? null,
    relatedCodes: r.related_codes ?? [],
    alternativeCodes: r.alternative_codes ?? [],
    replacedByCodes: r.replaced_by_codes ?? [],
    familyKey: r.family_key ?? null,
    productUrl: r.product_url ?? r.url ?? null,
    imageUrl: r.site_image_url ?? null,
    facets,
    tokens,
    nameTokens,
  };
}
