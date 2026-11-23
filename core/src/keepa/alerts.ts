// Scan-end digests and trend crosses (plan §5 Phase A).

import type { BundleRow } from '../scan/types';
import { estimateRoiPercent, type AlertSettings } from '../settings';
import type { AlertBaseline } from './trends';

export interface ScanDigests {
  roiAlerts: BundleRow[];
  reviewCount: number;
  discoveryComplete: string[];
  trendAlerts: { bundleKey: string; message: string }[];
}

export function reviewDigestMessage(open: { match: number; split: number } | number): string | null {
  const match = typeof open === 'number' ? open : open.match;
  const split = typeof open === 'number' ? 0 : open.split;
  const total = match + split;
  if (total <= 0) return null;
  const parts: string[] = [];
  if (match > 0) parts.push(match === 1 ? '1 match question' : `${match} match questions`);
  if (split > 0) parts.push(split === 1 ? '1 split question' : `${split} split questions`);
  return `${parts.join(', ')} need you.`;
}

export function bundlesCrossingThreshold(rows: BundleRow[], alerts: AlertSettings): BundleRow[] {
  if (!alerts.enabled) return [];
  return rows.filter(
    (r) =>
      r.estimate !== null &&
      r.estimate.profit >= alerts.minProfit &&
      estimateRoiPercent(r.estimate.roi) >= alerts.minRoiPercent,
  );
}

/**
 * Bundle SKUs that just moved to Confirmed with an estimate (plan §5).
 * On the first snapshot after install, `sectionsSeeded` is false and nothing is notified.
 */
export function bundlesNewlyConfirmed<T extends { key: string; model: string; section: string; estimate: unknown }>(
  rows: T[],
  lastSection: ReadonlyMap<string, string>,
  sectionsSeeded: boolean,
): T[] {
  if (!sectionsSeeded) return [];
  return rows.filter(
    (r) => r.section === 'confirmed' && r.estimate !== null && lastSection.get(r.key) !== 'confirmed',
  );
}

/** Margin crossed up vs stored baseline (plan §3b). `label` is shown to the owner (model id). */
export function trendCrosses(
  label: string,
  profit: number,
  roiPercent: number,
  baseline: AlertBaseline | undefined,
  alerts: AlertSettings,
): string | null {
  if (!alerts.enabled || !baseline) return null;
  const wasBelow = baseline.profit < alerts.minProfit || baseline.roiPercent < alerts.minRoiPercent;
  const nowAbove = profit >= alerts.minProfit && roiPercent >= alerts.minRoiPercent;
  if (wasBelow && nowAbove) return `${label}: estimated margin crossed your buy threshold.`;
  return null;
}

/** Part Amazon price fell vs the prior cached Keepa pull (plan §3b). */
export function partPriceDropMessage(partModel: string, deltaDollars: number): string {
  return `${partModel}: Amazon price is $${deltaDollars.toFixed(2)} lower than the last Keepa refresh.`;
}