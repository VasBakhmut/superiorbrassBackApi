import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { EscalationModule } from '../escalation/escalation.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ImageUploadService } from './image-upload.service.js';
import { QueryTranslatorService } from './query-translator.service.js';
import { AnswerRouter } from './router.service.js';

@Module({
  imports: [KnowledgeModule, CatalogModule, EscalationModule],
  controllers: [ChatController],
  providers: [ChatService, ImageUploadService, AnswerRouter, QueryTranslatorService],
})
export class ChatModule {}
