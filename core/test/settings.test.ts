import { beforeAll, describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import type { FeeSettings } from '../src/money';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanReport, type ScanSettings } from '../src/scan/types';
import { forecastUsage, validateSchedule } from '../src/schedule';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import {
  type AlertSettings,
  budgetPolicyFor,
  dealsToNotify,
  DEFAULT_SETTINGS,
  type ExtensionSettings,
  toScanSettings,
  validateSettings,
} from '../src/settings';
import * as fx from './fixtures';

const settings = (over: Partial<ExtensionSettings> = {}): ExtensionSettings => ({ ...DEFAULT_SETTINGS, ...over });
const fees = (over: Partial<FeeSettings>): FeeSettings => ({ ...DEFAULT_SETTINGS.fees, ...over });
const alerts = (over: Partial<AlertSettings>): AlertSettings => ({ ...DEFAULT_SETTINGS.alerts, ...over });

/** The free account sample with `left` searches left this month. */
const freeAccount = (left: number) =>
  parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, total_searches_left: left, plan_searches_left: left, this_month_usage: 250 - left });

const SEARCHES = 'Use a whole number from 1 to 250.';
const RESERVE = 'Use a whole number from 0 to 250.';
const PAGES = 'Use a whole number from 1 to 5.';
const NO_BRAND = 'Choose at least one brand.';
const BAD_BRANDS = 'Choose from DEWALT and RYOBI, each brand once.';
const REFERRAL = 'Use a referral fee from 0% to 100%.';
const FULFILLMENT = 'Use a fulfillment cost per unit of $0 or more.';
const MIN_REFERRAL = 'Use a minimum referral fee of $0 or more.';
const SALES_TAX = 'Use a sales tax of 0% or more.';
const INBOUND = 'Use an inbound cost per bundle of $0 or more.';
const MIN_PROFIT = 'Use a profit of $0 or more.';
const MIN_ROI = 'Use an ROI of 0% or more.';

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({});
  });

  it('accepts both ends of every range', () => {
    const valid: Partial<ExtensionSettings>[] = [
      { searchesPerScan: 1 }, { searchesPerScan: 250 },
      { reserve: 0 }, { reserve: 250 },
      { pagesPerBrand: 1 }, { pagesPerBrand: 5 },
      { brands: ['DEWALT'] }, { brands: ['RYOBI'] }, { brands: ['RYOBI', 'DEWALT'] },
      { fees: fees({ referralRate: 0, fulfillmentFee: 0, minReferral: 0, salesTaxRate: 0, inboundCost: 0 }) },
      { fees: fees({ referralRate: 1, fulfillmentFee: 6.5, minReferral: 0.3, salesTaxRate: 0.07, inboundCost: 2 }) },
      { alerts: { enabled: true, minProfit: 0, minRoiPercent: 0 } },
      { schedule: { mode: 'interval', hours: 6 } }, { schedule: { mode: 'daily', at: '07:00' } },
    ];
    for (const over of valid) expect(validateSettings(settings(over)), JSON.stringify(over)).toEqual({});
  });

  // Review Focus 4, line by line.

  it('says what is wrong when searches per scan is empty', () => {
    // An empty number field reads as NaN, or as 0 through Number('').
    expect(validateSettings(settings({ searchesPerScan: Number.NaN }))).toEqual({ searchesPerScan: SEARCHES });
    expect(validateSettings(settings({ searchesPerScan: Number('') }))).toEqual({ searchesPerScan: SEARCHES });
  });

  it('says what is wrong when searches per scan is negative', () => {
    expect(validateSettings(settings({ searchesPerScan: -5 }))).toEqual({ searchesPerScan: SEARCHES });
  });

  it('says what is wrong when searches per scan is 9999', () => {
    expect(validateSettings(settings({ searchesPerScan: 9999 }))).toEqual({ searchesPerScan: SEARCHES });
  });

  it('accepts a reserve as large as the whole plan; the forecast reports that scheduled scans cannot fit', () => {
    const plan = freeAccount(250).searchesPerMonth;
    expect(plan).toBe(250);
    const daily = settings({ schedule: { mode: 'daily', at: '07:00' }, reserve: plan });
    expect(validateSettings(daily)).toEqual({});
    expect(forecastUsage(daily.schedule, daily.searchesPerScan, plan, daily.reserve)).toEqual({
      searchesPerMonth: 150,
      fitsPlan: false,
      maxPerRunThatFits: 0,
    });
  });

  it('accepts a reserve above the searches left on the account; a scheduled scan then spends nothing', () => {
    const s = settings({ reserve: 200 });
    expect(validateSettings(s)).toEqual({});
    const budget = new SearchBudget(freeAccount(101), budgetPolicyFor(s, 'scheduled', 0));
    expect(budget.spendable).toBe(0);
    expect(budget.blockReason()).toBe('reserve');
  });

  it('says what is wrong with "every 0 hours", in the schedule\'s own words', () => {
    const zero = { mode: 'interval', hours: 0 } as const;
    expect(validateSchedule(zero)).toBe('Choose between 1 and 168 hours.');
    expect(validateSettings(settings({ schedule: zero }))).toEqual({ schedule: 'Choose between 1 and 168 hours.' });
    expect(validateSettings(settings({ schedule: { mode: 'daily', at: '7am' } }))).toEqual({
      schedule: validateSchedule({ mode: 'daily', at: '7am' }),
    });
  });

  // The rest of the fields.

  it('takes whole numbers only for searches per scan', () => {
    for (const n of [0, 2.5, 251, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(validateSettings(settings({ searchesPerScan: n })), String(n)).toEqual({ searchesPerScan: SEARCHES });
    }
  });

  it('takes whole numbers from 0 to 250 for the reserve', () => {
    for (const n of [-1, 2.5, 251, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateSettings(settings({ reserve: n })), String(n)).toEqual({ reserve: RESERVE });
    }
  });

  it('takes whole numbers from 1 to 5 for listing pages per brand', () => {
    for (const n of [0, 6, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateSettings(settings({ pagesPerBrand: n })), String(n)).toEqual({ pagesPerBrand: PAGES });
    }
  });

  it('needs at least one brand', () => {
    expect(validateSettings(settings({ brands: [] }))).toEqual({ brands: NO_BRAND });
  });

  it('takes only known brands, each once, in upper case', () => {
    for (const brands of [['DEWALT', 'DEWALT'], ['MILWAUKEE'], ['DEWALT', 'MILWAUKEE'], ['dewalt'], ['RYOBI', 'RYOBI', 'DEWALT']]) {
      expect(validateSettings(settings({ brands })), brands.join(',')).toEqual({ brands: BAD_BRANDS });
    }
  });

  it('checks every fee number', () => {
    const cases: [Partial<FeeSettings>, string][] = [
      [{ referralRate: -0.01 }, REFERRAL],
      [{ referralRate: 1.01 }, REFERRAL],
      [{ referralRate: 15 }, REFERRAL],
      [{ referralRate: Number.NaN }, REFERRAL],
      [{ fulfillmentFee: -1 }, FULFILLMENT],
      [{ fulfillmentFee: Number.NaN }, FULFILLMENT],
      [{ fulfillmentFee: Number.POSITIVE_INFINITY }, FULFILLMENT],
      [{ minReferral: -0.3 }, MIN_REFERRAL],
      [{ minReferral: Number.NaN }, MIN_REFERRAL],
      [{ salesTaxRate: -0.01 }, SALES_TAX],
      [{ salesTaxRate: Number.POSITIVE_INFINITY }, SALES_TAX],
      [{ inboundCost: -5 }, INBOUND],
      [{ inboundCost: Number.NaN }, INBOUND],
    ];
    for (const [over, message] of cases) {
      expect(validateSettings(settings({ fees: fees(over) })), JSON.stringify(over)).toEqual({ fees: message });
    }
  });

  it('gives one message for the fees, about the first wrong number', () => {
    expect(validateSettings(settings({ fees: fees({ referralRate: 2, inboundCost: -1 }) }))).toEqual({ fees: REFERRAL });
    expect(validateSettings(settings({ fees: fees({ salesTaxRate: -1, inboundCost: -1 }) }))).toEqual({ fees: SALES_TAX });
  });

  it('checks both alert numbers, whether alerts are on or off', () => {
    for (const enabled of [true, false]) {
      expect(validateSettings(settings({ alerts: alerts({ enabled, minProfit: -1 }) }))).toEqual({ alerts: MIN_PROFIT });
      expect(validateSettings(settings({ alerts: alerts({ enabled, minProfit: Number.NaN }) }))).toEqual({ alerts: MIN_PROFIT });
      expect(validateSettings(settings({ alerts: alerts({ enabled, minRoiPercent: -5 }) }))).toEqual({ alerts: MIN_ROI });
      expect(validateSettings(settings({ alerts: alerts({ enabled, minRoiPercent: Number.POSITIVE_INFINITY }) }))).toEqual({ alerts: MIN_ROI });
      expect(validateSettings(settings({ alerts: alerts({ enabled, minProfit: -1, minRoiPercent: -5 }) }))).toEqual({ alerts: MIN_PROFIT });
    }
  });

  it('gives one message per wrong field and nothing for the fields that are right', () => {
    const nonsense = settings({
      schedule: { mode: 'interval', hours: 0 },
      searchesPerScan: 9999,
      reserve: -1,
      brands: [],
      pagesPerBrand: 0,
      fees: fees({ referralRate: 2 }),
      alerts: alerts({ minProfit: -1 }),
    });
    expect(validateSettings(nonsense)).toEqual({
      schedule: 'Choose between 1 and 168 hours.',
      searchesPerScan: SEARCHES,
      reserve: RESERVE,
      brands: NO_BRAND,
      pagesPerBrand: PAGES,
      fees: REFERRAL,
      alerts: MIN_PROFIT,
    });
    expect(validateSettings(settings({ searchesPerScan: 9999, pagesPerBrand: 0 }))).toEqual({ searchesPerScan: SEARCHES, pagesPerBrand: PAGES });
  });
});

