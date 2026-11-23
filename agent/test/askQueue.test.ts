import { describe, expect, it } from 'vitest';

import { clearAskQueue, enqueueAsk, readAskQueue } from '../askQueue';

describe('askQueue', () => {
  it('queues one question or ask-all', () => {
    clearAskQueue();
    enqueueAsk({ questionId: 'split:a' });
    enqueueAsk({ all: true });
    expect(readAskQueue()).toHaveLength(2);
    clearAskQueue();
  });
});