import { Global, Module } from '@nestjs/common';
import { KeepAliveService } from './keepalive.service.js';
import { SupabaseService } from './supabase.service.js';

@Global()
@Module({
  providers: [SupabaseService, KeepAliveService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
