import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogItem, LinkItem, ParsedQuery, ProductCard, SearchResult } from '../catalog/catalog.types.js';
import { type ResolvedCode, familyKeysOf } from '../catalog/codes.js';
import { FilesService } from '../catalog/files.service.js';
import { toCard } from '../catalog/search.js';
import { StockService } from '../catalog/stock.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { anyDeterministicCodeIntent, classify, isInfoLike, normalize } from './intent.js';
import { QueryTranslatorService } from './query-translator.service.js';
import { T, shortName, stockLine } from './templates.js';

const RECOMMEND_CAPABLE_ENTRY_POINTS = new Set(['sticky_widget', 'product_page']);
const MAX_STOCK_ITEMS = 6;

export interface RouterInput {
  text: string;
  /** earlier customer messages in this conversation, oldest first (not including `text`) */
  userHistory: string[];
  entryPoint?: string;
  productCode?: string;
  hasImage: boolean;
  sessionId: string;
}

export interface RoutedAnswer {
  intent: string;
  text: string;
  cards?: ProductCard[];
  links?: LinkItem[];
}

export interface AiContext {
  intent: string;
  canRecommend: boolean;
  /** facts about the products the customer is talking about, from our own data */
  productFacts: string;
  /** manuals / SOPs / instructions that belong to those products */
  docsText: string;
}

export type RouterOutcome =
  | { kind: 'answer'; answer: RoutedAnswer }
  | { kind: 'escalate'; intent: string; summary: string; message: string }
  | { kind: 'ai'; context: AiContext };

interface Part {
  text?: string;
  cards?: ProductCard[];
  links?: LinkItem[];
  missing?: string;
}

// looking after hardware you already own: "rust proof" or "polished" describe a product, not a care question
const CARE = /\b(how (do|to|can|should) (i |you |we )?(clean|polish|maintain|look after|care for|remove|get rid of|stop|prevent|protect)|cleaning|maintenance|maintain|look after|tarnish(ed|ing)?|discolou?r(ed|ation|ing)?|rust(ed|y|ing)\b|corroded|stained)/i;
const INSTALLER = /\b(installers?|authori[sz]ed installers?|who can install|find (an )?installer|locksmith)\b/i;
const CONTEXT_POINTER = /\b(this|it|that|these|the same|same one)\b/i;

const answer = (a: RoutedAnswer): RouterOutcome => ({ kind: 'answer', answer: a });
const escalate = (intent: string, summary: string, message: string = T.escalate): RouterOutcome => ({ kind: 'escalate', intent, summary, message });

/**
 * Decides, in order and without AI, whether the backend can answer by itself: small talk,
 * a drawing / instructions / stock / compatibility / product-info lookup by code, or a catalog
 * search with filters. Only what is left over goes to the AI, with just the data it needs; and a
 * question nobody can answer goes straight to a human, without paying for an AI call first.
 */
@Injectable()
export class AnswerRouter {
  constructor(
    private readonly catalog: CatalogService,
    private readonly stock: StockService,
    private readonly files: FilesService,
    private readonly knowledge: KnowledgeService,
    private readonly translator: QueryTranslatorService,
  ) {}

