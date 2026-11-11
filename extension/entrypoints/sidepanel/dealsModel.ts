// What the Deals list shows, worked out from the report: the match state of a row, the order within a
// section, the sections themselves. No React here, so the rules can be tested on their own.

import type { BundleRow, PartRow, ReportSection, ScanJob, ScanStep } from '@core/scan/types';
import type { SortKey } from './sort';

export const SECTION_ORDER: readonly ReportSection[] = ['confirmed', 'inactive_listing', 'missing_listing', 'split'];

export const SECTION_LABEL: Record<ReportSection, string> = {
  confirmed: 'CONFIRMED',
  inactive_listing: 'REVIEW: INACTIVE LISTING',
  missing_listing: 'REVIEW: MISSING LISTING',
  split: 'CONTENTS NOT KNOWN',
};

const count = (n: number, tail: string): string => `${n} ${n === 1 ? 'part' : 'parts'} ${tail}`;

const isWaiting = (p: PartRow): boolean => p.status === 'waiting' || p.status === 'unmatched';

/**
 * The match state of a bundle in the fixed vocabulary, or null when its parts are not known.
 * When several apply, the first of: to verify, unknown, no listing.
 */
export function matchState(row: BundleRow): string | null {
  const parts = row.parts;
  if (parts.length === 0) return null;
  // Rows in the inactive section say why they are there, before any other wording.
  if (row.section === 'inactive_listing') {
    if (row.price === null) return 'No bundle price';
    const inactive = parts.filter((p) => p.availability === 'inactive').length;
    if (inactive > 0) return `${inactive} ${inactive === 1 ? 'listing' : 'listings'} inactive`;
  }
  if (parts.every((p) => p.grade === 'exact' || p.grade === 'strong')) return count(parts.length, 'matched');
  // A part left in review has no chosen listing yet: it is still a question, so it counts as one to verify.
  const verify = parts.filter((p) => !isWaiting(p) && (p.grade === 'probable' || p.status === 'review')).length;
  if (verify > 0) return count(verify, 'to verify');
  const unknown = parts.filter(isWaiting).length;
  if (unknown > 0) return count(unknown, 'unknown');
  const missing = parts.filter((p) => p.availability === 'missing').length;
  if (missing > 0) return count(missing, 'with no listing');
  return null;
}

/** The parts a Look up would search for: the ones waiting for an Amazon lookup. */
export function waitingParts(row: BundleRow): { brand: string; model: string }[] {
  return row.parts.filter((p) => p.status === 'waiting').map((p) => ({ brand: row.brand, model: p.model }));
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

const stepKey = (s: ScanStep): string => (s.kind === 'lookup' ? `${s.brand}|${s.model}` : '');

/** How many distinct parts still need an Amazon lookup after the last scan. */
export function lookupsWaiting(job: ScanJob): number {
  return new Set(job.deferred.filter((s) => s.kind === 'lookup').map(stepKey)).size;
}

/** Days since the oldest shown part price, when it is older than the freshness period; else null. */
export function staleDays(bundles: BundleRow[], now: number, freshnessMs: number): number | null {
  let oldest: number | null = null;
  for (const b of bundles) for (const p of b.parts) if (p.priceSeenAt !== null && (oldest === null || p.priceSeenAt < oldest)) oldest = p.priceSeenAt;
  if (oldest === null || now - oldest <= freshnessMs) return null;
  return Math.max(1, Math.floor((now - oldest) / 86_400_000));
}
