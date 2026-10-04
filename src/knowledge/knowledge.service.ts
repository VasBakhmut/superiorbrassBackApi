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
   * Builds chat context scoped ONLY to the product model(s) actually mentioned in the
   * conversation — no "general" fallback bucket. If no code is mentioned yet, this returns
   * nothing and costs nothing: the system prompt already makes the model ask which model the
   * customer has before it needs any document content, so there's nothing useful to send.
   *
   * Two DB round-trips on purpose: the first fetches only `product_codes` (cheap) to figure
   * out which docs are even relevant, and the second fetches `full_text` for just those rows
   * — we never pull text for a document the conversation didn't ask about.
   */
  async getContextForConversation(conversationText: string): Promise<string> {
    const { data: codeRows, error: codeError } = await this.supabase.client
      .from('documents')
      .select('product_codes')
      .eq('include_in_chat_context', true);
    if (codeError) throw codeError;

    const knownCodes = new Set((codeRows ?? []).flatMap((d) => d.product_codes ?? []));
    const mentionedCodes = [...knownCodes].filter((code) => new RegExp(`\\b${code}\\b`).test(conversationText));
    if (mentionedCodes.length === 0) return '';

    const { data, error } = await this.supabase.client
      .from('documents')
      .select('title, full_text, product_codes')
      .eq('include_in_chat_context', true)
      .overlaps('product_codes', mentionedCodes);
    if (error) throw error;

    return (data as DocRow[] ?? [])
      .filter((d) => d.full_text)
      .map((d) => `### ${d.title}\n${d.full_text}`)
      .join('\n\n---\n\n');
  }
}
