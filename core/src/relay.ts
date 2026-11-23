// Signed scan digests for an optional outbound relay (plan Phase 4). Works in extension workers and Node (Web Crypto).

export interface ScanDigest {
  at: string;
  reviewOpen: number;
  roiHits: { model: string; profit: number }[];
  /** Same sentence as the Review digest notification when non-null. */
  reviewDigest?: string;
  discoveryComplete?: string[];
  trendAlerts?: string[];
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 over the JSON body. */
export async function relayPayload(digest: ScanDigest, secret: string): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify(digest);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return { body, signature: bytesToHex(sig) };
}