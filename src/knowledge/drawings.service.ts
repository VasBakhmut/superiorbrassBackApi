import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface DrawingMatch {
  code: string;
  title: string;
  category: string;
  pdfUrl: string;
}

// drawing codes are the site's own generic model codes (e.g. "x2300", "x9014-2") — a
// different namespace from sellable product codes, so this is deliberately not reused from
// products.service.ts.
const DRAWING_CODE_PATTERN = /\bx\d{3,6}(-\d+)?\b/gi;

@Injectable()
export class DrawingsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Exact-code-only lookup — no fuzzy fallback. A drawing is a specific technical document
   * for a specific model; there's no such thing as "a drawing that's a good fit," so unlike
   * products we never guess here. If the customer hasn't given a code, we return nothing and
   * let the system prompt tell the model to ask for one.
   */
  async search(conversationText: string, limit = 3): Promise<DrawingMatch[]> {
    const codes = [...new Set((conversationText.match(DRAWING_CODE_PATTERN) ?? []).map((c) => c.toLowerCase()))];
    if (codes.length === 0) return [];

    const { data, error } = await this.supabase.client
      .from('product_drawings')
      .select('code, title, category, pdf_url')
      .in('code', codes)
      .limit(limit);
    if (error) throw error;

    return (data ?? []).map((d) => ({
      code: d.code,
      title: d.title,
      category: d.category,
      pdfUrl: d.pdf_url,
    }));
  }

  formatForPrompt(matches: DrawingMatch[]): string {
    if (matches.length === 0) return '(no drawing found for the code(s) mentioned)';
    return matches.map((d) => `- ${d.title} (code ${d.code}, category: ${d.category}): ${d.pdfUrl}`).join('\n');
  }
}
