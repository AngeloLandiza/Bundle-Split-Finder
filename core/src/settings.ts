// What the owner can change in Settings, its defaults, and what a scan makes of it:
// the check before saving, the scan's settings, the search budget per trigger, and
// which deals to notify after a scan.

import { DEFAULT_FEES, type FeeSettings } from './money';
import { CLAUDE_JUDGE_MODELS, DEFAULT_CLAUDE_JUDGE_MODEL } from './judge/claude';
import { costOf, PRICE_TABLE } from './judge/eval';
import { type Schedule, validateSchedule } from './schedule';
import type { BudgetPolicy } from './serpapi/budget';
import { DEFAULT_LISTINGS_JUDGED_PER_SCAN, MAX_LISTINGS_JUDGED_PER_SCAN } from './scan/ebayPass';
import { type BundleRow, DEFAULT_SCAN_SETTINGS, type ScanReport, type ScanSettings } from './scan/types';

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

/**
 * Step 10: the eBay reference values' settings. Kept apart from ExtensionSettings: they are saved by their own
 * message and never validated with the scan's fields. The eBay and Anthropic keys are not settings: they are keys.
 */
export interface EbaySettings {
  /** One of CLAUDE_JUDGE_MODELS. */
  judgeModel: string;
  /** Listings a model is asked about in one scan: the owner's cost cap. 1 to MAX_LISTINGS_JUDGED_PER_SCAN. */
  listingsJudgedPerScan: number;
}

export const DEFAULT_EBAY_SETTINGS: EbaySettings = { judgeModel: DEFAULT_CLAUDE_JUDGE_MODEL, listingsJudgedPerScan: DEFAULT_LISTINGS_JUDGED_PER_SCAN };

/** The problem with these eBay settings in one sentence, or null. Anything that is not a known model and a whole number in range is one. */
export function ebaySettingsProblem(s: unknown): string | null {
  const v = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
  if (typeof v.judgeModel !== 'string' || !(CLAUDE_JUDGE_MODELS as readonly string[]).includes(v.judgeModel)) return 'Choose one of the models offered.';
  const n = v.listingsJudgedPerScan;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_LISTINGS_JUDGED_PER_SCAN) {
    return `Use a whole number of listings from 1 to ${MAX_LISTINGS_JUDGED_PER_SCAN}.`;
  }
  return null;
}

/**
 * Roughly what one listing costs the model: the judge's instructions (about 1,100 tokens), the listing's text (about 400
 * on average, over the 217 recorded listings) and the schema on the way in; the answer and its thinking on the way out.
 * An estimate for Settings to say out loud, not a measurement: `npm run judge:eval` measures the real figure.
 */
export const ESTIMATED_TOKENS_PER_LISTING = { input: 1700, output: 500 } as const;

/** Dollars a scan may cost the owner at `listings` listings judged, at the model's published rates; null for a model with no rate. */
export function estimatedJudgeCost(model: string, listings: number): number | null {
  const rates = PRICE_TABLE[model];
  if (!rates || !Number.isFinite(listings) || listings < 0) return null;
  return costOf({ inputTokens: ESTIMATED_TOKENS_PER_LISTING.input * listings, outputTokens: ESTIMATED_TOKENS_PER_LISTING.output * listings }, rates);
}

/** Who asked for a scan. A scheduled scan may never touch the reserve; one the user starts may. */
export type ScanTrigger = 'scheduled' | 'manual';

// ---------------------------------------------------------------- validation

export type SettingsField = 'schedule' | 'searchesPerScan' | 'reserve' | 'brands' | 'pagesPerBrand' | 'fees' | 'alerts';

const isWhole = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;
const isAtLeastZero = (n: number): boolean => Number.isFinite(n) && n >= 0;

/** The first wrong fee number, in the order the fields are declared, or null. */
function feeProblem(f: FeeSettings): string | null {
  if (!(Number.isFinite(f.referralRate) && f.referralRate >= 0 && f.referralRate <= 1)) return 'Use a referral fee from 0% to 100%.';
  if (!isAtLeastZero(f.fulfillmentFee)) return 'Use a fulfillment cost per unit of $0 or more.';
  if (!isAtLeastZero(f.minReferral)) return 'Use a minimum referral fee of $0 or more.';
  if (!isAtLeastZero(f.salesTaxRate)) return 'Use a sales tax of 0% or more.';
  if (!isAtLeastZero(f.inboundCost)) return 'Use an inbound cost per bundle of $0 or more.';
  return null;
}

