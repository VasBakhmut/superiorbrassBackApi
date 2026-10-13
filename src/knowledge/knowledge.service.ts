import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';

interface DocRow {
  title: string;
  full_text: string | null;
  file_url: string | null;
  source_type: string;
}

// keeps one product's documents from swamping the prompt (and the token bill)
const MAX_DOC_CHARS = 8000;
const MAX_TOTAL_CHARS = 20000;

@Injectable()
export class KnowledgeService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Text of the manuals/SOPs/instructions that belong to the given product codes (already
   * expanded to every code of the family when the documents were loaded). Nothing is returned
   * for codes without documents, and identical copies of the same document are sent once.
   */
  async getContextForCodes(codes: string[]): Promise<string> {
    if (!codes.length) return '';
    const { data, error } = await this.supabase.client
      .from('documents')
      .select('title, full_text, file_url, source_type')
      .eq('include_in_chat_context', true)
      .overlaps('product_codes', codes);
    if (error) throw error;

    const seen = new Set<string>();
    const docs = ((data ?? []) as DocRow[])
      .filter((d) => d.full_text)
      .sort((a, b) => Number(b.source_type === 'sop') - Number(a.source_type === 'sop') || Number(!!b.file_url) - Number(!!a.file_url))
      .filter((d) => {
        const hash = createHash('sha1').update(d.full_text!.replace(/\s+/g, ' ').trim()).digest('hex');
        if (seen.has(hash)) return false;
        seen.add(hash);
        return true;
      });

    let total = 0;
    const parts: string[] = [];
    for (const d of docs) {
      const text = d.full_text!.slice(0, MAX_DOC_CHARS);
      if (total + text.length > MAX_TOTAL_CHARS) break;
      total += text.length;
      parts.push(`### ${d.title}${d.file_url ? ` (file: ${d.file_url})` : ''}\n${text}`);
    }
    return parts.join('\n\n---\n\n');
  }

  /** documents that belong to no particular product (care & maintenance, authorised installers) */
  async getGeneralContext(titleLike: string): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('documents')
      .select('title, full_text')
      .eq('include_in_chat_context', true)
      .eq('product_codes', '{}')
      .ilike('title', `%${titleLike}%`);
    if (error) throw error;
    return (data ?? [])
      .filter((d) => d.full_text)
      .map((d) => `### ${d.title}\n${String(d.full_text).slice(0, MAX_DOC_CHARS)}`)
      .join('\n\n---\n\n');
  }
}
