// Option snapshots when ways-to-sell are computed (plan §6, Phase 1 reporting).

import type { ScanReport } from '../scan/types';
import type { Cache } from '../serpapi/client';
import { estimateRoiPercent } from '../settings';

export interface OptionSnapshotRow {
  id: string;
  label: string;
  profit: number | null;
  roiPercent: number | null;
  leftovers: string[];
}

export interface OptionSnapshot {
  bundleKey: string;
  model: string;
  at: number;
  options: OptionSnapshotRow[];
}

export const optionSnapshotKey = (bundleKey: string): string => `keepa:options:${bundleKey}`;

export function optionSnapshotFromReport(bundleKey: string, report: ScanReport, at: number): OptionSnapshot | null {
  const row = report.bundles.find((b) => b.key === bundleKey);
  if (!row || row.options.length === 0) return null;
  return {
    bundleKey,
    model: row.model === '' && row.setItems !== undefined ? `Set ${row.itemId}` : row.model,
    at,
    options: row.options.map((o) => ({
      id: o.id,
      label: o.label,
      profit: o.estimate?.profit ?? null,
      roiPercent: o.estimate === null ? null : estimateRoiPercent(o.estimate.roi),
      leftovers: [...o.leftovers],
    })),
  };
}

export async function writeOptionSnapshots(cache: Cache, report: ScanReport, at: number): Promise<number> {
  let n = 0;
  for (const b of report.bundles) {
    if (b.options.length === 0) continue;
    const snap = optionSnapshotFromReport(b.key, report, at);
    if (!snap) continue;
    await cache.set(optionSnapshotKey(b.key), { at, data: snap });
    n += 1;
  }
  return n;
}

export async function readOptionSnapshot(cache: Cache, bundleKey: string): Promise<OptionSnapshot | undefined> {
  const hit = await cache.get(optionSnapshotKey(bundleKey));
  if (!hit || typeof hit.data !== 'object' || hit.data === null) return undefined;
  return hit.data as OptionSnapshot;
}