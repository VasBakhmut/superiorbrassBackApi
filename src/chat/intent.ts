// What the customer is asking for, decided by rules (no AI). Each flag is independent: a message
// can ask for a drawing and for stock at once.

export type Smalltalk = 'greeting' | 'thanks' | 'bye' | null;

export interface Intent {
  smalltalk: Smalltalk;
  troubleshoot: boolean;
  price: boolean;
  drawing: boolean;
  instructions: boolean;
  template: boolean;
  stock: boolean;
  compat: boolean;
  replacement: boolean;
  infoWords: boolean;
}

const GREETING =
  /^(hi+|hello+|hey+|hiya|howdy|yo|g'?day|good\s?(morning|afternoon|evening)|how'?s?\s?(it\s?goin['g]?|things?)|how\s?(are|r)\s?(you|u|ya)|what'?s\s?up|sup)[\s!?.,]*$/i;
const THANKS =
  /^(thanks?( you| a lot| so much| heaps| mate)?|thank you( so much| very much)?|thx|ty|cheers|much appreciated|(ok(ay)?|great|perfect|awesome|cool|brilliant|got it|sounds good|that helps|that'?s (great|perfect|helpful|all i needed))[,!. ]*( thanks?( you)?)?)[\s!?.,]*$/i;
const BYE =
  /^(bye+|goodbye|good ?night|see (you|ya)( later)?|cya|talk (soon|later)|that'?s (all|it)|no,? ?(that'?s|thats) (all|it)|nothing else|all good|have a (good|great|nice) (day|one)|no thanks?)[\s!?.,]*$/i;

const TROUBLE =
  /\b(not working|doesn'?t work|does not work|stopped working|won'?t|wont|can'?t|cant|cannot|stuck|jam(med|s)?|broken|faulty|fault|error|problem|issue|battery|batteries|drain\w*|reset|beep\w*|loose|noise|noisy|squeak\w*|rattl\w*|fail\w*|malfunction\w*|not (opening|closing|locking|unlocking|responding|connecting|pairing|latching|turning|retracting|detecting)|doesn'?t (open|close|lock|unlock|respond|connect|pair|latch|turn|retract|detect))\b/i;
const PRICE = /\b(price|prices|pricing|cost|how much|quote|rrp|discount|wholesale|trade price)\b/i;
const DRAWING = /\b(drawings?|dimensions?|outlines?|specs?|specifications?|data ?sheets?|cad|diagrams?|blueprints?|measurements?|technical (info|information|data|details))\b/i;
const INSTRUCTIONS = /\b(install(ation|ing|ed)?|instructions?|set-?up|routing|fitting (guide|instructions?)|how (do|to|can) (i|you|we)|mounting|manual)\b/i;
const TEMPLATE = /\b(templates?|routing)\b/i;
const STOCK =
  /\b(in stock|stock|availab\w*|do you (have|stock)|have you got|got any|have any|sold out|out of stock|how many|lead time|back ?order|when (will|can|do)|ready to (ship|buy))\b/i;
const COMPAT =
  /\b(compatible|compatibility|go(es)? with|work(s|ing)? with|used? with|use with|used in conjunction|in conjunction|suit(s)?|fit(s)?|match(es)?|accessor(y|ies)|pair(s|ed)? with|escutcheons?|snibs?)\b|\b(what|which)\b[^?.]*\b(need|use|require|get|work|fit|go|suit|match|pair)\b/i;
const REPLACEMENT = /\b(alternativ\w*|replac\w*|instead|successor|supersed\w*|discontinued|no longer|new version|updated version|equivalent)\b/i;
const INFO = /\b(tell me about|what is|what'?s|details?|information|info|describe|more about|about)\b/i;

export const normalize = (text: string) => text.replace(/[’‘`]/g, "'").trim();

export function classify(rawText: string): Intent {
  const text = normalize(rawText);
  let smalltalk: Smalltalk = null;
  if (GREETING.test(text)) smalltalk = 'greeting';
  else if (THANKS.test(text)) smalltalk = 'thanks';
  else if (BYE.test(text)) smalltalk = 'bye';

  return {
    smalltalk,
    troubleshoot: TROUBLE.test(text),
    price: PRICE.test(text),
    drawing: DRAWING.test(text),
    instructions: INSTRUCTIONS.test(text),
    template: TEMPLATE.test(text),
    stock: STOCK.test(text),
    compat: COMPAT.test(text),
    replacement: REPLACEMENT.test(text),
    infoWords: INFO.test(text),
  };
}

/** a bare code, or "tell me about 42300" — nothing else being asked */
export function isInfoLike(text: string, codeTokens: string[]): boolean {
  let rest = normalize(text).toLowerCase();
  for (const code of codeTokens) rest = rest.split(code.toLowerCase()).join(' ');
  const words = rest
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['tell', 'me', 'about', 'what', 'is', 'the', 'details', 'detail', 'info', 'information', 'on', 'for', 'of', 'a', 'this', 'that', 'please', 'show', 'more', 'item', 'product', 'code', 'whats', 'describe', 'x'].includes(w));
  return words.length === 0;
}

export const anyDeterministicCodeIntent = (i: Intent) => i.drawing || i.instructions || i.template || i.stock || i.compat || i.replacement;
