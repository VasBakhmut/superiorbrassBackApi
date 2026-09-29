import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { SupabaseService } from '../supabase/supabase.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { ProductsService } from '../knowledge/products.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { classifyError } from './chat-error.util.js';

const MODEL = 'gemini-3.6-flash';
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
- The troubleshooting context you're given is scoped to the product model mentioned in this conversation, and is built BEFORE you see the question — so if no model has been mentioned yet, model-specific documentation (e.g. troubleshooting for a specific fault) may simply be missing from your context even though it exists in our systems.`;

  const codeRule = canRecommend
    ? `- If the customer already owns a product and is troubleshooting an issue with it, and hasn't stated their product code/model anywhere in this conversation, ask which model they have before giving troubleshooting steps. Do NOT ask for a product code when the customer is instead asking you to help them choose/recommend a product they don't own yet — that's a normal, code-free request.`
    : `- For any troubleshooting or installation question, if the customer hasn't stated their product code/model anywhere in this conversation, your ENTIRE response must be one short question asking which model they have (e.g. "Which product/model is this — you'll usually find a code like 59405 on the lock or its box"). Do this every time, and do NOT use NO_ANSWER for this case.`;

  const recommendRule = canRecommend
    ? `- You can recommend products from the "Products" section below when the customer is choosing between options or describing what they need (e.g. a lock for a security door). If nothing in that section looks like a genuinely good fit, say so honestly instead of forcing a recommendation. The product catalog is a snapshot with no live pricing or stock — never state a price, and only describe stock as "showed as in stock in our last catalog update," pointing the customer to confirm before buying.`
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

@Injectable()
export class ChatService {
  private readonly ai: GoogleGenAI;

  constructor(
    config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly knowledge: KnowledgeService,
    private readonly products: ProductsService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: config.getOrThrow<string>('GEMINI_API_KEY') });
  }

  async handleMessageStream(dto: SendMessageDto, onEvent: (e: ChatStreamEvent) => void): Promise<void> {
    const sessionId = dto.sessionId ?? (await this.createSession(dto.entryPoint));
    onEvent({ type: 'session', sessionId });

    await this.saveMessage(sessionId, 'user', dto.message);

    const history = await this.getHistory(sessionId);
    const conversationText = [dto.productCode, ...history.map((m) => m.content)].filter(Boolean).join('\n');
    const troubleshootingContext = await this.knowledge.getContextForConversation(conversationText);

    const canRecommend = RECOMMEND_CAPABLE_ENTRY_POINTS.has(dto.entryPoint ?? '');
    let context = troubleshootingContext;
    if (canRecommend) {
      const products = await this.products.search(conversationText);
      context += `\n\nProducts (catalog snapshot — no live price/stock):\n${this.products.formatForPrompt(products)}`;
    }

    const systemPrompt = buildSystemPrompt(canRecommend);

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
        const stream = await this.ai.models.generateContentStream({
          model: MODEL,
          contents: history.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          config: {
            systemInstruction: `${systemPrompt}\n\nContext:\n${context}`,
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        });

        for await (const chunk of stream) {
          const delta = chunk.text ?? '';
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
        // Gemini overload/rate-limit errors are usually transient ("spikes in demand are
        // usually temporary" per Google's own message) — silently retry once or twice,
        // but only while nothing has reached the visitor yet for this turn.
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

  private async saveMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
    const { error } = await this.supabase.client
      .from('chat_messages')
      .insert({ session_id: sessionId, role, content });
    if (error) throw error;
  }

  private async getHistory(sessionId: string) {
    const { data, error } = await this.supabase.client
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data as { role: 'user' | 'assistant' | 'system'; content: string }[];
  }

  async getTranscript(sessionId: string) {
    return this.getHistory(sessionId);
  }
}
