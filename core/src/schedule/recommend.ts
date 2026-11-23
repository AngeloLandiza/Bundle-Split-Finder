// The schedule to start the owner on (Welcome, "Let it run by itself"): the most frequent one the account's searches
// can pay for, worked out from the plan, the reserve, the per-scan cap and what a scan really uses. Pure.
//
// The account has a plan of searches a month (SerpApi's free plan: 250). The owner's reserve is never for scheduled
// scans (core/src/settings.ts budgetPolicyFor), so a schedule has plan - reserve to spend, and the recommendation keeps
// HEADROOM of that unspent: a scan that finds more new parts than usual must not push the month past the reserve.
//
// What a scan uses: its own recent runs when there are any (the median, so one big first scan does not rule), else a
// documented default. With a Keepa key the Amazon lookups are paid from Keepa's tokens, so a scan spends searches only
// on Home Depot's listing pages and catalog pages (3 to 5 recorded; 4 here). Without it every new part's Amazon lookup is
// one more search; 10 is that 4 plus about 6 new parts a scan, an assumption the first real runs replace.
//
// Free scan (Nov 23): with the bundle lists read in Chrome (scan/listingSource.ts) a scan spends no search to find bundles,
// and with Keepa none on Amazon either (the brand pages are not read; lookups go to Keepa). The schedule is then bounded
// by how often Home Depot should be read, MIN_SCAN_INTERVAL_HOURS, not by the search budget, and the month's searches go
// to the automatic listing confirmation and the lookups the owner starts. Without Keepa each new part's lookup is still
// a search (about 6 a scan).

import type { Schedule } from '../schedule';

/** Searches a scan uses with a Keepa key: Home Depot listing and catalog pages (3 to 5 recorded). */
export const KEEPA_SCAN_SEARCHES = 4;
/** Searches a scan is assumed to use without Keepa: the pages plus about 6 Amazon lookups. Replaced by recent runs. */
export const NO_KEEPA_SCAN_SEARCHES = 10;
/** Free scan without Keepa: only the new parts' Amazon lookups are searches (the 6 of NO_KEEPA_SCAN_SEARCHES beyond the pages). */
export const CHROME_NO_KEEPA_SCAN_SEARCHES = NO_KEEPA_SCAN_SEARCHES - KEEPA_SCAN_SEARCHES;
/**
 * The most often a schedule reads Home Depot, in hours (politeness, not budget). A scan reads each brand's Bundle list (2 to 3
 * pages a brand), the BOGO lists (up to 15 pages a brand), and item pages only when they are new or older than 6 hours
 * (listingSource.ts LISTING_ITEM_MAX_AGE_MS; BOGO items once a day), at most 60 page reads a scan, paced as a person's tab.
 * Every 3 hours is at most 8 such passes a day, each a few minutes long: the reads of a person checking the deals now and then.
 */
export const MIN_SCAN_INTERVAL_HOURS = 3;
/** The free scan's own option, first: offered only when the lists are read in Chrome. */
export const FREE_SCAN_OPTION: ScheduleOption = {
  id: 'every-3-hours', label: 'Every 3 hours while Chrome is open', schedule: { mode: 'interval', hours: MIN_SCAN_INTERVAL_HOURS }, scansPerMonth: (30 * 24) / MIN_SCAN_INTERVAL_HOURS,
};
/** The share of the usable searches a recommendation may plan to spend. */
export const HEADROOM = 0.85;
/** Hours in the 30-day month the forecast in Settings uses; the monthly figures here follow it. */
const MONTH_HOURS = 30 * 24;

export type ScheduleOptionId = 'every-3-hours' | 'twice-a-day' | 'daily' | 'every-2-days' | 'twice-a-week' | 'weekly' | 'manual';

export interface ScheduleOption {
  id: ScheduleOptionId;
  /** "Twice a day", "Daily at 7:00". */
  label: string;
  schedule: Schedule;
  /** Scans in a 30-day month; 0 for manual. */
  scansPerMonth: number;
}

