import { describe, expect, it, vi } from 'vitest';

import { runPaidSync } from './appSyncPaid';
import type { Worker } from './worker';

describe('appSyncPaid', () => {
  it('runs queued lookUp', async () => {
    const onMessage = vi.fn().mockResolvedValue({ ok: true });
    const worker = { onMessage } as unknown as Worker;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            jobs: [{ action: { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'A' }] } }],
          }),
        })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValue({ ok: true, data: null }),
    );

    await runPaidSync(worker);

    expect(onMessage).toHaveBeenCalledWith(
      { type: 'runPaid', action: { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'A' }] } },
      {},
    );
    vi.unstubAllGlobals();
  });
});