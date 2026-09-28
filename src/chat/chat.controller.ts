import { Body, Controller, Get, HttpException, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChatService } from './chat.service.js';
import { EscalationService } from '../escalation/escalation.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { EscalateDto } from './dto/escalate.dto.js';
import { classifyError } from './chat-error.util.js';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly escalation: EscalationService,
  ) {}

  @Post('message')
  async sendMessage(@Body() dto: SendMessageDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      await this.chat.handleMessageStream(dto, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch (err) {
      console.error('[chat/message] failed:', err);
      const { code, message } = classifyError(err);
      res.write(`data: ${JSON.stringify({ type: 'error', code, message })}\n\n`);
    } finally {
      res.end();
    }
  }

  @Get('products')
  async listProducts() {
    try {
      return await this.chat.listProductCodes();
    } catch (err) {
      const { code, message } = classifyError(err);
      throw new HttpException({ code, message }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Post('escalate')
  async escalate(@Body() dto: EscalateDto) {
    try {
      const transcript = await this.chat.getTranscript(dto.sessionId);
      return await this.escalation.escalate({
        sessionId: dto.sessionId,
        customerEmail: dto.customerEmail,
        productCode: dto.productCode,
        issueSummary: dto.issueDescription,
        transcript,
      });
    } catch (err) {
      const { code, message } = classifyError(err);
      throw new HttpException({ code, message }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
