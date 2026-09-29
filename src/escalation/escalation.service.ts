import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface EscalationInput {
  sessionId: string;
  customerEmail: string;
  productCode?: string;
  issueSummary: string;
  transcript: { role: string; content: string; image_url?: string | null }[];
}

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);
  private readonly resend: Resend | null;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  async escalate(input: EscalationInput) {
    const { data, error } = await this.supabase.client
      .from('escalations')
      .insert({
        session_id: input.sessionId,
        customer_email: input.customerEmail,
        product_code: input.productCode ?? null,
        issue_summary: input.issueSummary,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    const toEmail = this.config.get<string>('ESCALATION_TO_EMAIL');
    if (!this.resend || !toEmail) {
      this.logger.warn(
        `RESEND_API_KEY or ESCALATION_TO_EMAIL not set — escalation ${data.id} saved to DB only, no email sent.`,
      );
      return data;
    }

    const transcriptText = input.transcript
      .map((m) => `${m.role.toUpperCase()}: ${m.content}${m.image_url ? `\n  [photo attached: ${m.image_url}]` : ''}`)
      .join('\n');

    await this.resend.emails.send({
      from: this.config.getOrThrow<string>('ESCALATION_FROM_EMAIL'),
      to: toEmail,
      subject: `[Support Bot] Escalation — ${input.productCode ?? 'unspecified product'}`,
      text: [
        `Customer email: ${input.customerEmail}`,
        `Product code: ${input.productCode ?? 'not specified'}`,
        '',
        `Issue summary: ${input.issueSummary}`,
        '',
        '--- Conversation transcript ---',
        transcriptText,
      ].join('\n'),
    });

    await this.supabase.client
      .from('escalations')
      .update({ status: 'sent' })
      .eq('id', data.id);

    return data;
  }
}
