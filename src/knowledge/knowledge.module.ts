import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service.js';
import { ProductsService } from './products.service.js';
import { DrawingsService } from './drawings.service.js';

@Module({
  providers: [KnowledgeService, ProductsService, DrawingsService],
  exports: [KnowledgeService, ProductsService, DrawingsService],
})
export class KnowledgeModule {}
