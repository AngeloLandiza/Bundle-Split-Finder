import { describe, expect, it, vi } from 'vitest';

import { checkEbayKeysApp } from '../checkEbayKeysApp';

describe('checkEbayKeysApp', () => {
  it('rejects empty ids', async () => {
    expect((await checkEbayKeysApp('', '')).ok).toBe(false);
  });

  it('accepts when eBay returns a token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 }),
      ),
    );
    const r = await checkEbayKeysApp('app', 'cert');
    expect(r.ok).toBe(true);
    vi.unstubAllGlobals();
  });
});