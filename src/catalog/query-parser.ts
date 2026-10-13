import type { Constraint, Facet, ParsedQuery } from './catalog.types.js';
import { type Concept, labelFor } from './concepts.js';
import { STOPWORDS, editDistance, stem, stemTokens, tokenize } from './text.js';

interface PhraseRef {
  facet: Facet;
  value: string;
  soft: boolean;
  term: string;
}

export interface ParserContext {
  phrases: Map<string, PhraseRef[]>;
  maxLen: number;
  /** every stemmed word that appears in the catalog, with how often */
  vocab: Map<string, number>;
}

export function buildParserContext(concepts: Concept[], vocab: Map<string, number>): ParserContext {
  const phrases = new Map<string, PhraseRef[]>();
  let maxLen = 1;
  for (const concept of concepts) {
    for (const term of concept.terms) {
      const words = stemTokens(term);
      if (!words.length) continue;
      maxLen = Math.max(maxLen, words.length);
      const key = words.join(' ');
      const list = phrases.get(key) ?? [];
      list.push({ facet: concept.facet, value: concept.value, soft: !!concept.soft, term });
      phrases.set(key, list);
    }
  }
  return { phrases, maxLen, vocab };
}

/** closest catalog word within a small edit distance, to forgive typos on either side */
function nearestWord(token: string, vocab: Map<string, number>): string | null {
  if (token.length < 5) return null;
  const max = token.length >= 9 ? 2 : 1;
  let best: string | null = null;
  let bestScore = -1;
  for (const [word, count] of vocab) {
    if (Math.abs(word.length - token.length) > max) continue;
    if (count > bestScore && editDistance(word, token, max) <= max) {
      best = word;
      bestScore = count;
    }
  }
  return best;
}

export function parseQuery(text: string, ctx: ParserContext): ParsedQuery {
  const toks = tokenize(text).map(stem);
  const consumed = new Array<boolean>(toks.length).fill(false);
  const constraints: Constraint[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < toks.length; ) {
    let matched = false;
    for (let len = Math.min(ctx.maxLen, toks.length - i); len >= 1; len--) {
      const refs = ctx.phrases.get(toks.slice(i, i + len).join(' '));
      if (!refs) continue;
      for (const ref of refs) {
        const key = `${ref.facet}:${ref.value}:${ref.soft}`;
        if (seen.has(key)) continue;
        seen.add(key);
        constraints.push({
          facet: ref.facet,
          values: [ref.value],
          soft: ref.soft,
          term: ref.term,
          label: labelFor(ref.facet, ref.value),
        });
      }
      for (let k = i; k < i + len; k++) consumed[k] = true;
      i += len;
      matched = true;
      break;
    }
    if (!matched) i++;
  }

  // specific beats generic: "316" makes "stainless" redundant, "lever" makes "handle" redundant
  const has = (facet: Facet, value: string) => constraints.some((c) => c.facet === facet && c.values[0] === value && !c.soft);
  const pruned = constraints.filter((c) => {
    if (c.soft) return true;
    if (c.facet === 'material' && c.values[0] === 'stainless' && (has('material', '316') || has('material', '304'))) return false;
    if (c.facet === 'type' && c.values[0] === 'handle' && (has('type', 'lever') || has('type', 'knob') || has('type', 'entry-handle'))) return false;
    if (c.facet === 'type' && c.values[0] === 'lock' && (has('type', 'digital-lock') || has('type', 'cylinder') || has('type', 'latch'))) return false;
    return true;
  });

  const freeTokens: string[] = [];
  const corrected: { from: string; to: string }[] = [];
  const unknownTokens: string[] = [];
  toks.forEach((t, i) => {
    if (consumed[i] || STOPWORDS.has(t) || t.length < 2) return;
    if (/^\d{4,}$/.test(t)) return; // codes are resolved elsewhere
    if (ctx.vocab.has(t)) {
      freeTokens.push(t);
      return;
    }
    const near = nearestWord(t, ctx.vocab);
    if (near) {
      corrected.push({ from: t, to: near });
      freeTokens.push(near);
    } else if (!/^\d/.test(t)) {
      unknownTokens.push(t);
    }
  });

  const hard = pruned.filter((c) => !c.soft && c.facet !== 'finishDetail');
  const details = pruned.filter((c) => c.facet === 'finishDetail').map((c) => c.label);
  const interpretation = [...new Set(hard.map((c) => c.label))];
  if (details.length && interpretation.length) interpretation.push(...details);

  return { constraints: pruned, freeTokens: [...new Set(freeTokens)], corrected, unknownTokens, interpretation };
}
