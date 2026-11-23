import { describe, expect, it } from 'vitest';

import { clearPaidQueue, enqueuePaid, readPaidQueue } from '../paidQueue';

describe('paidQueue', () => {
  it('queues lookUp actions', () => {
    clearPaidQueue();
    enqueuePaid({ kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'A' }] });
    expect(readPaidQueue()).toHaveLength(1);
    clearPaidQueue();
  });
});