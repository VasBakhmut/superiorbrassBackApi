import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { SupabaseService } from '../supabase/supabase.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';

const MODEL = 'gemini-3.6-flash';
const NO_ANSWER_MARKER = 'NO_ANSWER';
const NO_ANSWER_FALLBACK_MESSAGE =
  "Sorry, I don't have a confident answer for that from our documentation. Could you share your email and product model so I can pass this to our support team?";

const SYSTEM_PROMPT = `You are the technical support assistant for Austyle Architectural Hardware, an Australian door hardware manufacturer (digital locks, handles).

Rules:
- Answer ONLY using the "Context" provided below. It comes from Austyle's own SOPs, installation manuals and product brochures.
- Never guess, and never use general knowledge about locks that isn't in the context.
- Keep answers short, practical, step-by-step where relevant.
- The context you're given is scoped to the product model mentioned in this conversation, and is built BEFORE you see the question — so if no model has been mentioned yet, model-specific documentation (e.g. troubleshooting for a specific fault) may simply be missing from your context even though it exists in our systems. So: for any troubleshooting or installation question, if the customer hasn't stated their product code/model anywhere in this conversation, your ENTIRE response must be one short question asking which model they have (e.g. "Which product/model is this — you'll usually find a code like 59405 on the lock or its box"). Do this every time, regardless of what is or isn't in the context, and do NOT use NO_ANSWER for this case.
- If the context does not contain enough information to answer confidently, respond with EXACTLY one line:
${NO_ANSWER_MARKER}: <one sentence summarising what the customer is asking, for a human agent>
  and nothing else.`;

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; needsEscalation: boolean; escalationSummary?: string; message?: string };

@Injectable()
export class ChatService {
  private readonly ai: GoogleGenAI;

  constructor(
    config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly knowledge: KnowledgeService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: config.getOrThrow<string>('GEMINI_API_KEY') });
  }

  async handleMessageStream(dto: SendMessageDto, onEvent: (e: ChatStreamEvent) => void): Promise<void> {
    const sessionId = dto.sessionId ?? (await this.createSession(dto.entryPoint));
    onEvent({ type: 'session', sessionId });

    await this.saveMessage(sessionId, 'user', dto.message);

    const history = await this.getHistory(sessionId);
    const conversationText = [dto.productCode, ...history.map((m) => m.content)].filter(Boolean).join('\n');
    const context = await this.knowledge.getContextForConversation(conversationText);

    const stream = await this.ai.models.generateContentStream({
      model: MODEL,
      contents: history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: `${SYSTEM_PROMPT}\n\nContext:\n${context}`,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });

    // Buffer until we know whether the reply starts with the NO_ANSWER marker, so we
    // never flash raw "NO_ANSWER: ..." text at the visitor before falling back.
    let full = '';
    let determined = false;
    let isNoAnswer = false;
    const MARKER_PROBE_LEN = NO_ANSWER_MARKER.length + 1;

    for await (const chunk of stream) {
      const delta = chunk.text ?? '';
      if (!delta) continue;
      full += delta;

      if (!determined) {
        if (full.length >= MARKER_PROBE_LEN) {
          determined = true;
          isNoAnswer = full.startsWith(NO_ANSWER_MARKER);
          if (!isNoAnswer) onEvent({ type: 'chunk', text: full });
        }
        continue;
      }
      if (!isNoAnswer) onEvent({ type: 'chunk', text: delta });
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
