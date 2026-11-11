// What the Deals list shows, worked out from the report: the match state of a row, the order within a
// section, the sections themselves. No React here, so the rules can be tested on their own.

import { partKey, type BundleRow, type PartRow, type ReportSection, type ScanJob } from '@core/scan/types';
import type { SortKey } from './sort';

export const SECTION_ORDER: readonly ReportSection[] = ['confirmed', 'waiting', 'inactive_listing', 'missing_listing', 'split'];

export const SECTION_LABEL: Record<ReportSection, string> = {
  confirmed: 'CONFIRMED',
  waiting: 'WAITING FOR AN AMAZON LOOKUP',
  inactive_listing: 'REVIEW: INACTIVE LISTING',
  missing_listing: 'REVIEW: MISSING LISTING',
  split: 'CONTENTS NOT KNOWN',
};

const count = (n: number, tail: string): string => `${n} ${n === 1 ? 'part' : 'parts'} ${tail}`;

const isWaiting = (p: PartRow): boolean => p.status === 'waiting' || p.status === 'unmatched';

/**
 * The match state of a bundle in the fixed vocabulary, or null when its parts are not known.
 * A row leads with the reason for its section, so it never contradicts the heading it sits under.
 */
export function matchState(row: BundleRow): string | null {
  const parts = row.parts;
  if (parts.length === 0) return null;
  // A part left in review has no chosen listing yet: it is still a question, so it counts as one to verify.
  const verify = parts.filter((p) => !isWaiting(p) && (p.grade === 'probable' || p.status === 'review')).length;
  const toLookUp = parts.filter(isWaiting).length;
  switch (row.section) {
    case 'inactive_listing': {
      if (row.price === null) return 'No bundle price';
      const inactive = parts.filter((p) => p.availability === 'inactive').length;
      if (inactive > 0) return `${inactive} ${inactive === 1 ? 'listing' : 'listings'} inactive`;
      break;
    }
    case 'confirmed': {
      // The owner's decision: a title match is said as one. Verify stays on Detail.
      const probable = parts.filter((p) => p.grade === 'probable').length;
      if (probable > 0) return `${probable} title ${probable === 1 ? 'match' : 'matches'}`;
      break;
    }
    case 'waiting':
      if (toLookUp > 0) return count(toLookUp, 'to look up');
      break;
    case 'missing_listing': {
      // Each part counts once: a part with no listing is not also one to verify, even when it sits in review.
      const none = parts.filter((p) => p.availability === 'missing').length;
      const others = parts.filter((p) => p.availability !== 'missing' && !isWaiting(p) && (p.grade === 'probable' || p.status === 'review')).length;
      if (none > 0) return count(none, 'with no listing') + (others > 0 ? ` · ${others} to verify` : '');
      break;
    }
    default:
      break;
  }
  if (parts.every((p) => p.grade === 'exact' || p.grade === 'strong')) return count(parts.length, 'matched');
  if (verify > 0) return count(verify, 'to verify');
  if (toLookUp > 0) return count(toLookUp, 'unknown');
  const missing = parts.filter((p) => p.availability === 'missing').length;
  if (missing > 0) return count(missing, 'with no listing');
  return null;
}

/**
 * The parts a Look up would search for: the ones waiting for an Amazon lookup, and the ones with no match yet
 * (a split the owner chose after the scan planned its lookups).
 */
export function waitingParts(row: BundleRow): { brand: string; model: string }[] {
  return waitingOf(row.brand, row.parts);
}

/** The same for any list of parts, such as one way to sell's. */
export function waitingOf(brand: string, parts: PartRow[]): { brand: string; model: string }[] {
  return parts.filter(isWaiting).map((p) => ({ brand, model: p.model }));
}

const metric = (row: BundleRow, sort: SortKey): number | null => {
  if (sort === 'discount') return row.percentOff;
  if (!row.estimate) return null;
  return sort === 'roi' ? row.estimate.roi : row.estimate.profit;
};

/** Highest first; rows with no figure last; ties keep the report's order. */
export function sortRows(rows: BundleRow[], sort: SortKey): BundleRow[] {
  return rows
    .map((row, i) => ({ row, i, v: metric(row, sort) }))
    .sort((a, b) => (a.v === null ? (b.v === null ? 0 : 1) : b.v === null ? -1 : b.v - a.v) || a.i - b.i)
    .map((x) => x.row);
}

export interface Section {
  id: ReportSection;
  label: string;
  rows: BundleRow[];
}

export function sections(bundles: BundleRow[], sort: SortKey): Section[] {
  return SECTION_ORDER.map((id) => ({ id, label: SECTION_LABEL[id], rows: sortRows(bundles.filter((b) => b.section === id), sort) })).filter(
    (s) => s.rows.length > 0,
  );
}

/** The parts that still wait for an Amazon lookup in the report, as partKeys. */
export function waitingKeys(bundles: BundleRow[]): Set<string> {
  const keys = new Set<string>();
  for (const b of bundles) for (const p of b.parts) if (isWaiting(p)) keys.add(partKey(b.brand, p.model));
  return keys;
}

/**
 * How many distinct parts still need an Amazon lookup after the last scan. The job is the scan's own and a panel
 * Look up never rewrites it, so a deferred lookup counts only while its part still waits in the report.
 */
export function lookupsWaiting(job: ScanJob, bundles: BundleRow[]): number {
  const waiting = waitingKeys(bundles);
  return new Set(job.deferred.filter((s) => s.kind === 'lookup').map((s) => partKey(s.brand, s.model)).filter((k) => waiting.has(k))).size;
}

/** Days since the oldest shown part price, when it is older than the freshness period; else null. */
export function staleDays(bundles: BundleRow[], now: number, freshnessMs: number): number | null {
  let oldest: number | null = null;
  for (const b of bundles) for (const p of b.parts) if (p.priceSeenAt !== null && (oldest === null || p.priceSeenAt < oldest)) oldest = p.priceSeenAt;
  if (oldest === null || now - oldest <= freshnessMs) return null;
  return Math.max(1, Math.floor((now - oldest) / 86_400_000));
}
