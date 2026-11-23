import { partKey, type BundleRow, type PartRow, type ScanJob, type ScanStep } from '../scan/types';

const isWaiting = (p: PartRow): boolean => p.status === 'waiting' || p.status === 'unmatched';

export function waitingOf(brand: string, parts: PartRow[]): { brand: string; model: string }[] {
  return parts.filter(isWaiting).map((p) => ({ brand, model: p.model }));
}

/** Parts on this bundle row that a Look up would search for. */
export function waitingParts(row: Pick<BundleRow, 'brand' | 'parts'>): { brand: string; model: string }[] {
  return waitingOf(row.brand, row.parts);
}

export function waitingKeys(bundles: BundleRow[]): Set<string> {
  const keys = new Set<string>();
  for (const b of bundles) for (const p of b.parts) if (isWaiting(p)) keys.add(partKey(b.brand, p.model));
  return keys;
}

/** Deferred Amazon lookups that still wait in the report. */
export function lookupsWaiting(job: Pick<ScanJob, 'deferred'>, bundles: BundleRow[]): number {
  const waiting = waitingKeys(bundles);
  return new Set(
    job.deferred
      .filter((s): s is Extract<ScanStep, { kind: 'lookup' }> => s.kind === 'lookup')
      .map((s) => partKey(s.brand, s.model))
      .filter((k) => waiting.has(k)),
  ).size;
}