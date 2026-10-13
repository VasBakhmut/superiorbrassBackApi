import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import { FilesService } from './files.service.js';
import { StockService } from './stock.service.js';

@Module({
  providers: [CatalogService, StockService, FilesService],
  exports: [CatalogService, StockService, FilesService],
})
export class CatalogModule {}
