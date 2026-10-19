import { HttpException } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import type { SupabaseService } from './supabase/supabase.service.js';

const fakeSupabase = (result: { error: unknown } | Error) =>
  ({
    client: {
      from: () => ({
        select: () => ({
          limit: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
        }),
      }),
    },
  }) as unknown as SupabaseService;

describe('HealthController', () => {
  it('reports ok after a real query succeeds', async () => {
    const res = await new HealthController(fakeSupabase({ error: null })).check();
    expect(res).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('answers 503 when the database returns an error', async () => {
    await expect(new HealthController(fakeSupabase({ error: { message: 'boom' } })).check()).rejects.toBeInstanceOf(HttpException);
  });

  it('answers 503 when the request itself fails', async () => {
    await expect(new HealthController(fakeSupabase(new Error('network'))).check()).rejects.toMatchObject({ status: 503 });
  });
});
