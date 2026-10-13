import type { Facet } from './catalog.types.js';

/**
 * Customer words -> catalog facts. This is the built-in starting dictionary; rows in the
 * `search_synonyms` table are merged on top of it, so new words can be added as data.
 * Phrases are matched after stemming, longest phrase first ("fire rated" before "fire").
 */
export interface Concept {
  terms: string[];
  facet: Facet;
  value: string;
  /** adds to the ranking but is not required for a result to count as an exact match */
  soft?: boolean;
}

const c = (facet: Facet, value: string, terms: string[], soft = false): Concept => ({ facet, value, terms, soft });

export const DEFAULT_CONCEPTS: Concept[] = [
  // --- material -------------------------------------------------------------------------
  c('material', '316', [
    '316', '316 stainless', '316 stainless steel', 'marine', 'marine grade', 'marine quality', 'maring', 'maring grade',
    'coastal', 'coast', 'salt water', 'saltwater', 'salt air', 'seaside', 'beach', 'beachfront', 'ocean', 'sea', 'pool',
    'rustproof', 'rust proof', 'rust resistant', 'corrosion', 'corrosion resistant', 'anti corrosion', 'harsh environment',
  ]),
  c('material', '304', ['304', '304 stainless', '304 stainless steel']),
  c('material', 'stainless', ['stainless', 'stainless steel', 'steel', 'inox']),
  c('material', 'brass', ['brass', 'solid brass']),
  c('material', 'zinc', ['zinc', 'zinc alloy']),
  c('material', 'iron', ['iron', 'cast iron', 'wrought iron']),
  c('material', 'aluminium', ['aluminium', 'aluminum']),
  c('material', 'porcelain', ['porcelain', 'ceramic']),
  c('material', 'timber', ['timber', 'wood', 'wooden']),
  c('material', 'glass', ['glass']),
  c('material', '316', ['outdoor', 'outside', 'exterior', 'external', 'weatherproof', 'weather resistant', 'weather'], true),
  c('material', 'stainless', ['outdoor', 'outside', 'exterior', 'external', 'weatherproof', 'weather resistant', 'weather'], true),

  // --- finish ---------------------------------------------------------------------------
  c('finish', 'chrome', ['chrome', 'chromed']),
  c('finish', 'black', ['black', 'matt black', 'matte black', 'matt', 'matte']),
  c('finish', 'white', ['white']),
  c('finish', 'white', ['ivory']),
  c('finish', 'brass', ['gold', 'golden', 'brass finish']),
  c('finish', 'copper', ['copper', 'antique copper']),
  c('finish', 'bronze', ['bronze']),
  c('finish', 'graphite', ['graphite', 'gunmetal', 'gun metal']),
  c('finish', 'pewter', ['pewter']),
  c('finish', 'silver', ['silver']),
  c('finish', 'stainless', ['satin stainless', 'polished stainless']),
  c('finishDetail', 'satin', ['satin', 'brushed']),
  c('finishDetail', 'polished', ['polished', 'shiny', 'mirror']),
  c('finishDetail', 'pvd', ['pvd', 'anti tarnish', 'anti tarnish brass', 'tarnish free']),
  c('finishDetail', 'antique', ['antique', 'vintage finish', 'aged']),
  c('finishDetail', 'gloss', ['gloss', 'glossy']),

  // --- type ------------------------------------------------------------------------------
  c('type', 'lever', ['lever', 'lever handle', 'lever set', 'door lever', 'lever door handle', 'levers']),
  c('type', 'knob', ['knob', 'door knob', 'doorknob', 'round knob']),
  c('type', 'handle', ['handle', 'door handle', 'handles', 'handle set']),
  c('type', 'hinge', ['hinge', 'butt hinge', 'door hinge', 'hinges']),
  c('type', 'escutcheon', ['escutcheon', 'key plate', 'keyhole cover', 'cylinder cover']),
  c('type', 'snib', ['snib', 'privacy snib', 'turn snib']),
  c('type', 'cylinder', ['cylinder', 'euro cylinder', 'key cylinder', 'barrel key']),
  c('type', 'latch', ['latch', 'passage latch', 'door latch']),
  c('type', 'lock', ['lock', 'deadbolt', 'dead bolt', 'deadlock', 'dead lock', 'mortice lock', 'mortise lock', 'entrance lock', 'security lock', 'sash lock', 'door lock']),
  c('type', 'bolt', ['bolt', 'barrel bolt', 'flush bolt', 'door bolt', 'panic bolt', 'tower bolt', 'tubular bolt']),
  c('type', 'entry-handle', ['entry handle', 'entry pull', 'entry pull handle', 'door pull', 'pull handle', 'front door handle', 'pivot handle', 'entrance handle', 'big handle', 'pull']),
  c('type', 'cabinet-handle', ['cabinet handle', 'cupboard handle', 'drawer pull', 'drawer handle', 'cabinet knob', 'cupboard knob', 'kitchen handle', 'kitchen cabinet', 'wardrobe handle', 'cabinet pull', 'cupboard pull', 'drawer knob', 'cabinet']),
  c('type', 'flush-pull', ['flush pull', 'sliding door pull', 'cavity slider pull', 'recessed pull']),
  c('type', 'door-stop', ['door stop', 'doorstop', 'door stopper', 'stopper', 'door catch', 'door holder', 'wedge']),
  c('type', 'hook', ['hook', 'coat hook', 'hat hook', 'towel hook', 'robe hook']),
  c('type', 'castor', ['castor', 'caster', 'wheel']),
  c('type', 'letter-box', ['letterbox', 'letter box', 'mailbox', 'mail box', 'letter plate', 'letter slot', 'mail slot']),
  c('type', 'numeral', ['numeral', 'number', 'house number', 'door number', 'numbers']),
  c('type', 'letter', ['alphabet', 'letter', 'house letter']),
  c('type', 'knocker', ['knocker', 'door knocker']),
  c('type', 'digital-lock', ['digital', 'digital lock', 'smart lock', 'smart', 'bluetooth', 'fingerprint', 'finger print', 'keyless', 'pin code', 'keypad', 'electronic lock', 'wifi', 'electronic']),
  c('type', 'window-fitting', ['window', 'sash lift', 'casement stay', 'window stay', 'window fastener', 'sash fastener', 'window latch']),
  c('type', 'push-plate', ['push plate', 'finger plate', 'kick plate']),
  c('type', 'bracket', ['shelf bracket', 'bracket', 'shelf']),
  c('type', 'gate', ['gate', 'gate latch', 'gate hardware']),
  c('type', 'bell', ['bell', 'ship bell', 'door bell']),
  c('type', 'curtain', ['curtain', 'curtain rod', 'curtain fitting']),
  c('type', 'sign', ['sign', 'plaque']),

  // --- function ---------------------------------------------------------------------------
  c('function', 'passage', ['passage', 'hallway', 'interior door', 'internal door', 'interior', 'internal']),
  c('function', 'privacy', ['privacy', 'bathroom', 'toilet', 'wc', 'ensuite', 'bedroom']),
  c('function', 'entrance', ['entrance', 'entry door', 'front door', 'external door', 'exterior door', 'main door', 'entry']),
  c('function', 'dummy', ['dummy', 'fixed handle', 'non turning']),
  c('function', 'sliding', ['sliding', 'slider', 'cavity', 'barn']),
  c('function', 'pivot', ['pivot']),

  // --- tag --------------------------------------------------------------------------------
  c('tag', 'fire-rated', ['fire rated', 'fire rating', 'fire door', 'fire', 'fire resistant']),
  c('tag', 'dda', ['dda', 'disability', 'disabled', 'accessible', 'ada']),
  c('tag', 'left-hand', ['left hand', 'lh']),
  c('tag', 'right-hand', ['right hand', 'rh']),
  c('tag', 'keyed-alike', ['keyed alike', 'key alike']),
  c('tag', 'mylock', ['mylock', 'my lock']),
  c('tag', 'concealed-fix', ['concealed fix', 'concealed fixing', 'hidden fixing', 'no visible screws']),
  c('tag', 'marine', ['marine', 'maring', 'marine grade', 'maring grade'], true),

  // --- brand ------------------------------------------------------------------------------
  c('brand', 'Austyle', ['austyle']),
  c('brand', 'Superior Brass', ['superior brass', 'superior']),
  c('brand', 'Builders Choice', ['builders choice', 'builder choice', 'builders']),
];

