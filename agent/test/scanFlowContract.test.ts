import { describe, expect, it } from 'vitest';

import { peekPendingScan, requestScan, clearPendingScan } from '../scanQueue';

describe('scan flow contract', () => {
  it('app queues scan and helper peeks then acks', () => {
    const pending = requestScan();
    expect(peekPendingScan()?.id).toBe(pending.id);
    clearPendingScan();
    expect(peekPendingScan()).toBeNull();
  });
});