import { describe, expect, it } from 'vitest';

import { relayPayload } from '../src/relay';
import { verifyRelayPayload } from '../../agent/relay';

describe('relayPayload', () => {
  const digest = { at: '2026-11-22', reviewOpen: 2, roiHits: [{ model: 'X', profit: 10 }] };

  it('signs with HMAC-SHA256 and verifies', async () => {
    const secret = 'relay-test-secret';
    const { body, signature } = await relayPayload(digest, secret);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyRelayPayload(body, signature, secret)).toBe(true);
    expect(verifyRelayPayload(body, signature, 'wrong')).toBe(false);
  });
});