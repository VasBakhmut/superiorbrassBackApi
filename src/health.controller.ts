import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseService } from './supabase/supabase.service.js';

/**
 * Cheap liveness check that runs one real query against the database.
 *
 * Supabase pauses Free Plan projects that get too few user database queries in a week
 * (https://supabase.com/docs/guides/platform/free-project-pausing: a few requests a day are enough),
 * so pointing an uptime monitor at this endpoint keeps the project awake and also alerts you if the
 * backend or the database goes down.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async check() {
    const started = Date.now();
    try {
      const { error } = await this.supabase.client.from('products').select('code').limit(1);
      if (error) throw error;
    } catch {
      throw new HttpException({ status: 'error', db: 'down' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', db: 'ok', ms: Date.now() - started };
  }
}