/** a generic customer word covers several concrete catalog types */
export const TYPE_EXPANSION: Record<string, string[]> = {
  handle: ['lever', 'knob', 'handle'],
  lock: ['lock', 'latch', 'digital-lock'],
  'entry-handle': ['entry-handle'],
};

/** "stainless" accepts any stainless grade; "316" accepts only 316 */
export const MATERIAL_EXPANSION: Record<string, string[]> = {
  stainless: ['316', '304', 'stainless', 'steel'],
  '316': ['316'],
  '304': ['304'],
};

export const TYPE_LABEL: Record<string, string> = {
  lever: 'lever sets', knob: 'knobs', handle: 'door handles', hinge: 'hinges', escutcheon: 'escutcheons',
  snib: 'snibs', cylinder: 'cylinders', latch: 'latches', lock: 'locks', bolt: 'bolts',
  'entry-handle': 'entry pull handles', 'cabinet-handle': 'cabinet handles', 'flush-pull': 'flush pulls',
  'door-stop': 'door stops', hook: 'hooks', castor: 'castors', 'letter-box': 'letter box hardware',
  numeral: 'house numbers', letter: 'letters', knocker: 'door knockers', 'digital-lock': 'digital smart locks',
  'window-fitting': 'window fittings', 'push-plate': 'push plates', bracket: 'brackets', gate: 'gate hardware',
  bell: 'bells', curtain: 'curtain fittings', sign: 'signs',
};

export const MATERIAL_LABEL: Record<string, string> = {
  '316': '316 marine-grade stainless steel', '304': '304 stainless steel', stainless: 'stainless steel',
  brass: 'solid brass', zinc: 'zinc alloy', iron: 'iron', aluminium: 'aluminium', porcelain: 'porcelain',
  timber: 'timber', glass: 'glass',
};

export const FINISH_LABEL: Record<string, string> = {
  chrome: 'chrome', black: 'black', white: 'white', brass: 'brass finish', copper: 'copper', bronze: 'bronze',
  graphite: 'graphite', pewter: 'pewter', silver: 'silver', stainless: 'stainless steel finish',
};

export function labelFor(facet: Facet, value: string): string {
  if (facet === 'type') return TYPE_LABEL[value] ?? value;
  if (facet === 'material') return MATERIAL_LABEL[value] ?? value;
  if (facet === 'finish') return FINISH_LABEL[value] ?? value;
  if (facet === 'function') return `${value} function`;
  if (facet === 'tag') return value.replace('-', ' ');
  if (facet === 'finishDetail') return value;
  return value;
}
