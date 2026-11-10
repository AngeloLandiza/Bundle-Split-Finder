// What the owner can change in Settings, and its defaults.
//
// Types and defaults only. The functions that validate settings and turn them into a
// scan's settings and budget policy are added by step 3, Task 4.

import { DEFAULT_FEES, type FeeSettings } from './money';
import type { Schedule } from './schedule';

export interface AlertSettings {
  enabled: boolean;
  /** Estimated profit a bundle must reach, in dollars. */
  minProfit: number;
  /** Estimated return a bundle must reach, in percent. */
  minRoiPercent: number;
}

export interface ExtensionSettings {
  schedule: Schedule;
  /** The most one scan may spend. 1 to 250. */
  searchesPerScan: number;
  /** Searches a scheduled scan must leave on the account. 0 to 250. */
  reserve: number;
  /** Upper case; a subset of KNOWN_BRANDS with at least one entry. */
  brands: string[];
  /** Home Depot listing pages per brand. 1 to 5. */
  pagesPerBrand: number;
  fees: FeeSettings;
  alerts: AlertSettings;
}

export const KNOWN_BRANDS = ['DEWALT', 'RYOBI'] as const;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  schedule: { mode: 'manual' },
  searchesPerScan: 5,
  reserve: 100,
  brands: ['DEWALT', 'RYOBI'],
  pagesPerBrand: 1,
  fees: DEFAULT_FEES,
  alerts: { enabled: false, minProfit: 20, minRoiPercent: 20 },
};

/** Who asked for a scan. A scheduled scan may never touch the reserve; one the user starts may. */
export type ScanTrigger = 'scheduled' | 'manual';