describe('toScanSettings', () => {
  it('gives the default scan settings for the default settings', () => {
    expect(toScanSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SCAN_SETTINGS);
  });

  it('makes one query per brand, in the known brand order', () => {
    const both = toScanSettings(settings({ brands: ['RYOBI', 'DEWALT'] }));
    expect(both.brands).toEqual(['RYOBI', 'DEWALT']);
    expect(both.queries).toEqual([{ q: 'dewalt 20v combo kit' }, { q: 'ryobi 18v combo kit' }]);

    const ryobi = toScanSettings(settings({ brands: ['RYOBI'] }));
    expect(ryobi.brands).toEqual(['RYOBI']);
    expect(ryobi.queries).toEqual([{ q: 'ryobi 18v combo kit' }]);

    const dewalt = toScanSettings(settings({ brands: ['DEWALT'] }));
    expect(dewalt.brands).toEqual(['DEWALT']);
    expect(dewalt.queries).toEqual([{ q: 'dewalt 20v combo kit' }]);
  });

  it('takes pages and fees from the settings and everything else from the defaults', () => {
    const own: FeeSettings = { referralRate: 0.12, fulfillmentFee: 6.5, minReferral: 0.3, salesTaxRate: 0.07, inboundCost: 2 };
    const scan = toScanSettings(settings({ pagesPerBrand: 3, fees: own }));
    expect(scan.pagesPerQuery).toBe(3);
    expect(scan.fees).toEqual(own);
    const { brands: _b, queries: _q, pagesPerQuery: _p, fees: _f, ...rest } = scan;
    const { brands: _db, queries: _dq, pagesPerQuery: _dp, fees: _df, ...defaults } = DEFAULT_SCAN_SETTINGS;
    expect(rest).toEqual(defaults);
    expect(Object.keys(rest).sort()).toEqual(
      ['amazonDomain', 'brandFilters', 'catalogPagesPerScan', 'freshnessMs', 'liquidationRate', 'listingMaxAgeMs', 'pageReadsPerScan'],
    );
  });

  it('returns its own copies, so changing them changes neither the settings nor the defaults', () => {
    const s = settings({ brands: ['DEWALT', 'RYOBI'], fees: fees({}) });
    const before = structuredClone(s);
    const defaultsBefore = structuredClone(DEFAULT_SCAN_SETTINGS);
    const scan: ScanSettings = toScanSettings(s);
    scan.brands.push('MILWAUKEE');
    scan.fees.referralRate = 0.5;
    scan.brandFilters.DEWALT = 'changed';
    scan.queries.push({ q: 'changed' });
    expect(s).toEqual(before);
    expect(DEFAULT_SCAN_SETTINGS).toEqual(defaultsBefore);
  });
});

