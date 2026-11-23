// What a scan the owner starts may spend, said before he presses (docs/search-budget.md, Nov 23 "honest spend").
// Reading Home Depot is free; only Amazon prices can cost searches, never more than the per-scan limit, and never from
// the reserve: at or below it a scan spends none (the agent keeps the reserve for his explicit "Use searches for these").
// Pure: every place that starts a scan reads it.

import type { AppState } from '../api/types';
import { plural, upToSearches } from './format';

type Budget = Pick<AppState['budget'], 'serpLeft' | 'serpReserve' | 'serpPerScan'>;

export interface ScanSpend {
  /** For a button's cost pill: "up to 18 searches" or "no searches". */
  cost: string;
  /** The sentence, for a tooltip or a line under the control. */
  sentence: string;
}

/** The most a scan may spend now: the per-scan limit, and what the account holds above the reserve. */
export function scanSearchCeiling(b: Budget): number {
  const cap = Math.max(0, b.serpPerScan);
  return b.serpLeft === null ? cap : Math.min(cap, Math.max(0, b.serpLeft - b.serpReserve));
}

export function scanSpend(b: Budget): ScanSpend {
  const n = scanSearchCeiling(b);
  if (n > 0) return { cost: upToSearches(n), sentence: `May use up to ${plural(n, 'search', 'searches')} for Amazon prices; reading Home Depot is free.` };
  if (b.serpPerScan <= 0) return { cost: 'no searches', sentence: 'Uses no searches: the limit per scan is 0. Reading Home Depot is free.' };
  return {
    cost: 'no searches',
    sentence: `Uses no searches: ${plural(b.serpLeft ?? 0, 'search', 'searches')} left, at your reserve of ${b.serpReserve}. Reading Home Depot is free.`,
  };
}
