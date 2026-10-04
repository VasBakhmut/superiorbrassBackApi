import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SupabaseService } from '../supabase/supabase.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { ProductsService } from '../knowledge/products.service.js';
import { DrawingsService } from '../knowledge/drawings.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { classifyError } from './chat-error.util.js';

const MODEL = 'gpt-4o-mini';
const NO_ANSWER_MARKER = 'NO_ANSWER';
const NO_ANSWER_FALLBACK_MESSAGE =
  "Sorry, I don't have a confident answer for that from our documentation. Could you share your email and product model so I can pass this to our support team?";

// sticky widget + product page can recommend/suggest products; the header "technical
// support" page stays strictly troubleshooting-only, per how the business wants each
// entry point to behave.
const RECOMMEND_CAPABLE_ENTRY_POINTS = new Set(['sticky_widget', 'product_page']);

function buildSystemPrompt(canRecommend: boolean): string {
  const base = `You are a helpful technical support and product assistant for an Australian architectural door hardware business (digital locks, handles, hinges and other door/window hardware). Speak naturally, like a helpful person, not a corporate script.

Rules:
- Answer ONLY using the "Context" provided below (SOPs, installation manuals, troubleshooting guides, and, when relevant, a product catalog snapshot). Never guess, and never use general knowledge about hardware that isn't in the context.
- Keep answers short, practical, step-by-step where relevant.
- The customer may attach a photo (of their existing hardware, or of their door). Look at it and use what you can actually see — the product type, finish, visible damage, mounting details — to inform your answer. If you can identify a product code or close match from the image, say so, but don't invent a code you can't actually read or infer with reasonable confidence.
- The troubleshooting context you're given is scoped to the product model mentioned in this conversation, and is built BEFORE you see the question — so if no model has been mentioned yet, model-specific documentation (e.g. troubleshooting for a specific fault) may simply be missing from your context even though it exists in our systems.
- If the context includes a "Product drawings" section, that's a direct answer when the customer asks for a technical drawing, dimensions, template, or spec sheet for a specific code — give them that exact link. If they ask for a drawing but no matching code appears in that section, ask them for the exact product code first (drawings are looked up by exact code only, there's no "closest match").`;

  const codeRule = canRecommend
    ? `- If the customer already owns a product and is troubleshooting an issue with it, and hasn't stated their product code/model anywhere in this conversation, ask which model they have before giving troubleshooting steps. Do NOT ask for a product code when the customer is instead asking you to help them choose/recommend a product they don't own yet — that's a normal, code-free request.`
    : `- For any troubleshooting or installation question, if the customer hasn't stated their product code/model anywhere in this conversation, your ENTIRE response must be one short question asking which model they have (e.g. "Which product/model is this — you'll usually find a code like 59405 on the lock or its box"). Do this every time, and do NOT use NO_ANSWER for this case.`;

  const recommendRule = canRecommend
    ? `- You can recommend products from the "Products" section below when the customer is choosing between options or describing what they need (e.g. a lock for a security door). If nothing in that section looks like a genuinely good fit, say so honestly instead of forcing a recommendation. The product catalog is a snapshot with no live pricing or stock — never state a price, and only describe stock as "showed as in stock in our last catalog update," pointing the customer to confirm before buying.
- When a product entry in "Products" includes a "link", always give that exact link to the customer when you mention that product by name or code — never say you can't provide one. When it includes "used in conjunction with", that's the exact answer for compatibility/accessory questions (e.g. "what escutcheon do I need with X") — use it directly instead of guessing a code.`
    : `- This channel is for troubleshooting and product problems only — don't recommend or upsell other products here, focus on resolving the issue the customer already has.`;

  return `${base}\n${codeRule}\n${recommendRule}\n- If the context does not contain enough information to answer confidently, respond with EXACTLY one line:\n${NO_ANSWER_MARKER}: <one sentence summarising what the customer is asking, for a human agent>\n  and nothing else.`;
}

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; needsEscalation: boolean; escalationSummary?: string; message?: string };

const MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pure smalltalk/greetings ("hi", "how are you") get a canned reply with no AI call at
// all — cheaper, instant, and sidesteps the model occasionally treating a bare "hi" as an
// unanswerable question and escalating it.
const GREETING_PATTERN =
  /^(hi+|hello+|hey+|hiya|howdy|yo|g'?day|good\s?(morning|afternoon|evening)|how'?s?\s?(it\s?goin['g]?|things?)|how\s?(are|r)\s?(you|u|ya)|what'?s\s?up|sup)[\s!?.,]*$/i;
const GREETING_REPLY = "Hi there! What can I help you with today?";

@Injectable()
export class ChatService {
  private readonly ai: OpenAI;

  constructor(
    config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly knowledge: KnowledgeService,
    private readonly products: ProductsService,
    private readonly drawings: DrawingsService,
  ) {
    this.ai = new OpenAI({ apiKey: config.getOrThrow<string>('OPENAI_API_KEY') });
  }

  async handleMessageStream(dto: SendMessageDto, onEvent: (e: ChatStreamEvent) => void): Promise<void> {
    const sessionId = dto.sessionId ?? (await this.createSession(dto.entryPoint));
    onEvent({ type: 'session', sessionId });

    const messageText = dto.message?.trim() || (dto.imageUrl ? '(customer attached a photo, no additional text)' : '');
    await this.saveMessage(sessionId, 'user', messageText, dto.imageUrl);

    if (!dto.imageUrl && GREETING_PATTERN.test(messageText)) {
      await this.saveMessage(sessionId, 'assistant', GREETING_REPLY);
      onEvent({ type: 'chunk', text: GREETING_REPLY });
      onEvent({ type: 'done', needsEscalation: false });
      return;
    }

    const history = await this.getHistory(sessionId);
    const conversationText = [dto.productCode, ...history.map((m) => m.content)].filter(Boolean).join('\n');
    const troubleshootingContext = await this.knowledge.getContextForConversation(conversationText);

    // Only the customer's own words (plus a known product code from the page), most recent
    // first — the bot's own prior replies ("could you tell me more about...") are full of
    // generic filler that crowds out what the customer actually said once there'd been a
    // few turns, and were previously drowning out real product codes in the keyword search.
    const userText = [dto.productCode, ...history.filter((m) => m.role === 'user').map((m) => m.content)]
      .filter(Boolean)
      .reverse()
      .join('\n');

    let context = troubleshootingContext;

    // Drawings are exact-code-only (see DrawingsService) and available on every entry point —
    // a request for a technical drawing isn't a "recommendation," so this isn't gated by
    // canRecommend. This never fires (and never hits the DB) unless a code-shaped token is
    // actually present in what the customer wrote.
    const drawings = await this.drawings.search(userText);
    if (drawings.length > 0) {
      context += `\n\nProduct drawings:\n${this.drawings.formatForPrompt(drawings)}`;
    }

    const canRecommend = RECOMMEND_CAPABLE_ENTRY_POINTS.has(dto.entryPoint ?? '');
    if (canRecommend) {
      const products = await this.products.search(userText);
      context += `\n\nProducts (catalog snapshot — no live price/stock):\n${this.products.formatForPrompt(products)}`;
    }

    const systemPrompt = buildSystemPrompt(canRecommend);

    const lastIndex = history.length - 1;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${systemPrompt}\n\nContext:\n${context}` },
      ...history.map((m, i): OpenAI.Chat.ChatCompletionMessageParam => {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        // Only re-attach the image on the turn it was actually uploaded (the last message
        // in history, since this is the current turn) — re-sending it on every later turn
        // would re-run (and re-bill) vision analysis on the same photo once per message for
        // the rest of the conversation. The model's own reply to it is the lasting record.
        if (!m.image_url || i !== lastIndex) return { role, content: m.content };
        // OpenAI accepts a plain image URL directly — no need to fetch/base64 it ourselves.
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.content },
            { type: 'image_url', image_url: { url: m.image_url } },
          ],
        };
      }),
    ];

    // Buffer until we know whether the reply starts with the NO_ANSWER marker, so we
    // never flash raw "NO_ANSWER: ..." text at the visitor before falling back.
    let full = '';
    let determined = false;
    let isNoAnswer = false;
    let chunkEmitted = false;
    const MARKER_PROBE_LEN = NO_ANSWER_MARKER.length + 1;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      full = '';
      determined = false;

      try {
        const stream = await this.ai.chat.completions.create({
          model: MODEL,
          messages,
          max_completion_tokens: 1024,
          stream: true,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (!delta) continue;
          full += delta;

          if (!determined) {
            if (full.length >= MARKER_PROBE_LEN) {
              determined = true;
              isNoAnswer = full.startsWith(NO_ANSWER_MARKER);
              if (!isNoAnswer) {
                onEvent({ type: 'chunk', text: full });
                chunkEmitted = true;
              }
            }
            continue;
          }
          if (!isNoAnswer) {
            onEvent({ type: 'chunk', text: delta });
            chunkEmitted = true;
          }
        }
        break; // this attempt completed successfully
      } catch (err) {
        // Overload/rate-limit errors are usually transient — silently retry once or
        // twice, but only while nothing has reached the visitor yet for this turn.
        const { code } = classifyError(err);
        const isTransient = code === 'UPSTREAM_ERROR' || code === 'RATE_LIMIT';
        if (!chunkEmitted && isTransient && attempt < MAX_ATTEMPTS) {
          await sleep(attempt * 1000);
          continue;
        }
        throw err;
      }
    }

    if (!determined) {
      isNoAnswer = full.startsWith(NO_ANSWER_MARKER);
      if (!isNoAnswer) onEvent({ type: 'chunk', text: full });
    }

    const text = full.trim();
    await this.saveMessage(sessionId, 'assistant', text);

    if (isNoAnswer) {
      const summary = text.slice(NO_ANSWER_MARKER.length).replace(/^:\s*/, '');
      onEvent({
        type: 'done',
        needsEscalation: true,
        escalationSummary: summary,
        message: NO_ANSWER_FALLBACK_MESSAGE,
      });
    } else {
      onEvent({ type: 'done', needsEscalation: false });
    }
  }

  async listProductCodes(): Promise<string[]> {
    const { data, error } = await this.supabase.client
      .from('documents')
      .select('product_codes')
      .eq('include_in_chat_context', true);
    if (error) throw error;

    const codes = new Set<string>();
    (data ?? []).forEach((d) => (d.product_codes ?? []).forEach((c: string) => codes.add(c)));
    return [...codes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  private async createSession(entryPoint?: string): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('chat_sessions')
      .insert({ entry_point: entryPoint ?? null })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  private async saveMessage(sessionId: string, role: 'user' | 'assistant', content: string, imageUrl?: string) {
    const { error } = await this.supabase.client
      .from('chat_messages')
      .insert({ session_id: sessionId, role, content, image_url: imageUrl ?? null });
    if (error) throw error;
  }

  private async getHistory(sessionId: string) {
    const { data, error } = await this.supabase.client
      .from('chat_messages')
      .select('role, content, image_url')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data as { role: 'user' | 'assistant' | 'system'; content: string; image_url: string | null }[];
  }

  async getTranscript(sessionId: string) {
    return this.getHistory(sessionId);
  }
}
