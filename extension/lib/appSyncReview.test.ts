import type { PanelReport } from './messages';
import { describe, expect, it, vi } from 'vitest';

import { runReviewSync } from './appSyncReview';
import type { Worker } from './worker';

describe('appSyncReview', () => {
  it('calls answerEbay for queued eBay answers', async () => {
    const onMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          review: [],
          ebayQuestions: [
            {
              id: 'DEWALT:M|9',
              key: 'DEWALT:M',
              brand: 'DEWALT',
              model: 'M',
              itemId: '9',
              title: 't',
              url: 'https://www.ebay.com/itm/9',
              price: 10,
              soldQuantity: 1,
              reasons: ['x'],
              openedAt: 1,
            },
          ],
        } as unknown as PanelReport,
      })
      .mockResolvedValue({ ok: true, data: null });
    const worker = { onMessage } as unknown as Worker;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, jobs: [{ id: 'DEWALT:M|9', answer: { ebay: 'yes' as const } }] }),
        })
        .mockResolvedValueOnce({ ok: true }),
    );

    await runReviewSync(worker);

    expect(onMessage).toHaveBeenCalledWith(
      { type: 'answerEbay', key: 'DEWALT:M', itemId: '9', answer: 'yes' },
      {},
    );
    vi.unstubAllGlobals();
  });

  it('passes aiSuggestion when approving a queued AI answer', async () => {
    const onMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          review: [{ id: 'split:x', kind: 'split', answer: null, choices: [['A']], candidates: [] }],
          ebayQuestions: [],
        } as unknown as PanelReport,
      })
      .mockResolvedValue({ ok: true, data: null });
    const worker = { onMessage } as unknown as Worker;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            jobs: [{ id: 'split:x', answer: { choice: 0 }, aiSuggestion: true }],
          }),
        })
        .mockResolvedValueOnce({ ok: true }),
    );

    await runReviewSync(worker);

    expect(onMessage).toHaveBeenCalledWith(
      { type: 'answerReview', id: 'split:x', answer: expect.objectContaining({ choice: 0 }), aiSuggestion: true },
      {},
    );
    vi.unstubAllGlobals();
  });
});