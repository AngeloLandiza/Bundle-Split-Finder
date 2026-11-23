// How much discovery work is still open for Keepa auto-scale (plan §4.1).

import type { ScanReport } from '../scan/types';

/**
 * Report-shaped discovery pressure beyond the part lookup queue: unresolved bundles,
 * unread kits, unestimated options, and parts still waiting on Amazon.
 * Open Review questions are counted once via `openReview`.
 */
/** Structural discovery work (bundles, kits, options, review). Pending part lookups are counted separately. */
export function reportStructuralDiscoveryPressure(report: ScanReport, openReview: number): number {
  let n = openReview;
  for (const b of report.bundles) {
    if (b.section === 'split' || b.status === 'needs_review') n += 1;
    n += b.kitsNotRead.length;
    if (b.options.length > 0 && b.options.some((o) => o.estimate === null)) n += 1;
  }
  return n;
}

/** Discovery vs total work for `planKeepaRun` auto scale from queued part and kit-item steps. */
export function keepaQueuePressure(args: {
  partLookups: number;
  partRefreshes: number;
  itemKeys: string[];
  stepKind: (key: string) => string | undefined;
  structural: number;
}): { openDiscoveryWork: number; totalWork: number } {
  const itemDiscovery = args.itemKeys.filter((k) => {
    const kind = args.stepKind(k);
    return kind === 'lookup' || kind === 'identify';
  }).length;
  const openDiscoveryWork = args.partLookups + itemDiscovery + args.structural;
  const totalWork = args.partLookups + args.partRefreshes + args.itemKeys.length + args.structural;
  return { openDiscoveryWork, totalWork };
}

/** Full discovery pressure including parts still waiting on Amazon (used outside Keepa queue planning). */
export function reportDiscoveryPressure(report: ScanReport, openReview: number): number {
  let n = reportStructuralDiscoveryPressure(report, openReview);
  for (const b of report.bundles) {
    for (const p of b.parts) {
      if (p.status === 'waiting' || p.status === 'unmatched') n += 1;
    }
  }
  return n;
}