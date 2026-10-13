import { classify, isInfoLike } from './intent.js';
import { parseStockHtml } from '../catalog/stock.service.js';

describe('intent', () => {
  it('recognises small talk only when it is the whole message', () => {
    expect(classify('Hi').smalltalk).toBe('greeting');
    expect(classify('thanks!').smalltalk).toBe('thanks');
    expect(classify('no, that’s all').smalltalk).toBe('bye');
    expect(classify('hi, do you have 42300 in stock').smalltalk).toBeNull();
  });
  it('reads Daniel’s questions', () => {
    expect(classify('What escutcheons do I need with 49217 ?').compat).toBe(true);
    expect(classify('is 45108 in stock?').stock).toBe(true);
    expect(classify('I need product drawing and specifications for x2300').drawing).toBe(true);
    expect(classify("I'm looking for marine grade stainless steel lever sets")).toMatchObject({ troubleshoot: false, compat: false, stock: false, drawing: false });
  });
  it('separates problems from product descriptions', () => {
    expect(classify('my lock battery drains fast').troubleshoot).toBe(true);
    expect(classify('the handle is loose').troubleshoot).toBe(true);
    expect(classify('rust proof lever handles').troubleshoot).toBe(false);
    expect(classify('digital lock with bluetooth and fingerprint').troubleshoot).toBe(false);
  });
  it('spots price questions and installation requests', () => {
    expect(classify('how much is 42300').price).toBe(true);
    expect(classify('installation instructions for 49217').instructions).toBe(true);
    expect(classify('template for 59405').template).toBe(true);
  });
  it('knows when a message is just a code', () => {
    expect(isInfoLike('42300', ['42300'])).toBe(true);
    expect(isInfoLike('tell me about 42300', ['42300'])).toBe(true);
    expect(isInfoLike('does 59405 support fingerprint', ['59405'])).toBe(false);
  });
});

describe('reading stock from the product page', () => {
  const page = (msg: string, code = '42300') =>
    `<p class="product-code"><strong>Product Code: </strong>${code}</p><p class="InStockMessage" id="stockMessage_1">${msg} <i class="fas fa-check-circle"></i></p>`;
  it('reads In Stock and Sold Out', () => {
    expect(parseStockHtml(page('In Stock'))).toMatchObject({ availability: 'in_stock', message: 'In Stock', code: '42300' });
    expect(parseStockHtml(page('Sold Out'))).toMatchObject({ availability: 'sold_out' });
  });
  it('says unknown when the page has no availability line', () => {
    expect(parseStockHtml('<p class="product-code"><strong>Product Code: </strong>1</p>').availability).toBe('unknown');
  });
});