/** From most to least frequent; the recommendation is the first that fits. */
export const SCHEDULE_OPTIONS: readonly ScheduleOption[] = [
  { id: 'twice-a-day', label: 'Twice a day', schedule: { mode: 'interval', hours: 12 }, scansPerMonth: 60 },
  { id: 'daily', label: 'Daily at 7:00', schedule: { mode: 'daily', at: '07:00' }, scansPerMonth: 30 },
  { id: 'every-2-days', label: 'Every 2 days', schedule: { mode: 'interval', hours: 48 }, scansPerMonth: 15 },
  { id: 'twice-a-week', label: 'Twice a week', schedule: { mode: 'interval', hours: 84 }, scansPerMonth: Math.ceil(MONTH_HOURS / 84) },
  { id: 'weekly', label: 'Once a week', schedule: { mode: 'interval', hours: 168 }, scansPerMonth: Math.ceil(MONTH_HOURS / 168) },
  { id: 'manual', label: 'Only when I press Scan now', schedule: { mode: 'manual' }, scansPerMonth: 0 },
];

export interface RecommendInput {
  /** Searches the plan gives a month (the account check); absent or unreadable: SerpApi's free 250. */
  monthly: number | null | undefined;
  /** Searches a scheduled scan must leave on the account. */
  reserve: number;
  /** The most one scan may spend (Settings). */
  perScanCap: number;
  /** A Keepa key is saved and Amazon lookups go through it. */
  hasKeepa: boolean;
  /** Searches the account has left this month, when known: a month already spent has less to schedule. */
  searchesLeft?: number | null;
  /** Recent scans, newest first. Only finished or limited scans that spent something say what a scan uses. */
  recentRuns?: readonly { kind: string; status: string; searchesUsed: number }[];
  /**
   * Free scan: 'chrome' when the bundle lists are read in Chrome (Settings scan.listingSource auto or chrome). Its scans
   * spend no search to find bundles, so recent runs (which paid for listing pages) do not say what a scan spends now.
   * Absent or 'serpapi': SerpApi's listing pages, as before.
   */
  discovery?: 'chrome' | 'serpapi';
  now: Date;
}

export interface ScheduleChoice extends ScheduleOption {
  /** Searches a month at this schedule with the planned searches a scan. */
  searchesPerMonth: number;
  fits: boolean;
}

export interface ScheduleRecommendation {
  option: ScheduleChoice;
  /** Searches a scan is planned to use, never above the per-scan cap. */
  perScan: number;
  perScanBasis: 'recent' | 'keepa' | 'no-keepa' | 'chrome-keepa' | 'chrome';
  /** The plan's searches a month after the reserve. */
  usable: number;
  /** The headline: "Daily at 7:00. About 4 searches a scan, about 120 a month, inside your 150." */
  sentence: string;
  /** The plain arithmetic: "30 scans × 4 searches = about 120 a month. Your plan gives 250, the reserve keeps 100, so 150 are left to spend." */
  arithmetic: string;
  /** Every choice with whether it fits, most frequent first. */
  options: ScheduleChoice[];
}

/** How many searches a scan uses: the median of its recent runs, else the documented default. Never below 1, never above the cap. */
export function typicalScanSearches(input: Pick<RecommendInput, 'hasKeepa' | 'recentRuns' | 'perScanCap' | 'discovery'>): { perScan: number; basis: ScheduleRecommendation['perScanBasis'] } {
  const cap = Math.max(1, Number.isFinite(input.perScanCap) ? Math.floor(input.perScanCap) : 1);
  // Free scan: nothing is searched to find bundles; with Keepa nothing is searched on Amazon either.
  if (input.discovery === 'chrome') return input.hasKeepa ? { perScan: 0, basis: 'chrome-keepa' } : { perScan: Math.min(cap, CHROME_NO_KEEPA_SCAN_SEARCHES), basis: 'chrome' };
  const used = (input.recentRuns ?? [])
    .filter((r) => r.kind === 'scan' && (r.status === 'finished' || r.status === 'limit') && Number.isFinite(r.searchesUsed) && r.searchesUsed > 0)
    .slice(0, 5)
    .map((r) => r.searchesUsed)
    .sort((a, b) => a - b);
  if (used.length > 0) {
    const mid = used.length % 2 === 1 ? used[(used.length - 1) / 2]! : (used[used.length / 2 - 1]! + used[used.length / 2]!) / 2;
    return { perScan: Math.min(cap, Math.max(1, Math.ceil(mid))), basis: 'recent' };
  }
  return input.hasKeepa
    ? { perScan: Math.min(cap, KEEPA_SCAN_SEARCHES), basis: 'keepa' }
    : { perScan: Math.min(cap, NO_KEEPA_SCAN_SEARCHES), basis: 'no-keepa' };
}

