import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { LinkItem, ProductCard } from '../catalog/catalog.types.js';
import { SupabaseService } from '../supabase/supabase.service.js';
import { classifyError } from './chat-error.util.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { renderText } from './render.js';
import { type AiContext, AnswerRouter, type RoutedAnswer } from './router.service.js';
import { T } from './templates.js';

const MODEL = 'gpt-4o-mini';
const NO_ANSWER_MARKER = 'NO_ANSWER';
const MAX_ATTEMPTS = 3;

/**
 * Prompt for the part of the conversation the backend could not answer by rules. The model may
 * use general knowledge to understand the customer ("marine grade" = 316 stainless) but every
 * fact about our products has to come from the Context.
 */
function buildSystemPrompt(canRecommend: boolean): string {
  return `You are a friendly, knowledgeable support assistant for an Australian architectural door hardware business (Austyle, Superior Brass and Builders Choice: digital locks, handles, hinges and other door and window hardware). Speak naturally and keep answers short and practical, step by step where that helps.

How to use what you know:
- You may use your general knowledge of door hardware to understand what the customer means or to explain something simply (for example that "marine grade" stainless steel means 316).
- Every fact about OUR products (codes, links, compatibility, finishes, instructions) must come from the "Context" below. Never invent a product code, a link or a specification, and never state a price.
- Give links exactly as they appear in the Context, as markdown links.
- Stock changes by the hour and the system checks it live whenever the customer gives a product code, so never state availability yourself. If they ask about stock without a code, ask for the product code.
- The customer may attach a photo of their hardware or door. Use what you can actually see (product type, finish, visible damage, mounting) and, if you can identify a product code or close match, say so, but never invent a code you cannot read or infer with reasonable confidence.
- For troubleshooting, work from the documents in the Context. If the documents don't cover the problem, say so plainly instead of guessing.
${canRecommend ? '- You may suggest products that appear in the Context.' : '- This channel is for technical support only: do not recommend or upsell products.'}
- If you cannot help properly from the Context, reply with EXACTLY one line:
${NO_ANSWER_MARKER}: <one sentence summarising what the customer is asking, for a human agent>
  and nothing else. Never tell the customer to "check with your supplier".`;
}

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'chunk'; text: string }
  | { type: 'cards'; items: ProductCard[] }
  | { type: 'links'; items: LinkItem[] }
  | {
      type: 'done';
      needsEscalation: boolean;
      escalationSummary?: string;
      message?: string;
      /** who produced the reply: our own rules or the AI */
      source?: 'rules' | 'ai';
      intent?: string;
    };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MessageMeta {
  source: 'rules' | 'ai';
  intent: string;
  cards?: ProductCard[];
  links?: LinkItem[];
  escalation?: { summary: string };
}

@Injectable()
export class ChatService {
  private readonly ai: OpenAI;

  constructor(
    config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly router: AnswerRouter,
  ) {
    this.ai = new OpenAI({ apiKey: config.getOrThrow<string>('OPENAI_API_KEY') });
  }

  async handleMessageStream(dto: SendMessageDto, onEvent: (e: ChatStreamEvent) => void): Promise<void> {
    const sessionId = dto.sessionId ?? (await this.createSession(dto.entryPoint));
    onEvent({ type: 'session', sessionId });

    const messageText = dto.message?.trim() || (dto.imageUrl ? '(customer attached a photo, no additional text)' : '');
    await this.saveMessage(sessionId, 'user', messageText, dto.imageUrl);

    const history = await this.getHistory(sessionId);
    const userHistory = history.filter((m) => m.role === 'user').map((m) => m.content).slice(0, -1);

    const outcome = await this.router.route({
      text: messageText,
      userHistory,
      entryPoint: dto.entryPoint,
      productCode: dto.productCode,
      hasImage: !!dto.imageUrl,
      sessionId,
    });

    if (outcome.kind === 'answer') {
      await this.sendAnswer(sessionId, outcome.answer, new Set(dto.clientFeatures ?? []), onEvent);
      return;
    }

    if (outcome.kind === 'escalate') {
      await this.saveMessage(sessionId, 'assistant', outcome.message, undefined, {
        source: 'rules',
        intent: outcome.intent,
        escalation: { summary: outcome.summary },
      });
      onEvent({ type: 'done', needsEscalation: true, escalationSummary: outcome.summary, message: outcome.message, source: 'rules', intent: outcome.intent });
      return;
    }

    await this.answerWithAi(sessionId, history, outcome.context, onEvent);
  }

  private async sendAnswer(sessionId: string, a: RoutedAnswer, features: Set<string>, onEvent: (e: ChatStreamEvent) => void) {
    const supports = { cards: features.has('cards'), links: features.has('links') };
    const text = renderText(a, supports);
    await this.saveMessage(sessionId, 'assistant', text, undefined, { source: 'rules', intent: a.intent, cards: a.cards, links: a.links });
    onEvent({ type: 'chunk', text });
    if (supports.cards && a.cards?.length) onEvent({ type: 'cards', items: a.cards });
    if (supports.links && a.links?.length) onEvent({ type: 'links', items: a.links });
    onEvent({ type: 'done', needsEscalation: false, source: 'rules', intent: a.intent });
  }

  private async answerWithAi(
    sessionId: string,
    history: { role: 'user' | 'assistant' | 'system'; content: string; image_url: string | null }[],
    ctx: AiContext,
    onEvent: (e: ChatStreamEvent) => void,
  ) {
    const context = [
      ctx.productFacts && `Products the customer is asking about:\n${ctx.productFacts}`,
      ctx.docsText && `Documents:\n${ctx.docsText}`,
    ]
      .filter(Boolean)
      .join('\n\n') || '(no product or document data matched this question)';

    const lastIndex = history.length - 1;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${buildSystemPrompt(ctx.canRecommend)}\n\nContext:\n${context}` },
      ...history.map((m, i): OpenAI.Chat.ChatCompletionMessageParam => {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        // Only re-attach the image on the turn it was actually uploaded (the last message in
        // history): re-sending it on every later turn would re-run, and re-bill, vision analysis
        // on the same photo for the rest of the conversation. The model's own reply is the record.
        if (!m.image_url || i !== lastIndex) return { role, content: m.content };
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
        break;
      } catch (err) {
        // Overload/rate-limit errors are usually transient: retry, but only while nothing has
        // reached the visitor yet for this turn.
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
    if (isNoAnswer) {
      const summary = text.slice(NO_ANSWER_MARKER.length).replace(/^:\s*/, '');
      await this.saveMessage(sessionId, 'assistant', T.escalate, undefined, { source: 'ai', intent: ctx.intent, escalation: { summary } });
      onEvent({ type: 'done', needsEscalation: true, escalationSummary: summary, message: T.escalate, source: 'ai', intent: ctx.intent });
      return;
    }
    await this.saveMessage(sessionId, 'assistant', text, undefined, { source: 'ai', intent: ctx.intent });
    onEvent({ type: 'done', needsEscalation: false, source: 'ai', intent: ctx.intent });
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

  private async saveMessage(sessionId: string, role: 'user' | 'assistant', content: string, imageUrl?: string, meta?: MessageMeta) {
    const { error } = await this.supabase.client
      .from('chat_messages')
      .insert({ session_id: sessionId, role, content, image_url: imageUrl ?? null, meta: meta ?? null });
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
