import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { EscalationModule } from '../escalation/escalation.module.js';

@Module({
  imports: [KnowledgeModule, EscalationModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