/** Days left in the month, today included. */
const daysLeftIn = (now: Date): number => new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;

const n = (v: number): string => v.toLocaleString('en-US');
const searches = (v: number): string => `${n(v)} ${v === 1 ? 'search' : 'searches'}`;

/**
 * The most frequent schedule that stays inside the budget with headroom, for a month in steady state and for what is
 * left of this one. Never one that plans to spend the reserve: when even the least frequent does not fit, the answer is
 * "only when I press Scan now".
 */
export function recommendSchedule(input: RecommendInput): ScheduleRecommendation {
  const monthly = typeof input.monthly === 'number' && Number.isFinite(input.monthly) && input.monthly > 0 ? Math.floor(input.monthly) : 250;
  const reserve = Number.isFinite(input.reserve) ? Math.max(0, Math.floor(input.reserve)) : 0;
  const usable = Math.max(0, monthly - reserve);
  const { perScan, basis } = typicalScanSearches(input);
  // What the account can still pay this month: its own count when known, never more than a whole month's usable.
  const left = typeof input.searchesLeft === 'number' && Number.isFinite(input.searchesLeft) ? Math.max(0, Math.floor(input.searchesLeft) - reserve) : usable;
  const thisMonth = Math.min(usable, left);
  const daysLeft = daysLeftIn(input.now);

  const offered = input.discovery === 'chrome' ? [FREE_SCAN_OPTION, ...SCHEDULE_OPTIONS] : SCHEDULE_OPTIONS;
  const options: ScheduleChoice[] = offered.map((o) => {
    const searchesPerMonth = o.scansPerMonth * perScan;
    const hours = o.schedule.mode === 'interval' ? o.schedule.hours : o.schedule.mode === 'daily' ? 24 : 0;
    // The first scan is one interval after the schedule is switched on; counting every interval of what is left
    // of the month up can only ask for more than will be spent.
    const scansLeft = hours === 0 ? 0 : Math.ceil((daysLeft * 24) / hours);
    const fits = o.id === 'manual' || (searchesPerMonth <= usable * HEADROOM && scansLeft * perScan <= thisMonth * HEADROOM);
    return { ...o, searchesPerMonth, fits };
  });
  const option = options.find((o) => o.fits)!;

  const plan = `Your plan gives ${n(monthly)} a month and the reserve keeps ${n(reserve)}, so ${n(usable)} are left to spend.`;
  if (perScan === 0) {
    // Free scan with Keepa: the budget does not bound the schedule; Home Depot's politeness limit does.
    return {
      option,
      perScan,
      perScanBasis: basis,
      usable,
      sentence: `${option.label}. A scan spends no searches to find bundles: Home Depot's lists are read in Chrome and Amazon lookups go to Keepa first.`,
      arithmetic: `Home Depot is read at most every ${MIN_SCAN_INTERVAL_HOURS} hours, so the schedule is set by that, not by searches. ${plan} They go to confirming listings, the lookups you start, and a lookup Keepa cannot pay for (never the reserve).`,
      options,
    };
  }
  if (option.id === 'manual') {
    const weekly = options.find((o) => o.id === 'weekly')!;
    return {
      option,
      perScan,
      perScanBasis: basis,
      usable,
      sentence: 'Only when I press Scan now. Scheduled scans would not fit your plan and keep your reserve.',
      arithmetic: `A scan uses about ${searches(perScan)}, so one a week would use about ${n(weekly.searchesPerMonth)} a month. ${plan}`,
      options,
    };
  }
  return {
    option,
    perScan,
    perScanBasis: basis,
    usable,
    sentence: `${option.label}. About ${searches(perScan)} a scan, about ${n(option.searchesPerMonth)} a month, inside your ${n(usable)}.`,
    arithmetic: `${n(option.scansPerMonth)} scans × ${searches(perScan)} = about ${n(option.searchesPerMonth)} a month. ${plan}`,
    options,
  };
}
