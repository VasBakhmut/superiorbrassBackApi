import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';

interface DocRow {
  title: string;
  full_text: string | null;
  product_codes: string[] | null;
}

@Injectable()
export class KnowledgeService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Builds chat context scoped to the product model(s) mentioned in the conversation so far.
   * No extra LLM call needed: product codes are already tagged on each document (from the
   * source filename), so we just check whether any known code appears as a whole word in
   * the conversation text, and only include docs for that code plus the general ones
   * (docs with no product code, e.g. the troubleshooting brochure).
   */
  async getContextForConversation(conversationText: string): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('documents')
      .select('title, full_text, product_codes')
      .eq('include_in_chat_context', true);
    if (error) throw error;

    const docs = (data ?? []) as DocRow[];

    const knownCodes = new Set(docs.flatMap((d) => d.product_codes ?? []));
    const mentionedCodes = [...knownCodes].filter((code) =>
      new RegExp(`\\b${code}\\b`).test(conversationText),
    );

    const relevant = docs.filter((d) => {
      const codes = d.product_codes ?? [];
      return codes.length === 0 || codes.some((c) => mentionedCodes.includes(c));
    });

    return relevant
      .filter((d) => d.full_text)
      .map((d) => `### ${d.title}\n${d.full_text}`)
      .join('\n\n---\n\n');
  }
}
