import type { ConfigService } from '@nestjs/config';
import { KeepAliveService } from './keepalive.service.js';
import type { SupabaseService } from './supabase.service.js';

function setup(hours: string | undefined, fail = false) {
  const limit = vi.fn(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve({ error: null })));
  const supabase = { client: { from: () => ({ select: () => ({ limit }) }) } } as unknown as SupabaseService;
  const config = { get: () => hours } as unknown as ConfigService;
  return { service: new KeepAliveService(supabase, config), limit };
}

describe('KeepAliveService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('queries the database at startup and then every interval', async () => {
    const { service, limit } = setup('6');
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(limit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(limit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(limit).toHaveBeenCalledTimes(4);
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(limit).toHaveBeenCalledTimes(4);
  });

  it('does nothing when switched off', async () => {
    const { service, limit } = setup('0');
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(limit).not.toHaveBeenCalled();
  });

  it('survives a failing database without throwing', async () => {
    const { service } = setup('6', true);
    await expect(service.ping()).resolves.toBe(false);
  });
});