describe('budgetPolicyFor', () => {
  const s = settings({ searchesPerScan: 5, reserve: 100 });

  it('keeps the reserve for a scheduled scan and gives it what is left of searches per scan', () => {
    expect(budgetPolicyFor(s, 'scheduled', 3)).toEqual({ reserve: 100, maxPerRun: 2 });
    expect(budgetPolicyFor(s, 'scheduled', 0)).toEqual({ reserve: 100, maxPerRun: 5 });
  });

  it('lets a scan the user starts spend from the reserve, within searches per scan', () => {
    expect(budgetPolicyFor(s, 'manual', 3)).toEqual({ reserve: 0, maxPerRun: 2 });
    expect(budgetPolicyFor(s, 'manual', 0)).toEqual({ reserve: 0, maxPerRun: 5 });
  });

  it('gives a continued job nothing once it has used its searches', () => {
    expect(budgetPolicyFor(s, 'scheduled', 9)).toEqual({ reserve: 100, maxPerRun: 0 });
    expect(budgetPolicyFor(s, 'manual', 9)).toEqual({ reserve: 0, maxPerRun: 0 });
    expect(budgetPolicyFor(s, 'scheduled', 5)).toEqual({ reserve: 100, maxPerRun: 0 });
  });

  it('builds a budget from the free account that never touches the reserve on a schedule', () => {
    const scheduled = new SearchBudget(freeAccount(101), budgetPolicyFor(s, 'scheduled', 0));
    expect(scheduled.spendable).toBe(1);
    scheduled.record();
    expect(scheduled.blockReason()).toBe('reserve');

    const manual = new SearchBudget(freeAccount(101), budgetPolicyFor(s, 'manual', 0));
    expect(manual.spendable).toBe(5);
  });

  it('keeps a scheduled job within searches per scan after it is continued', () => {
    // First run: 3 of 5 searches spent, then the worker stops.
    const first = new SearchBudget(freeAccount(250), budgetPolicyFor(s, 'scheduled', 0));
    expect(first.spendable).toBe(5);
    first.record(3);
    // Continued with the job's searchesUsed: only the other 2 may be spent.
    const second = new SearchBudget(freeAccount(247), budgetPolicyFor(s, 'scheduled', 3));
    expect(second.spendable).toBe(2);
    second.record(2);
    expect(second.blockReason()).toBe('run_cap');
    expect(first.spentThisRun + second.spentThisRun).toBe(5);
  });

  it('counts a negative searches-used count as 0', () => {
    expect(budgetPolicyFor(s, 'scheduled', -2)).toEqual({ reserve: 100, maxPerRun: 5 });
    expect(budgetPolicyFor(s, 'manual', -2)).toEqual({ reserve: 0, maxPerRun: 5 });
  });

  it("spends nothing when a continued job's searches-used count cannot be read", () => {
    // The job may already have spent its whole allowance; a fresh one could double it.
    for (const used of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(budgetPolicyFor(s, 'scheduled', used), String(used)).toEqual({ reserve: 100, maxPerRun: 0 });
      expect(budgetPolicyFor(s, 'manual', used), String(used)).toEqual({ reserve: 0, maxPerRun: 0 });
      expect(new SearchBudget(freeAccount(250), budgetPolicyFor(s, 'manual', used)).spendable).toBe(0);
    }
  });

  it('floors what is left after a fractional searches-used count', () => {
    expect(budgetPolicyFor(s, 'scheduled', 2.5)).toEqual({ reserve: 100, maxPerRun: 2 });
    expect(budgetPolicyFor(s, 'manual', 2.5)).toEqual({ reserve: 0, maxPerRun: 2 });
  });

  it('caps searches per scan at 250 and floors a fractional one before subtracting', () => {
    const big = settings({ searchesPerScan: 9999, reserve: 100 });
    expect(budgetPolicyFor(big, 'scheduled', 0)).toEqual({ reserve: 100, maxPerRun: 250 });
    expect(budgetPolicyFor(big, 'manual', 3)).toEqual({ reserve: 0, maxPerRun: 247 });
    const fractional = settings({ searchesPerScan: 7.9, reserve: 100 });
    expect(budgetPolicyFor(fractional, 'scheduled', 0)).toEqual({ reserve: 100, maxPerRun: 7 });
    // 7 - 2.5 floors to 4; flooring only after subtracting would give 5.
    expect(budgetPolicyFor(fractional, 'manual', 2.5)).toEqual({ reserve: 0, maxPerRun: 4 });
  });

  it('spends nothing when searches per scan cannot be read', () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      for (const trigger of ['scheduled', 'manual'] as const) {
        const policy = budgetPolicyFor(settings({ searchesPerScan: n, reserve: 100 }), trigger, 0);
        expect(policy.maxPerRun, `${n} ${trigger}`).toBe(0);
        expect(new SearchBudget(freeAccount(250), policy).spendable).toBe(0);
      }
    }
  });

  it('spends nothing on a schedule when the reserve cannot be read; Scan now does not need it', () => {
    for (const reserve of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const bad = settings({ searchesPerScan: 5, reserve });
      const scheduled = budgetPolicyFor(bad, 'scheduled', 0);
      expect(scheduled, String(reserve)).toEqual({ reserve: 0, maxPerRun: 0 });
      expect(new SearchBudget(freeAccount(250), scheduled).spendable).toBe(0);
      expect(budgetPolicyFor(bad, 'manual', 0)).toEqual({ reserve: 0, maxPerRun: 5 });
    }
  });
});

