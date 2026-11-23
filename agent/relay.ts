// Node helpers for relay servers; signing is in core (Web Crypto).

export type { ScanDigest } from '../core/src/relay';
export { relayPayload } from '../core/src/relay';

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Node-only verify helper for relay servers and tests. */
export function verifyRelayPayload(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}