function alertProblem(a: AlertSettings): string | null {
  if (!isAtLeastZero(a.minProfit)) return 'Use a profit of $0 or more.';
  if (!isAtLeastZero(a.minRoiPercent)) return 'Use an ROI of 0% or more.';
  return null;
}

function brandProblem(brands: string[]): string | null {
  if (brands.length === 0) return 'Choose at least one brand.';
  const known: readonly string[] = KNOWN_BRANDS;
  const allKnown = brands.every((b) => known.includes(b));
  if (!allKnown || new Set(brands).size !== brands.length) return `Choose from ${KNOWN_BRANDS.join(' and ')}, each brand once.`;
  return null;
}

/** A message per invalid field, keyed by field name; empty when everything is valid. */
export function validateSettings(s: ExtensionSettings): Partial<Record<SettingsField, string>> {
  const problems: Partial<Record<SettingsField, string>> = {};
  const add = (field: SettingsField, message: string | null) => {
    if (message !== null) problems[field] = message;
  };
  add('schedule', validateSchedule(s.schedule));
  add('searchesPerScan', isWhole(s.searchesPerScan, 1, 250) ? null : 'Use a whole number from 1 to 250.');
  add('reserve', isWhole(s.reserve, 0, 250) ? null : 'Use a whole number from 0 to 250.');
  add('brands', brandProblem(s.brands));
  add('pagesPerBrand', isWhole(s.pagesPerBrand, 1, 5) ? null : 'Use a whole number from 1 to 5.');
  add('fees', feeProblem(s.fees));
  add('alerts', alertProblem(s.alerts));
  return problems;
}

// ---------------------------------------------------------------- the scan

const BRAND_QUERIES: Record<(typeof KNOWN_BRANDS)[number], string> = {
  DEWALT: 'dewalt 20v combo kit',
  RYOBI: 'ryobi 18v combo kit',
};

export function toScanSettings(s: ExtensionSettings): ScanSettings {
  return {
    ...DEFAULT_SCAN_SETTINGS,
    brandFilters: { ...DEFAULT_SCAN_SETTINGS.brandFilters },
    brands: [...s.brands],
    // One query per chosen brand, always in KNOWN_BRANDS order.
    queries: KNOWN_BRANDS.filter((b) => s.brands.includes(b)).map((b) => ({ q: BRAND_QUERIES[b] })),
    pagesPerQuery: s.pagesPerBrand,
    fees: { ...s.fees },
  };
}

/**
 * The budget policy for a scan. `usedSoFar` is the job's searchesUsed when it is being continued.
 *
 * A scheduled scan keeps the owner's reserve; a scan the user starts may spend it, down to zero.
 * Either way the whole job, across every continuation, spends at most searchesPerScan
 * (whole searches, at most 250). A number that cannot be read spends nothing rather than guess:
 * an unreadable allowance or searches-used count gives any scan 0, and an unreadable reserve
 * gives a scheduled scan 0. A negative searches-used count counts as 0.
 */
export function budgetPolicyFor(s: ExtensionSettings, trigger: ScanTrigger, usedSoFar: number): BudgetPolicy {
  const allowance = isAtLeastZero(s.searchesPerScan) ? Math.floor(Math.min(s.searchesPerScan, 250)) : 0;
  // A continued job whose usage cannot be read may already have spent its whole allowance.
  const maxPerRun = Number.isFinite(usedSoFar) ? Math.max(0, Math.floor(allowance - Math.max(0, usedSoFar))) : 0;
  if (trigger === 'manual') return { reserve: 0, maxPerRun };
  if (!isAtLeastZero(s.reserve)) return { reserve: 0, maxPerRun: 0 };
  return { reserve: s.reserve, maxPerRun };
}

/** An estimate's return in percent. ROI is rounded to 4 places, so this is exact to 2. */
const roiPercent = (roi: number): number => Math.round(roi * 10_000) / 100;

/** Confirmed bundles that clear both alert numbers and were not notified before. */
export function dealsToNotify(report: ScanReport, alerts: AlertSettings, alreadyNotified: string[]): BundleRow[] {
  if (!alerts.enabled) return [];
  const notified = new Set(alreadyNotified);
  return report.bundles.filter(
    (b) =>
      b.section === 'confirmed' &&
      b.estimate !== null &&
      b.estimate.profit >= alerts.minProfit &&
      roiPercent(b.estimate.roi) >= alerts.minRoiPercent &&
      !notified.has(b.key),
  );
}
