import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { CatalogService } from '../catalog/catalog.service.js';
import type { Constraint, Facet } from '../catalog/catalog.types.js';
import { labelFor } from '../catalog/concepts.js';

const MODEL = 'gpt-4o-mini';
const FACETS: Facet[] = ['type', 'material', 'finish', 'function', 'tag'];

/**
 * Fallback for words the built-in dictionary doesn't know. The model is asked only to turn the
 * customer's words into catalog filters (a few hundred tokens, no product data in the prompt),
 * and it can only pick values that really exist in the catalog. It never chooses products.
 */
@Injectable()
export class QueryTranslatorService {
  private readonly logger = new Logger(QueryTranslatorService.name);
  private readonly ai: OpenAI | null;
  private readonly enabled: boolean;

  constructor(config: ConfigService, private readonly catalog: CatalogService) {
    const key = config.get<string>('OPENAI_API_KEY');
    this.ai = key ? new OpenAI({ apiKey: key }) : null;
    this.enabled = (config.get<string>('AI_QUERY_TRANSLATION') ?? 'on') !== 'off';
  }

  async translate(query: string, unknownWords: string[]): Promise<Constraint[] | null> {
    if (!this.ai || !this.enabled) return null;
    try {
      const vocab = await this.catalog.vocabulary();
      const res = await this.ai.chat.completions.create(
        {
          model: MODEL,
          max_completion_tokens: 200,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You turn a customer\'s door-hardware request into catalog filters. You may use general knowledge of door hardware to understand what they mean (for example "marine grade" or "coastal" means 316 stainless steel). ' +
                'Reply with JSON only, in this shape: {"type":[],"material":[],"finish":[],"function":[],"tag":[]}. ' +
                'Use ONLY values from these lists and leave a list empty when unsure.\n' +
                `type: ${vocab.types.join(', ')}\nmaterial: ${vocab.materials.join(', ')}\nfinish: ${vocab.finishes.join(', ')}\nfunction: ${vocab.functions.join(', ')}\ntag: ${vocab.tags.join(', ')}`,
            },
            { role: 'user', content: `Request: ${query}\nWords the dictionary did not understand: ${unknownWords.join(', ') || 'none'}` },
          ],
        },
        { signal: AbortSignal.timeout(8000) },
      );

      const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as Record<string, unknown>;
      const allowed: Record<string, Set<string>> = {
        type: new Set(vocab.types), material: new Set(vocab.materials), finish: new Set(vocab.finishes),
        function: new Set(vocab.functions), tag: new Set(vocab.tags),
      };
      const out: Constraint[] = [];
      for (const facet of FACETS) {
        const values = Array.isArray(parsed[facet]) ? (parsed[facet] as unknown[]).map(String) : [];
        for (const value of values) {
          if (!allowed[facet].has(value)) continue; // the model may not invent filters
          out.push({ facet, values: [value], soft: false, term: 'ai', label: labelFor(facet, value) });
        }
      }
      return out.length ? out : null;
    } catch (err) {
      this.logger.warn(`query translation skipped: ${(err as Error).message}`);
      return null;
    }
  }
}
