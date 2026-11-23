// The scanning forecast in Settings (design.md, Settings page > Scanning): how many searches the
// schedule needs in a month against what the plan leaves after the reserve, and the fix when it
// does not fit.

import type { Schedule } from '../api/types';
import { count } from './format';

export interface Forecast {
  scansPerMonth: number;
  needed: number;
  usable: number;
  fits: boolean;
  /** The headline: "This fits your plan", or the sentence with the fix. */
  sentence: string;
  /** "120 scans a month × 5 searches." */
  detail: string;
}

export function scansPerMonth(s: Schedule): number {
  if (s.mode === 'manual') return 0;
  if (s.mode === 'daily') return 30;
  return Math.floor((30 * 24) / Math.max(1, s.hours));
}

/**
 * `free`: the free scan (the bundle lists read in Chrome, Amazon lookups on Keepa first). Finding bundles spends no search;
 * a scheduled scan searches only for a lookup Keepa cannot pay for, at most `perScan`, and never the reserve, so the
 * schedule is not bounded by the plan.
 */
export function forecast(s: Schedule, perScan: number, monthly: number, reserve: number, opts: { free?: boolean } = {}): Forecast {
  const scans = scansPerMonth(s);
  if (opts.free) {
    const usable = Math.max(0, monthly - reserve);
    const detail = scans === 0
      ? 'Scans run only when you press Scan now.'
      : `${count(scans)} scans a month read Home Depot’s lists in Chrome. A lookup Keepa cannot pay for uses a search, at most ${count(perScan)} a scan and never the reserve.`;
    return { scansPerMonth: scans, needed: 0, usable, fits: true, sentence: 'Finding bundles spends no searches', detail };
  }
  const needed = scans * perScan;
  const usable = Math.max(0, monthly - reserve);
  const fits = needed <= usable;
  const detail = scans === 0 ? 'Scans run only when you press Scan now.' : `${count(scans)} scans a month × ${count(perScan)} ${perScan === 1 ? 'search' : 'searches'}. Searches from the reserve are spent only when you choose.`;
  if (fits) return { scansPerMonth: scans, needed, usable, fits, sentence: 'This fits your plan', detail };
  const per = scans > 0 ? Math.floor(usable / scans) : 0;
  const fix = per >= 1 ? `Use ${count(per)} per scan, or scan less often.` : 'Scan less often.';
  return {
    scansPerMonth: scans,
    needed,
    usable,
    fits,
    sentence: `This needs ${count(needed)} searches a month and your plan has ${count(usable)} to spend. ${fix}`,
    detail,
  };
}
