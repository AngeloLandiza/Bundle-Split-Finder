import { describe, expect, it, vi } from 'vitest';

import { runAskSync } from './appSyncAsk';
import type { Worker } from './worker';

describe('appSyncAsk', () => {
  it('calls askAi and posts audit', async () => {
    const onMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, data: '{"kind":"split-finder-audit"}' })
      .mockResolvedValue({ ok: true, data: null });
    const worker = { onMessage } as unknown as Worker;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, jobs: [{ job: { questionId: 'split:a' } }] }),
        })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true }),
    );

    await runAskSync(worker);

    expect(onMessage).toHaveBeenCalledWith({ type: 'askAi', questionId: 'split:a' }, {});
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});