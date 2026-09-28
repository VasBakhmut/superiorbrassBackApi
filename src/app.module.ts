import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { SupabaseModule } from './supabase/supabase.module.js';
import { ChatModule } from './chat/chat.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), SupabaseModule, ChatModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
