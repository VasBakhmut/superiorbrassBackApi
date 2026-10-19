import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service.js';

/**
 * Supabase pauses Free Plan projects that get too few user database queries in a week; a few a day
 * are enough (https://supabase.com/docs/guides/platform/free-project-pausing). While the backend is
 * running it makes one tiny query at startup and then every DB_KEEPALIVE_HOURS (default 6, 0 turns
 * it off), so the project stays awake without an external monitor.
 */
@Injectable()
export class KeepAliveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeepAliveService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const hours = Number(this.config.get<string>('DB_KEEPALIVE_HOURS') ?? 6);
    if (!(hours > 0)) return;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), hours * 60 * 60 * 1000);
    this.timer.unref(); // never keeps the process alive on its own
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async ping(): Promise<boolean> {
    try {
      const { error } = await this.supabase.client.from('products').select('code').limit(1);
      if (error) throw error;
      this.logger.log('database keep-alive ok');
      return true;
    } catch (err) {
      this.logger.warn(`database keep-alive failed: ${(err as Error).message}`);
      return false;
    }
  }
}
