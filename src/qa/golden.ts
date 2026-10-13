/**
 * Golden questions: Daniel's own examples plus variations, run through the real router against
 * the real database (no AI calls). Run after any change to the search logic:
 *
 *   pnpm golden              all cases (the stock cases read live pages from the website)
 *   pnpm golden -- --no-stock   skip the cases that touch the website
 */
import 'dotenv/config';
import { CatalogService } from '../catalog/catalog.service.js';
import { TYPE_EXPANSION } from '../catalog/concepts.js';
import { FilesService } from '../catalog/files.service.js';
import { StockService } from '../catalog/stock.service.js';
import { QueryTranslatorService } from '../chat/query-translator.service.js';
import { AnswerRouter, type RouterOutcome } from '../chat/router.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';

process.env.AI_QUERY_TRANSLATION = 'off';
const cfg = { get: (k: string) => process.env[k], getOrThrow: (k: string) => process.env[k]! } as any;
const supabase = new SupabaseService(cfg);
const catalog = new CatalogService(supabase);
const router = new AnswerRouter(catalog, new StockService(), new FilesService(supabase), new KnowledgeService(supabase), new QueryTranslatorService(cfg, catalog));

const NO_STOCK = process.argv.includes('--no-stock');

interface Case {
  name: string;
  text: string;
  entryPoint?: string;
  productCode?: string;
  history?: string[];
  live?: boolean;
  check: (o: RouterOutcome, ctx: Ctx) => string | null | Promise<string | null>;
}
interface Ctx { cardItems: (code: string) => Promise<any> }

const answer = (o: RouterOutcome) => (o.kind === 'answer' ? o.answer : null);
const codes = (o: RouterOutcome) => (answer(o)?.cards ?? []).map((c) => c.code);
const must = (cond: boolean, msg: string) => (cond ? null : msg);

