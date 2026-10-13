// Words that carry no product meaning in a catalog question.
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'am', 'i', 'im', 'ive', 'id', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this',
  'that', 'these', 'those', 'there', 'here', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall',
  'may', 'might', 'have', 'has', 'had', 'get', 'got', 'need', 'needs', 'want', 'wants', 'looking', 'look', 'find',
  'finding', 'help', 'please', 'pls', 'thanks', 'thank', 'hi', 'hello', 'hey', 'some', 'any', 'something', 'anything',
  'one', 'ones', 'kind', 'sort', 'good', 'best', 'nice', 'great', 'which', 'what', 'whats', 'where', 'who', 'how',
  'when', 'why', 'about', 'tell', 'show', 'give', 'recommend', 'suggest', 'suitable', 'option', 'range', 'available',
  'product', 'item', 'drawing', 'spec', 'specification', 'code', 'model', 'like', 'also', 'just', 'really', 'very',
  'much', 'many', 'more', 'most', 'new', 'old', 'door', 'doors', 'set', 'sets', 'top', 'around', 'out', 'so', 'if',
  'but', 'not', 'no', 'yes', 'ok', 'okay', 'only', 'then', 'than', 'too', 'all', 'both', 'each', 'other', 'another',
  'make', 'made', 'use', 'used', 'using', 'buy', 'purchase', 'order', 'sell', 'sale', 'price', 'cost', 'house',
  'home', 'project', 'job', 'customer', 'supplier', 'us', 'am',
]);

/** Very small English stemmer: levers -> lever, hinges -> hinge, latches -> latch, handles -> handle. */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** lowercase alphanumeric tokens; "316SS" becomes "316" + "ss", "52mm" stays one token */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/(\d)(ss)\b/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export const stemTokens = (text: string) => tokenize(text).map(stem);

/** edit distance, giving up (returning max + 1) once it can no longer be <= max */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
