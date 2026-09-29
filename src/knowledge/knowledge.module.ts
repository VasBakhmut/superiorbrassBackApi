import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service.js';
import { ProductsService } from './products.service.js';

@Module({
  providers: [KnowledgeService, ProductsService],
  exports: [KnowledgeService, ProductsService],
})
export class KnowledgeModule {}
