import type { LinkItem, ProductCard } from '../catalog/catalog.types.js';

const AVAILABILITY_LABEL: Record<string, string> = { in_stock: 'In Stock', sold_out: 'Sold Out' };

/**
 * The same answer as plain text with markdown links, for clients that don't declare they can draw
 * cards or link buttons (`clientFeatures`). Whatever the client can't draw is folded into the text.
 */
export function renderText(
  a: { text: string; cards?: ProductCard[]; links?: LinkItem[] },
  supports: { cards: boolean; links: boolean },
): string {
  const lines = [a.text];
  if (!supports.cards) {
    for (const c of a.cards ?? []) {
      const extra = [c.finish, c.availability ? AVAILABILITY_LABEL[c.availability] : c.note].filter(Boolean).join(', ');
      const label = `${c.name} (${c.code})`;
      lines.push(`- ${c.url ? `[${label}](${c.url})` : label}${extra ? `: ${extra}` : ''}`);
    }
  }
  if (!supports.links) {
    for (const l of a.links ?? []) lines.push(`- [${l.title}](${l.url})`);
  }
  return lines.join('\n');
}
