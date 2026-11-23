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

export function forecast(s: Schedule, perScan: number, monthly: number, reserve: number): Forecast {
  const scans = scansPerMonth(s);
  const needed = scans * perScan;
  const usable = Math.max(0, monthly - reserve);
  const fits = needed <= usable;
  const detail = scans === 0 ? 'Scans run only when you press Scan now.' : `${count(scans)} scans a month × ${count(perScan)} ${perScan === 1 ? 'search' : 'searches'}. Lookups you start yourself come out of the reserve.`;
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
