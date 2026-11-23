import type { BundleRow } from '../scan/types';

/** Days since the oldest shown part price, when it is older than the freshness period; else null. */
export function staleBundleDays(bundles: readonly BundleRow[], now: number, freshnessMs: number): number | null {
  let oldest: number | null = null;
  for (const b of bundles) {
    for (const p of b.parts) {
      if (p.priceSeenAt !== null && (oldest === null || p.priceSeenAt < oldest)) oldest = p.priceSeenAt;
    }
  }
  if (oldest === null || now - oldest <= freshnessMs) return null;
  return Math.max(1, Math.floor((now - oldest) / 86_400_000));
}