// Fixed replies for everything the backend can answer itself. Short on purpose: the cards and
// links carry the detail.

export const T = {
  greeting: 'Hi there! What can I help you with today?',
  thanks: "You're welcome! Let me know if there's anything else I can help with.",
  bye: 'Thanks for stopping by. Have a great day!',
  askCode: "Which product or model is this? You'll usually find the code (like 59405) on the product or its box.",
  askCodeFor: (what: string) => `Which product code would you like ${what} for? For example 42300 or x2300.`,
  clarify:
    'Happy to help! Are you looking for a product, a drawing or installation instructions for a specific code, or help with something you already have? A product code (like 49217) helps me find it fast.',
  escalate:
    "I'd like to check that properly for you. Please leave your email and our team will get back to you as soon as possible.",
  priceEscalate: "Pricing isn't shown in the chat. Leave your email and our team will send you a quote.",
  missingFile: (what: string, label: string) =>
    `I don't have ${what} on file for ${label}. Leave your email and our team will get it to you as soon as possible.`,
  restrictedPage:
    "This page is for technical support on products you already have. For help choosing a product, leave your email and our team will point you to the right one.",
  unknownCode: (code: string) => `I couldn't find ${code} in our catalog. Could you double-check the code?`,
} as const;

export function stockLine(name: string, code: string, availability: string, message: string | null): string {
  const label = `${name} (${code})`;
  if (availability === 'in_stock') return `${label} is currently ${message ?? 'In Stock'} on our website.`;
  if (availability === 'sold_out') return `${label} is currently ${message ?? 'Sold Out'} on our website.`;
  if (availability === 'not_listed') return `${label} isn't listed on our website right now, so I can't check live availability for it.`;
  if (availability === 'unavailable') return `I couldn't reach the live stock check just now for ${label}. Please try again in a moment, or open the product page.`;
  return `The product page for ${label} doesn't show an availability line right now.`;
}

export const shortName = (name: string, max = 70) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);
