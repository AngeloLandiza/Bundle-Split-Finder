import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { clearReviewQueue, enqueueReview, readReviewQueue } from '../reviewQueue';
import { agentDataDir } from '../paths';

const file = `${agentDataDir()}/review-queue.json`;

afterEach(() => {
  clearReviewQueue();
});

describe('reviewQueue', () => {
  it('queues answers for the helper', () => {
    enqueueReview('split:x', { choice: 0 });
    expect(readReviewQueue()).toHaveLength(1);
  });

  it('queues AI-approved answers', () => {
    enqueueReview('split:x', { choice: 0 }, { aiSuggestion: true });
    expect(readReviewQueue()[0]?.aiSuggestion).toBe(true);
  });

  it('queues eBay yes/no answers', () => {
    enqueueReview('DEWALT:M|1', { ebay: 'yes' });
    expect(readReviewQueue()[0]?.answer).toEqual({ ebay: 'yes' });
    clearReviewQueue();
    expect(existsSync(file) ? readReviewQueue() : []).toHaveLength(0);
    if (existsSync(file)) unlinkSync(file);
  });
});