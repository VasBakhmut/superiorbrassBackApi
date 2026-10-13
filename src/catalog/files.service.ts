import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service.js';
import type { LinkItem } from './catalog.types.js';

interface DrawingRow {
  code: string;
  title: string;
  pdf_url: string;
  source: string | null;
  kind: string;
  is_history: boolean;
  family_keys: string[] | null;
  product_code: string | null;
  product_name: string | null;
}

const cleanTitle = (t: string) => t.replace(/-\d+$/, '').replace(/\s+/g, ' ').trim();

/**
 * Drawings, templates and installation instructions, found by product family so that the
 * drawing for x2300 / 2300 / 42300 is the same file, whichever way the customer writes it.
 */
@Injectable()
export class FilesService {
  constructor(private readonly supabase: SupabaseService) {}

  async drawingsFor(familyKeys: string[], opts: { templates?: boolean } = {}): Promise<LinkItem[]> {
    if (!familyKeys.length) return [];
    const { data, error } = await this.supabase.client
      .from('product_drawings')
      .select('code, title, pdf_url, source, kind, is_history, family_keys, product_code, product_name')
      .overlaps('family_keys', familyKeys);
    if (error) throw error;
    const rows = (data ?? []) as DrawingRow[];

    const links: LinkItem[] = [];
    for (const key of familyKeys) {
      const mine = rows.filter((r) => (r.family_keys ?? []).includes(key));
      const outlines = mine.filter((r) => r.kind === 'outline');
      // prefer the manufacturer's own drawing, current over history, and never list both sources
      const official = outlines.filter((r) => r.source === 'daniel-2026-10' && !r.is_history);
      const chosen = official.length ? official : outlines.filter((r) => !r.is_history).length ? outlines.filter((r) => !r.is_history) : outlines;
      const seen = new Set<string>();
      for (const r of chosen.slice(0, 4)) {
        if (seen.has(r.pdf_url)) continue;
        seen.add(r.pdf_url);
        links.push({
          kind: 'drawing',
          code: r.product_code ?? key,
          title: `Drawing: ${cleanTitle(r.title)}`,
          url: r.pdf_url,
        });
      }
      if (opts.templates) {
        for (const r of mine.filter((m) => m.kind === 'template' && !m.is_history).slice(0, 3)) {
          links.push({ kind: 'template', code: r.product_code ?? key, title: `Template: ${cleanTitle(r.title)}`, url: r.pdf_url });
        }
      }
    }
    return links;
  }

  async instructionsFor(codes: string[], familyKeys: string[]): Promise<LinkItem[]> {
    if (!codes.length && !familyKeys.length) return [];
    const filters: string[] = [];
    if (codes.length) filters.push(`product_codes.ov.{${codes.map((c) => `"${c}"`).join(',')}}`);
    if (familyKeys.length) filters.push(`family_keys.ov.{${familyKeys.map((c) => `"${c}"`).join(',')}}`);
    const { data, error } = await this.supabase.client
      .from('documents')
      .select('title, file_url')
      .eq('include_in_chat_context', true)
      .not('file_url', 'is', null)
      .or(filters.join(','));
    if (error) throw error;
    return (data ?? []).map((d) => ({ kind: 'instructions' as const, title: cleanTitle(d.title), url: d.file_url as string }));
  }
}