const cases: Case[] = [
  { name: 'greeting', text: 'Hi', check: (o) => must(answer(o)?.intent === 'smalltalk:greeting', 'not smalltalk') },
  { name: 'thanks', text: 'thanks!', check: (o) => must(answer(o)?.intent === 'smalltalk:thanks', 'not thanks') },

  // --- Daniel's four questions --------------------------------------------------------------
  { name: 'Q1 escutcheon for 49217', text: 'What escutcheons do I need with 49217?', check: (o) => must(codes(o).includes('43736'), `cards: ${codes(o)}`) },
  { name: 'Q1 same, black variant 59217', text: 'which escutcheon goes with 59217', check: (o) => must(codes(o).some((c) => c.endsWith('3736')), `cards: ${codes(o)}`) },
  { name: 'Q1 context from earlier message', text: 'what escutcheon do I need?', history: ['tell me about 49217'], check: (o) => must(codes(o).includes('43736'), `cards: ${codes(o)}`) },
  {
    name: 'Q2 marine grade stainless lever sets', text: "I'm looking for marine grade stainless steel lever sets",
    check: async (o, ctx) => {
      const items = await Promise.all(codes(o).map(ctx.cardItems));
      if (!answer(o)?.cards?.length) return 'no cards';
      return must(items.every((i) => i.facets.material === '316' && i.facets.type === 'lever'), `not all 316 levers: ${items.map((i) => `${i.code}:${i.facets.material}/${i.facets.type}`)}`);
    },
  },
  { name: 'Q3 stock 45108', text: 'is 45108 in stock?', live: true, check: (o) => must(answer(o)?.cards?.[0]?.code === '45108' && !!answer(o)?.cards?.[0]?.availability, 'no live availability on the card') },
  { name: 'Q4 drawing x2300', text: 'I need product drawing and specifications for x2300', check: (o) => must((answer(o)?.links ?? []).some((l) => l.kind === 'drawing'), 'no drawing link') },

  // --- the same idea in other words ----------------------------------------------------------
  ...[
    ['coastal door handles', 'handle'],
    ['rust proof lever handles', 'lever'],
    ['something for a beach house front door', null],
    ['salt water resistant hinges', 'hinge'],
    ['stainless steel hinges', 'hinge'],
    ['black cabinet knobs for the kitchen', 'cabinet-handle'],
    ['fire rated door locks', null],
    ['bathroom privacy lever set in chrome', 'lever'],
    ['brass door knockers', 'knocker'],
    ['316 stainless steel pull handles', 'entry-handle'],
    ['digital smart lock with fingerprint', 'digital-lock'],
    ['stainles steel levr handles', 'lever'],
    ['white door stops', 'door-stop'],
  ].map(([text, type]) => ({
    name: `discovery: ${text}`,
    text: text as string,
    check: async (o: RouterOutcome, ctx: Ctx): Promise<string | null> => {
      const a = answer(o);
      if (!a?.cards?.length) return `no cards (${o.kind}${o.kind === 'escalate' ? ': ' + o.intent : ''})`;
      if (!type) return null;
      const items = await Promise.all(codes(o).map(ctx.cardItems));
      const ok = TYPE_EXPANSION[type] ?? [type];
      // cards flagged "Close match" are the top-up the search adds when exact matches are few
      const exactCards = (a.cards ?? []).filter((c) => c.note !== 'Close match').map((c) => c.code);
      const off = items.filter((i) => exactCards.includes(i.code) && !ok.includes(i.facets.type));
      return must(off.length === 0, `off-type: ${off.map((i) => `${i.code}:${i.facets.type}`)}`);
    },
  })),

  // --- drawings, instructions, product info -----------------------------------------------------
  { name: 'drawing by finish code 42300', text: 'drawing for 42300', check: (o) => must((answer(o)?.links ?? []).some((l) => l.kind === 'drawing'), 'no drawing link') },
  { name: 'drawing for 49217 (history outline)', text: 'can I get the drawing for 49217', check: (o) => must((answer(o)?.links ?? []).some((l) => l.kind === 'drawing'), 'no drawing link') },
  { name: 'instructions 49217', text: 'installation instructions for 49217', check: (o) => must((answer(o)?.links ?? []).some((l) => l.kind === 'instructions'), `links: ${(answer(o)?.links ?? []).map((l) => l.kind)}`) },
  { name: 'template 9405', text: 'template for 59405', check: (o) => must((answer(o)?.links ?? []).length > 0, 'no links') },
  // instructions that cover a whole range (no product code in their name) must reach every product of that range
  ...[['42300', 'Austyle SS Round'], ['43541', 'Builders Choice'], ['53556', 'Knob Passage 73mm'], ['43670', 'Long Plate']].map(([code, doc]) => ({
    name: `range-wide instructions reach ${code} (${doc})`,
    text: `installation instructions for ${code}`,
    check: (o: RouterOutcome): string | null => must((answer(o)?.links ?? []).some((l) => l.kind === 'instructions' && l.title.includes(doc.split(' ')[0])), `links: ${(answer(o)?.links ?? []).map((l) => l.title)}`),
  })),
  { name: 'range-wide template reaches 43670', text: 'template for 43670', check: (o) => must((answer(o)?.links ?? []).some((l) => l.kind === 'template'), `links: ${(answer(o)?.links ?? []).map((l) => `${l.kind}:${l.title}`)}`) },
  { name: 'info by bare code', text: '42300', check: (o) => must(answer(o)?.intent === 'product-info' && answer(o)?.cards?.[0]?.code === '42300', `got ${o.kind}`) },
  { name: 'unknown code', text: 'is 99999 in stock', check: (o) => must(answer(o)?.intent === 'unknown-code', `got ${o.kind}`) },
  { name: 'discontinued item', text: 'is 9217 in stock', check: (o) => must(/discontinued/.test(answer(o)?.text ?? ''), `text: ${answer(o)?.text}`) },

  // --- what must NOT go to the AI, and what must --------------------------------------------------
  { name: 'problem without a code asks for the model', text: 'my lock battery drains fast', check: (o) => must(answer(o)?.intent === 'ask-code', `got ${o.kind}`) },
  { name: 'problem with a code goes to the AI with its documents', text: '59405 battery drains fast', check: (o) => must(o.kind === 'ai' && o.context.docsText.length > 0, `got ${o.kind}`) },
  { name: 'price goes to the team', text: 'how much is 42300', check: (o) => must(o.kind === 'escalate' && o.intent === 'price', `got ${o.kind}`) },
  { name: 'technical page declines product selection', text: 'I need black levers', entryPoint: 'technical_support_page', check: (o) => must(o.kind === 'escalate' && o.intent === 'restricted-discovery', `got ${o.kind}`) },
  { name: 'technical page still answers by code', text: 'drawing for x2300', entryPoint: 'technical_support_page', check: (o) => must((answer(o)?.links ?? []).length > 0, 'no links') },
  { name: 'product page context', text: 'is this in stock?', productCode: '42300', live: true, entryPoint: 'product_page', check: (o) => must(answer(o)?.cards?.[0]?.code === '42300', `got ${o.kind}`) },
  { name: 'care question', text: 'how do I clean my stainless steel handles', check: (o) => must(o.kind === 'ai' && o.context.intent === 'care', `got ${o.kind}/${(o as any).intent ?? (o as any).context?.intent}`) },
  { name: 'vague message', text: 'help', check: (o) => must(answer(o)?.intent === 'clarify', `got ${o.kind}`) },
  { name: 'unanswerable goes to a human without AI', text: 'what is the weather like in Melbourne today please', check: (o) => must(o.kind === 'escalate', `got ${o.kind}`) },
];

async function main() {
  const ctx: Ctx = { cardItems: async (code) => catalog.getByCode(code) };
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.live && NO_STOCK) { skipped++; continue; }
    const started = Date.now();
    let verdict: string | null;
    let outcome: RouterOutcome | null = null;
    try {
      outcome = await router.route({ text: c.text, userHistory: c.history ?? [], entryPoint: c.entryPoint ?? 'sticky_widget', productCode: c.productCode, hasImage: false, sessionId: 'golden' });
      verdict = await c.check(outcome, ctx);
    } catch (e) {
      verdict = `threw: ${(e as Error).message}`;
    }
    const a = outcome && answer(outcome);
    const shape = outcome ? (outcome.kind === 'answer' ? `${a!.intent} | ${a!.cards?.length ?? 0} cards ${(a!.cards ?? []).slice(0, 4).map((x) => x.code).join(',')} | ${a!.links?.length ?? 0} links` : outcome.kind === 'escalate' ? `escalate:${outcome.intent}` : `ai:${outcome.context.intent} docs=${outcome.context.docsText.length}`) : '';
    if (verdict) failed++;
    console.log(`${verdict ? 'FAIL' : 'ok  '}  ${c.name.padEnd(48)} ${String(Date.now() - started).padStart(5)}ms  ${shape}${verdict ? `\n        -> ${verdict}` : ''}`);
  }
  console.log(`\n${cases.length - skipped - failed} passed, ${failed} failed${skipped ? `, ${skipped} skipped (live)` : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
