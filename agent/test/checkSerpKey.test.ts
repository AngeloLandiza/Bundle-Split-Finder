import { describe, expect, it, vi } from 'vitest';

import { checkSerpApiKey } from '../checkSerpKey';

describe('checkSerpApiKey', () => {
  it('refuses an empty key', async () => {
    expect(await checkSerpApiKey('')).toEqual({ ok: false, message: 'Enter your SerpApi key.' });
  });

  it('parses a valid account response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          account_status: 'Active',
          plan_name: 'Free Plan',
          total_searches_left: 200,
          searches_per_month: 250,
          this_month_usage: 50,
          account_rate_limit_per_hour: 50,
          this_hour_searches: 0,
        };
      },
    })) as unknown as typeof globalThis.fetch;
    const r = await checkSerpApiKey('test-key', fetchMock);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.account.totalSearchesLeft).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});