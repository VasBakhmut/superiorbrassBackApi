export type Facet = 'type' | 'material' | 'finish' | 'function' | 'tag' | 'brand' | 'finishDetail';

/** What we know about a product from its name/category/finish/material/features, derived once. */
export interface Facets {
  type: string | null;
  material: string | null;
  finish: string | null;
  finishDetail: string[];
  functions: string[];
  tags: string[];
  brand: string | null;
}

export interface CatalogItem {
  code: string;
  name: string;
  category: string | null;
  categoryPath: string[];
  brand: string | null;
  finish: string | null;
  material: string | null;
  size: string | null;
  status: string | null;
  features: string[];
  relatedText: string | null;
  relatedCodes: string[];
  alternativeCodes: string[];
  replacedByCodes: string[];
  familyKey: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  facets: Facets;
  /** stemmed words of name + category path + features, used for free-text matching */
  tokens: Set<string>;
  nameTokens: Set<string>;
}

export type Availability = 'in_stock' | 'sold_out' | 'unknown' | 'not_listed' | 'unavailable';

export interface ProductCard {
  code: string;
  name: string;
  brand: string | null;
  finish: string | null;
  material: string | null;
  size: string | null;
  url: string | null;
  imageUrl: string | null;
  note?: string;
  availability?: Availability;
  /** other finishes/variants of the same product */
  variants?: { code: string; finish: string | null; url: string | null }[];
}

export interface LinkItem {
  title: string;
  url: string;
  kind: 'drawing' | 'template' | 'instructions' | 'product' | 'category';
  code?: string;
}

/** One thing the customer asked for, in catalog terms. */
export interface Constraint {
  facet: Facet;
  values: string[];
  soft: boolean;
  term: string;
  label: string;
}

export interface ParsedQuery {
  constraints: Constraint[];
  freeTokens: string[];
  corrected: { from: string; to: string }[];
  unknownTokens: string[];
  interpretation: string[];
}

export interface SearchResult {
  cards: ProductCard[];
  totalFamilies: number;
  exact: boolean;
  /** how many products (families) satisfy everything that was asked */
  exactCount: number;
  interpretation: string[];
  unknownTokens: string[];
  topCodes: string[];
  moreUrl?: string;
  moreLabel?: string;
}