// The founder's scan from step 2, run on the recorded responses. Nothing reaches the network.
const T0 = Date.UTC(2026, 10, 9, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, queries: [{ q: 'ryobi extended reach ratchet' }] };

async function founderReport(): Promise<ScanReport> {
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({
    apiKey: 'TEST',
    budget,
    cache: new MemoryCache(),
    fetchFn: replayRecorded().fetchFn,
    now: () => T0,
  });
  await runScan({ client, budget, store, settings: RATCHET, now: () => T0 });
  return buildReport(store, RATCHET);
}

describe('dealsToNotify', () => {
  let report: ScanReport;
  beforeAll(async () => {
    report = await founderReport();
  });
  const on = (minProfit: number, minRoiPercent: number): AlertSettings => ({ enabled: true, minProfit, minRoiPercent });
  const models = (rows: { model: string }[]) => rows.map((r) => r.model);

  it("is the founder's report from step 2", () => {
    expect(report.bundles.filter((b) => b.section === 'confirmed').map((b) => [b.model, b.estimate?.profit, b.estimate?.roi])).toEqual([
      ['PBLRC2501SB', 79.55, 0.4209],
      ['PBLRC01B-PBLRC25B', -79.45, expect.any(Number)],
    ]);
  });

  it('notifies PBLRC2501SB only, at $50 and 30%', () => {
    const deals = dealsToNotify(report, on(50, 30), []);
    expect(models(deals)).toEqual(['PBLRC2501SB']);
    expect(deals[0]!.key).toBe('homedepot:328814689');
  });

  it('notifies nothing when its key is already notified', () => {
    expect(dealsToNotify(report, on(50, 30), ['homedepot:328814689'])).toEqual([]);
    expect(models(dealsToNotify(report, on(50, 30), ['homedepot:999']))).toEqual(['PBLRC2501SB']);
  });

  it('notifies nothing when alerts are off', () => {
    expect(dealsToNotify(report, { enabled: false, minProfit: 50, minRoiPercent: 30 }, [])).toEqual([]);
    expect(dealsToNotify(report, { enabled: false, minProfit: 0, minRoiPercent: 0 }, [])).toEqual([]);
  });

  it('needs both numbers cleared', () => {
    expect(dealsToNotify(report, on(50, 50), [])).toEqual([]); // ROI is 42.09%
    expect(dealsToNotify(report, on(80, 30), [])).toEqual([]); // profit is $79.55
  });

  it('counts a bundle exactly at both numbers', () => {
    // 0.4209 * 100 is 42.089999999999996 in floating point; the estimate's ROI is 42.09%.
    expect(models(dealsToNotify(report, on(79.55, 42.09), []))).toEqual(['PBLRC2501SB']);
    expect(dealsToNotify(report, on(79.56, 42.09), [])).toEqual([]);
    expect(dealsToNotify(report, on(79.55, 42.1), [])).toEqual([]);
  });

  it('skips a confirmed bundle whose estimate is null', () => {
    const noEstimate: ScanReport = {
      ...report,
      bundles: report.bundles.map((b) => (b.model === 'PBLRC2501SB' ? { ...b, estimate: null } : b)),
    };
    expect(models(dealsToNotify(noEstimate, on(-100, -100), []))).toEqual(['PBLRC01B-PBLRC25B']);
  });

  it('notifies only confirmed bundles', () => {
    const notConfirmed: ScanReport = { ...report, bundles: report.bundles.map((b) => ({ ...b, section: 'inactive_listing' as const })) };
    expect(dealsToNotify(notConfirmed, on(50, 30), [])).toEqual([]);
  });

  it("keeps the report's own order", () => {
    expect(models(dealsToNotify(report, on(-100, -100), []))).toEqual(['PBLRC2501SB', 'PBLRC01B-PBLRC25B']);
    const reversed: ScanReport = { ...report, bundles: [...report.bundles].reverse() };
    expect(models(dealsToNotify(reversed, on(-100, -100), []))).toEqual(['PBLRC01B-PBLRC25B', 'PBLRC2501SB']);
  });
});