  async route(input: RouterInput): Promise<RouterOutcome> {
    const text = normalize(input.text);
    const intent = classify(text);
    const canRecommend = RECOMMEND_CAPABLE_ENTRY_POINTS.has(input.entryPoint ?? '');

    if (!input.hasImage && intent.smalltalk) {
      return answer({ intent: `smalltalk:${intent.smalltalk}`, text: T[intent.smalltalk] });
    }

    // codes the customer wrote now, else the latest ones they mentioned earlier, else the product page's own
    const own = await this.catalog.resolveText(text);
    const ownKnown = own.filter((r) => r.kind !== 'unknown');
    let known = ownKnown;
    let fromContext = false;
    if (!known.length) {
      for (let i = input.userHistory.length - 1; i >= 0 && !known.length; i--) {
        known = (await this.catalog.resolveText(input.userHistory[i])).filter((r) => r.kind !== 'unknown');
      }
      if (!known.length && input.productCode) known = (await this.catalog.resolveText('', [input.productCode])).filter((r) => r.kind !== 'unknown');
      fromContext = known.length > 0;
    }

    if (input.hasImage) return this.toAi('photo', known, canRecommend);

    if (intent.troubleshoot) {
      if (!known.length) return answer({ intent: 'ask-code', text: T.askCode });
      const docsText = await this.knowledge.getContextForCodes(this.docCodes(known));
      if (!docsText) return escalate('troubleshoot', `Troubleshooting question about ${this.label(known)} with no guide on file: ${text}`);
      return this.toAi('troubleshoot', known, canRecommend, docsText);
    }

    if (intent.price) return escalate('price', `Price enquiry: ${text}`, T.priceEscalate);

    if (CARE.test(text) && !known.length) return this.generalTopic('care', 'Care & Maintenance', canRecommend, text);
    if (INSTALLER.test(text)) return this.generalTopic('installer', 'Authorised Installers', canRecommend, text);

    // a question about the product page the customer is on ("is this in stock?") vs a new search ("black levers in stock?")
    let discoverySignal = false;
    let parsed: ParsedQuery | null = null;
    if (!ownKnown.length) {
      parsed = await this.catalog.parse(text);
      discoverySignal = parsed.constraints.some((c) => !c.soft && c.facet !== 'finishDetail') || parsed.freeTokens.length > 0;
    }
    // a follow-up like "what escutcheon do I need?" is about the product already being discussed;
    // "do you have black levers in stock?" is a new search even if a product page is open
    const aboutContextProduct =
      fromContext && (CONTEXT_POINTER.test(text) || !discoverySignal || intent.compat || intent.drawing || intent.instructions || intent.template || intent.replacement);

    if (known.length && anyDeterministicCodeIntent(intent) && (ownKnown.length || aboutContextProduct)) {
      const outcome = await this.answerForCodes(known, intent, text, canRecommend);
      if (outcome) return outcome;
    }

    const unknownOwn = own.filter((r) => r.kind === 'unknown');
    if (!ownKnown.length && unknownOwn.length && anyDeterministicCodeIntent(intent) && !discoverySignal) {
      return answer({ intent: 'unknown-code', text: T.unknownCode(unknownOwn[0].token) });
    }

    if (ownKnown.length && isInfoLike(text, ownKnown.map((r) => r.token))) {
      return this.infoFor(known);
    }
    if (ownKnown.length) return this.toAi('product-question', known, canRecommend);

    if (parsed && discoverySignal) return this.discover(input, text, parsed, canRecommend);

    if (known.length) return this.toAi('product-question', known, canRecommend);

    // nothing to search, nothing to look up
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words <= 3 || text.length < 25) return answer({ intent: 'clarify', text: T.clarify });
    return escalate('unanswerable', text);
  }

  // --- deterministic answers about specific products ---------------------------------------

  private async answerForCodes(known: ResolvedCode[], intent: ReturnType<typeof classify>, text: string, canRecommend: boolean): Promise<RouterOutcome | null> {
    const keys = familyKeysOf(known);
    const label = this.label(known);
    const parts: Part[] = [];

    if (intent.stock) parts.push(await this.stockPart(known));
    if (intent.compat || intent.replacement) parts.push(await this.compatPart(known, intent.replacement));
    if (intent.drawing) {
      const links = await this.files.drawingsFor(keys);
      parts.push(links.length ? { text: `Here ${links.length > 1 ? 'are the drawings' : 'is the drawing'} for ${label}:`, links } : { missing: 'a drawing' });
    }
    if (intent.instructions || intent.template) {
      const [docs, templates] = await Promise.all([this.files.instructionsFor(this.docCodes(known), keys), this.files.drawingsFor(keys, { templates: true })]);
      const links = [...docs, ...templates.filter((l) => l.kind === 'template')];
      parts.push(links.length ? { text: `Here ${links.length > 1 ? 'are the installation documents' : 'is the installation document'} for ${label}:`, links } : { missing: 'installation instructions' });
    }

    const have = parts.filter((p) => !p.missing);
    const missing = parts.filter((p) => p.missing).map((p) => p.missing!);

    if (!have.length) {
      // only a compatibility question can still be answered from the manuals (the 9217 instructions name 43736)
      if (missing.length === 1 && missing[0] === 'compatibility data') {
        const docsText = await this.knowledge.getContextForCodes(this.docCodes(known));
        if (docsText) return this.toAi('compat-from-docs', known, canRecommend, docsText);
      }
      return escalate('missing-data', `Customer asked for ${missing.join(' and ')} for ${label}, none on file. Message: ${text}`, T.missingFile(missing.join(' and '), label));
    }

    const lines = have.map((p) => p.text).filter((t): t is string => !!t);
    if (missing.length) lines.push(`I couldn't find ${missing.join(' or ')} on file for ${label}.`);
    return answer({
      intent: this.intentName(intent),
      text: lines.join('\n'),
      cards: have.flatMap((p) => p.cards ?? []),
      links: have.flatMap((p) => p.links ?? []),
    });
  }

  private intentName(i: ReturnType<typeof classify>): string {
    return [i.stock && 'stock', (i.compat || i.replacement) && 'compat', i.drawing && 'drawing', (i.instructions || i.template) && 'instructions'].filter(Boolean).join('+');
  }

  private async stockPart(known: ResolvedCode[]): Promise<Part> {
    const targets = this.targets(known, MAX_STOCK_ITEMS);
    if (!targets.length) return { missing: 'stock information' };

    if (targets.length === 1) {
      const item = targets[0];
      if (item.status === 'Deleted') return this.discontinued(item);
      const r = await this.stock.check(item);
      const cards: ProductCard[] = [{ ...toCard(item), availability: r.availability, note: r.message ?? undefined }];
      let line = stockLine(shortName(item.name), item.code, r.availability, r.message);
      if (r.availability === 'sold_out') {
        const alt = (await this.catalog.relatedFor(item)).alternatives.slice(0, 3);
        if (alt.length) {
          cards.push(...alt.map((a) => ({ ...toCard(a), note: 'Alternative' })));
          line += ' These alternatives may help:';
        }
      }
      return { text: line, cards };
    }

    const results = await this.stock.checkMany(targets);
    const cards = targets.map((i) => {
      const r = results.get(i.code)!;
      return { ...toCard(i), availability: r.availability, note: r.message ?? undefined };
    });
    return { text: `Here's the live availability for ${this.label(known)}:`, cards };
  }

  private async discontinued(item: CatalogItem): Promise<Part> {
    const rel = await this.catalog.relatedFor(item);
    const next = (rel.replacedBy.length ? rel.replacedBy : rel.alternatives).slice(0, 3);
    return {
      text: `${shortName(item.name)} (${item.code}) has been discontinued.${next.length ? ' It has been replaced by:' : ''}`,
      cards: next.map((n) => ({ ...toCard(n), note: 'Replacement' })),
    };
  }

  private async compatPart(known: ResolvedCode[], replacement: boolean): Promise<Part> {
    const item = this.targets(known, 3).find((i) => i.relatedCodes.length || i.alternativeCodes.length || i.replacedByCodes.length || i.relatedText) ?? this.targets(known, 1)[0];
    if (!item) return { missing: 'compatibility data' };
    const rel = await this.catalog.relatedFor(item);
    const name = `${item.code}`;

    const replacements = [...rel.replacedBy, ...rel.alternatives].slice(0, 4);
    if (replacement && replacements.length) {
      return {
        text: rel.replacedBy.length ? `${name} has been replaced by:` : `Alternatives for ${name}:`,
        cards: replacements.map((r) => ({ ...toCard(r), note: rel.replacedBy.includes(r) ? 'Replacement' : 'Alternative' })),
      };
    }
    const matching = [...rel.forward, ...rel.backward].slice(0, 6);
    if (matching.length) {
      const cards = matching.map((m) => ({ ...toCard(m), note: 'Works with ' + name }));
      const alt = rel.alternatives.slice(0, 2).map((a) => ({ ...toCard(a), note: 'Alternative' }));
      return { text: `For ${name}, ${matching.length > 1 ? 'these products are listed as used with it' : 'the listed match is'}:`, cards: [...cards, ...alt] };
    }
    if (item.relatedText) return { text: `For ${name}, our product data says: "${item.relatedText}".` };
    if (replacements.length) {
      return { text: `${name} has these alternatives:`, cards: replacements.map((r) => ({ ...toCard(r), note: 'Alternative' })) };
    }
    return { missing: 'compatibility data' };
  }

  private async infoFor(known: ResolvedCode[]): Promise<RouterOutcome> {
    const targets = this.targets(known, 1);
    if (!targets.length) return this.toAi('product-question', known, true);
    const item = targets[0];
    const keys = familyKeysOf(known);
    const [variants, drawings, docs] = await Promise.all([
      item.familyKey ? this.catalog.familyMembers(item.familyKey) : Promise.resolve([]),
      this.files.drawingsFor(keys),
      this.files.instructionsFor(this.docCodes(known), keys),
    ]);
    if (item.status === 'Deleted') {
      const part = await this.discontinued(item);
      return answer({ intent: 'product-info', text: part.text!, cards: part.cards, links: [...drawings, ...docs] });
    }
    const facts = [item.finish, item.material, item.size].filter(Boolean).join(', ');
    return answer({
      intent: 'product-info',
      text: `${shortName(item.name)} (${item.code})${facts ? `: ${facts}` : ''}.`,
      cards: [toCard(item, variants.filter((v) => v !== item && v.status !== 'Deleted').slice(0, 6))],
      links: [...drawings, ...docs],
    });
  }

  // --- searching the catalog -----------------------------------------------------------------

  private async discover(input: RouterInput, text: string, parsedIn: ParsedQuery, canRecommend: boolean): Promise<RouterOutcome> {
    if (!canRecommend) return escalate('restricted-discovery', `Product-selection question on the technical support page: ${text}`, T.restrictedPage);

    let parsed = parsedIn;
    let result = await this.catalog.search(parsed);
    let translated: unknown = null;

    // words the dictionary doesn't know: let the AI translate them into filters (cheap, no product data sent)
    if (!result.cards.length || (parsed.unknownTokens.length > 0 && !result.exact)) {
      const extra = await this.translator.translate(text, parsed.unknownTokens);
      if (extra) {
        translated = extra.map((c) => `${c.facet}:${c.values[0]}`);
        const merged: ParsedQuery = {
          ...parsed,
          constraints: [...parsed.constraints, ...extra],
          unknownTokens: [],
          interpretation: [...new Set([...parsed.interpretation, ...extra.map((c) => c.label)])],
        };
        const better = await this.catalog.search(merged);
        if (better.cards.length && (better.exact || !result.cards.length)) {
          parsed = merged;
          result = better;
        }
      }
    }

    if (parsed.unknownTokens.length || !result.exact) {
      void this.catalog.logMiss({
        sessionId: input.sessionId,
        entryPoint: input.entryPoint,
        query: text,
        intent: 'discovery',
        unknownTokens: parsed.unknownTokens,
        constraints: parsed.constraints.map((c) => `${c.facet}:${c.values[0]}${c.soft ? '~' : ''}`),
        topCodes: result.topCodes,
        exact: result.exact,
        translated,
      });
    }

    if (!result.cards.length) return escalate('discovery-empty', `Customer is looking for: ${text}`);

    const links: LinkItem[] = result.moreUrl ? [{ kind: 'category', title: `See all in ${result.moreLabel}`, url: result.moreUrl }] : [];
    return answer({ intent: 'discovery', text: this.discoveryText(result), cards: result.cards, links });
  }

  private discoveryText(r: SearchResult): string {
    const what = r.interpretation.length ? ` (${r.interpretation.join(', ')})` : '';
    if (r.exact && r.exactCount >= r.cards.length) return `Here ${r.cards.length === 1 ? 'is a match' : 'are some options that match'}${what}:`;
    if (r.exact) return `Here ${r.exactCount === 1 ? 'is the best match' : 'are the best matches'}${what}, plus a few close options:`;
    return `I couldn't find an exact match${what ? ` for ${r.interpretation.join(', ')}` : ''}, but these are the closest options:`;
  }

  // --- helpers -------------------------------------------------------------------------------

  private async generalTopic(intent: string, titleLike: string, canRecommend: boolean, text: string): Promise<RouterOutcome> {
    const docsText = await this.knowledge.getGeneralContext(titleLike);
    if (!docsText) return escalate(intent, text);
    return { kind: 'ai', context: { intent, canRecommend, productFacts: '', docsText } };
  }

  private async toAi(intent: string, known: ResolvedCode[], canRecommend: boolean, docs?: string): Promise<RouterOutcome> {
    const docsText = docs ?? (known.length ? await this.knowledge.getContextForCodes(this.docCodes(known)) : '');
    return { kind: 'ai', context: { intent, canRecommend, productFacts: await this.factsFor(known), docsText } };
  }

  private async factsFor(known: ResolvedCode[]): Promise<string> {
    const items = this.targets(known, 4);
    const lines: string[] = [];
    for (const item of items) {
      const rel = await this.catalog.relatedFor(item);
      const family = item.familyKey ? (await this.catalog.familyMembers(item.familyKey)).filter((m) => m !== item && m.status !== 'Deleted').slice(0, 8) : [];
      lines.push(
        [
          `- ${item.name} (code ${item.code})`,
          item.category && `category: ${item.category}`,
          item.finish && `finish: ${item.finish}`,
          item.material && `material: ${item.material}`,
          item.size && `size: ${item.size}`,
          item.status && `status: ${item.status}`,
          item.features.length && `features: ${item.features.join('; ')}`,
          item.relatedText && `used in conjunction with: ${item.relatedText}`,
          rel.forward.length && `matching products: ${rel.forward.map((r) => `${r.code} ${shortName(r.name, 50)}`).join('; ')}`,
          rel.alternatives.length && `alternatives: ${rel.alternatives.map((r) => r.code).join(', ')}`,
          rel.replacedBy.length && `replaced by: ${rel.replacedBy.map((r) => r.code).join(', ')}`,
          family.length && `other finishes/variants: ${family.map((m) => `${m.code} (${m.finish ?? 'n/a'})`).join(', ')}`,
          item.productUrl && `link: ${item.productUrl}`,
        ]
          .filter(Boolean)
          .join(', '),
      );
    }
    return lines.join('\n');
  }

  /** real items behind what the customer wrote: the exact item, or the live members of a family */
  private targets(known: ResolvedCode[], limit: number): CatalogItem[] {
    const out: CatalogItem[] = [];
    for (const r of known) {
      const members = r.kind === 'exact' ? r.items : [...r.items].sort((a, b) => Number(b.status === 'Stock Item') - Number(a.status === 'Stock Item'));
      const live = members.filter((m) => m.status !== 'Deleted');
      out.push(...(live.length ? live : members));
    }
    return [...new Map(out.map((i) => [i.code, i])).values()].slice(0, limit);
  }

  private docCodes(known: ResolvedCode[]): string[] {
    const codes = new Set<string>();
    for (const r of known) {
      codes.add(r.token.replace(/^X/, ''));
      if (r.familyKey) codes.add(r.familyKey);
      r.items.forEach((i) => codes.add(i.code));
    }
    return [...codes];
  }

  private label(known: ResolvedCode[]): string {
    return known.slice(0, 3).map((r) => (r.kind === 'exact' ? r.items[0].code : r.token.toLowerCase())).join(', ');
  }
}
