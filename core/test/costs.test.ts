// Step 18, the costs (core/src/costs): days from real-shaped ledgers, the seeded forecast, the blocker's answer, the
// warnings once each, and the settings. No network; the clock and the time zone are fixed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { decide, type CostRoom } from '../src/costs/decide';
import { forecastService, MIN_HISTORY_DAYS, seededRandom } from '../src/costs/forecast';
import { costSettingsOf, patchCostSettings, syncAiLimit } from '../src/costs/settings';
import { localDate } from '../src/costs/time';
import { DEFAULT_COST_SETTINGS, type CostSettings } from '../src/costs/types';
import { aiEvents, byDay, keepaEvents, monthDays, parseKeepaLedger, serpEvents } from '../src/costs/usage';
import { buildCostsView, freeSerpPlan, scheduledRunsLeft, type CostRun, type CostsInput } from '../src/costs/view';
import { costWarnings } from '../src/costs/warnings';
import { parseLedger } from '../src/serpapi/balance';

const NY = 'America/New_York';
const ROOT = join(import.meta.dirname, '..', '..');
const LEDGERS = join(ROOT, 'fixtures', 'costs', 'after-scan6-ledgers');
const serpRows = parseLedger(readFileSync(join(LEDGERS, 'serpapi-ledger.jsonl'), 'utf8'));
const keepaRows = parseKeepaLedger(readFileSync(join(LEDGERS, 'keepa-ledger.jsonl'), 'utf8'));
const activity = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'e2e-2026-11-23', 'after-scan6', 'store', 'activity.json'), 'utf8')) as { runs: CostRun[] };

const settings = (over: Partial<CostSettings> = {}): CostSettings => ({ ...structuredClone(DEFAULT_COST_SETTINGS), ...over });

function input(over: Partial<CostsInput> = {}): CostsInput {
  return {
    now: Date.parse('2026-11-25T17:00:00Z'), tz: NY, settings: settings(), schedule: { mode: 'manual' }, lastScheduledRunAt: null,
    caps: { searchesPerScan: 18, verifySearchesPerDay: 5 },
    serp: { rows: serpRows, plan: { perMonth: 250, planName: 'Free Plan' } },
    keepa: { rows: keepaRows, refillPerMin: 1 },
    ai: { suggestions: [], runs: activity.runs, label: 'AI (Anthropic)' },
    counts: {}, runs: activity.runs, blocked: {},
    ...over,
  };
}

describe('the ledgers, by local day', () => {
  it('reads the real-shaped ledgers: 43 searches and 1,058 Keepa tokens over Nov 23 and 24', () => {
    expect(serpRows).toHaveLength(43);
    expect(keepaRows.length).toBeGreaterThan(500);
    const days = monthDays(serpEvents(serpRows), '2026-11-25', NY);
    expect(days).toHaveLength(25);
    expect(days.reduce((n, d) => n + d.used, 0)).toBe(43);
    expect(monthDays(keepaEvents(keepaRows), '2026-11-25', NY).reduce((n, d) => n + d.used, 0)).toBe(1058);
    // New York: every search was on Nov 23 there, the Verify at 02:13 UTC on Nov 24 included (21:13 on the 23rd).
    const byNy = byDay(serpEvents(serpRows), NY);
    expect([...byNy.keys()].sort()).toEqual(['2026-11-23']);
    expect(byNy.get('2026-11-23')!.used).toBe(43);
    // In UTC that Verify is on Nov 24.
    expect(byDay(serpEvents(serpRows), 'UTC').get('2026-11-24')!.used).toBe(1);
  });

  it('puts a row on its local day across a month boundary and a time-zone edge', () => {
    const rows = [{ at: '2026-12-01T03:30:00Z' }, { at: '2026-12-01T05:30:00Z' }, { at: '2026-11-30T23:59:59Z' }];
    // 03:30Z on Dec 1 is still Nov 30 in New York (UTC-5); 05:30Z is Dec 1.
    expect(localDate(Date.parse(rows[0]!.at), NY)).toBe('2026-11-30');
    expect(localDate(Date.parse(rows[1]!.at), NY)).toBe('2026-12-01');
    const nov = monthDays(serpEvents(rows), '2026-11-30', NY);
    expect(nov.at(-1)).toEqual({ date: '2026-11-30', used: 2, usd: 0 });
    const dec = monthDays(serpEvents(rows), '2026-12-01', NY);
    expect(dec).toEqual([{ date: '2026-12-01', used: 1, usd: 0 }]);
    // In UTC the same rows split the other way.
    expect(monthDays(serpEvents(rows), '2026-12-01', 'UTC')).toEqual([{ date: '2026-12-01', used: 2, usd: 0 }]);
  });

  it("counts the AI's dollars once each: an ask, its brief, a run's eBay judge", () => {
    const ev = aiEvents({
      suggestions: [{ askedAt: Date.parse('2026-11-24T10:00:00Z'), costUsd: 0.07, briefMeta: { at: Date.parse('2026-11-24T10:01:00Z'), costUsd: 0.17 } }, { askedAt: Date.parse('2026-11-24T11:00:00Z'), costUsd: null }],
      runs: [{ startedAt: '2026-11-23T19:28:48.577Z', judgeCostUsd: 0.035144 }, { startedAt: '2026-11-23T09:00:39.957Z' }],
    });
    expect(ev.map((e) => e.usd)).toEqual([0.07, 0.17, 0.035144]);
  });

  it('skips a damaged Keepa ledger line', () => {
    expect(parseKeepaLedger('{"at":"2026-11-23T10:00:00Z","tokens":11}\n{"at":\n{"at":"x"}\n')).toEqual([{ at: '2026-11-23T10:00:00Z', tokens: 11 }]);
  });
});

describe('the forecast', () => {
  const days14 = [0, 3, 0, 17, 1, 0, 0, 16, 2, 0, 1, 0, 3, 0];

  it('resamples the owner own days with a seeded bootstrap: the same data gives the same figures', () => {
    const f = forecastService({ unit: 'searches', used: 43, todayUsed: 0, limit: 100, today: '2026-11-15', runSamples: [], daySamples: days14, runsLeft: [], bound: null, seed: 7 });
    const again = forecastService({ unit: 'searches', used: 43, todayUsed: 0, limit: 100, today: '2026-11-15', runSamples: [], daySamples: days14, runsLeft: [], bound: null, seed: 7 });
    expect(f).toEqual(again);
    expect(f).toMatchObject({ basis: 'history', days: 14, runs: 0, expected: 90, low: 66, high: 123, limitReachedOn: null });
    expect(f.low).toBeLessThanOrEqual(f.expected);
    expect(f.expected).toBeLessThanOrEqual(f.high);
    expect(f.method).toBe('From your 14 days of history: a day used 0 to 17 searches; 15 days are left, and 8 in 10 of 2,000 replays of the rest of the month end in the range shown.');
  });

  it('adds each scheduled scan left, drawn from what a scan used, and names the day the limit is reached', () => {
    const runsLeft = ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'];
    const f = forecastService({ unit: 'searches', used: 120, todayUsed: 1, limit: 200, today: '2026-11-25', runSamples: [16, 17, 3, 1, 0, 18], daySamples: days14, runsLeft, bound: null, seed: 11 });
    expect(f).toMatchObject({ basis: 'history', days: 14, runs: 6, expected: 182, low: 158, high: 212, limitReachedOn: null });
    const tight = forecastService({ unit: 'searches', used: 120, todayUsed: 1, limit: 150, today: '2026-11-25', runSamples: [16, 17, 3, 1, 0, 18], daySamples: days14, runsLeft, bound: null, seed: 11 });
    expect(tight.limitReachedOn).toBe('2026-11-28');
    expect(tight.method).toMatch(/^From your 14 days and 6 scans of history: a day used 0 to 17 searches, each scan 0 to 18 searches; 5 days and 5 scheduled scans are left, /);
  });

  it(`is the bound the settings allow, said as one, with fewer than ${MIN_HISTORY_DAYS} days`, () => {
    const f = forecastService({
      unit: 'searches', used: 43, todayUsed: 0, limit: null, today: '2026-11-25', runSamples: [3, 1, 16, 3, 0, 1, 17], daySamples: [42, 1], runsLeft: [],
      bound: { perRun: 18, perDay: 5, cap: null, words: '5 searches a day for the listing check, plus any scan you start yourself' }, seed: 1,
    });
    expect(f).toEqual({
      expected: 73, low: 43, high: 73, basis: 'settings', days: 2, runs: 7, limitReachedOn: null,
      method: "Only 2 days of history (7 are needed to forecast from it), so this is the most your settings allow by month's end: 5 searches a day for the listing check, plus any scan you start yourself.",
    });
    // The AI: its limit is the bound.
    const ai = forecastService({ unit: 'usd', used: 1.86, todayUsed: 0, limit: 25, today: '2026-11-25', runSamples: [], daySamples: [1.1, 0.76], runsLeft: [], bound: { perRun: null, perDay: null, cap: 25, words: 'your $25.00 AI limit' }, seed: 1 });
    expect(ai).toMatchObject({ basis: 'settings', expected: 25, low: 1.86, high: 25 });
  });

  it('draws the same numbers from the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('the costs view', () => {
  it('prices the free SerpApi plan at $0 and names a subscription with no price', () => {
    const v = buildCostsView(input());
    const serp = v.services.find((s) => s.service === 'serpapi')!;
    expect(serp).toMatchObject({ used: 43, monthlyPriceUsd: 0, planLimit: 250, usdPerUnit: 0, forecastUsd: 0 });
    expect(v.total.unpriced).toEqual(['keepa']);
    expect(v.total.sentence).toMatch(/Keepa is not counted: no price entered\.$/);
    expect(freeSerpPlan({ perMonth: 1000, planName: 'Developer' })).toBe(false);
    expect(freeSerpPlan({ perMonth: 250 })).toBe(true);
    // A paid plan with no price entered: left out and named.
    const paid = buildCostsView(input({ serp: { rows: serpRows, plan: { perMonth: 1000, planName: 'Developer' } } }));
    expect(paid.total.unpriced).toEqual(['serpapi', 'keepa']);
    expect(paid.services[0]!.monthlyPriceUsd).toBeNull();
  });

  it("adds the entered prices from the month's first day and the AI's dollars by day", () => {
    const s = settings();
    s.services.keepa.monthlyPriceUsd = 49;
    s.totalMonthlyUsd = 60;
    const v = buildCostsView(input({ settings: s }));
    expect(v.total).toMatchObject({ fixedUsd: 49, meteredUsd: 0.14, spentUsd: 49.14, budgetUsd: 60, unpriced: [] });
    expect(v.days[0]).toMatchObject({ date: '2026-11-01', usd: 49, cumulativeUsd: 49, byService: { keepa: 49 } });
    expect(v.days.at(-1)!.cumulativeUsd).toBeCloseTo(49.135026, 6);
    expect(v.services.find((x) => x.service === 'keepa')).toMatchObject({ used: 1058, planLimit: 43200, usdPerUnit: 0.001134 });
  });

  it('says a limit reached and one approaching in plain words', () => {
    const s = settings();
    s.services.serpapi.monthlyLimit = 50;
    s.services.keepa.monthlyLimit = 1000;
    const v = buildCostsView(input({ settings: s }));
    expect(v.services.find((x) => x.service === 'serpapi')).toMatchObject({ state: 'approaching', sentence: '43 of 50 searches (86%).' });
    expect(v.services.find((x) => x.service === 'keepa')).toMatchObject({ state: 'over', sentence: 'Limit reached: 1,058 of 1,000 tokens.' });
  });

  it('lists the scheduled scans left in the month, by local day', () => {
    const now = Date.parse('2026-11-29T12:00:00Z');
    const left = scheduledRunsLeft({ mode: 'interval', hours: 12 }, now, now - 6 * 3_600_000, NY);
    // Due 18:00Z on the 29th (13:00 in New York), then 01:00 and 13:00 on the 30th; 01:00 on Dec 1 is next month.
    expect(left).toEqual(['2026-11-29', '2026-11-30', '2026-11-30']);
    expect(scheduledRunsLeft({ mode: 'manual' }, now, null, NY)).toEqual([]);
  });
});

const room = (over: Partial<CostRoom> = {}): CostRoom => ({ service: 'ai', unit: 'usd', label: 'AI', used: 24.69, limit: 25, total: { spentUsd: 24.69, budgetUsd: null }, blockWhenOver: true, today: '2026-11-25', ...over });

describe('the cost blocker', () => {
  const cards = { what: 'Review cards', held: 'were not written', expected: 0.2, high: 0.4 };

  it('allows a step whose high end stays inside the limit', () => {
    expect(decide('ai', cards, room({ used: 10 }))).toEqual({ allow: true, service: 'ai', expected: 0.2, high: 0.4, used: 10, limit: 25, reason: null });
  });

  it('holds one that would pass it, with a sentence the owner can act on', () => {
    expect(decide('ai', cards, room())).toMatchObject({
      allow: false,
      reason: 'Review cards were not written: expected to cost about $0.40, and $0.31 of your $25.00 AI limit is left. Raise the limit in Costs, or wait until Dec 1.',
    });
  });

  it('holds metered dollars at the total budget too', () => {
    const d = decide('ai', cards, room({ used: 2, total: { spentUsd: 49.8, budgetUsd: 50 } }));
    expect(d.reason).toBe('Review cards were not written: expected to cost about $0.40, and $0.20 of your $50.00 monthly budget is left. Raise the budget in Costs, or wait until Dec 1.');
  });

  it('only warns when the blocker is off, except at the AI limit', () => {
    const serp = decide('serpapi', { what: "The scan's Amazon searches", held: 'were not made', expected: 3, high: 16 }, room({ service: 'serpapi', unit: 'searches', label: 'SerpApi', used: 140, limit: 150, blockWhenOver: false }));
    expect(serp).toMatchObject({ allow: true, reason: "The scan's Amazon searches ran past a limit: expected to use about 16 searches, and 10 of your SerpApi limit of 150 searches are left. Raise the limit in Costs, or wait until Dec 1." });
    expect(decide('ai', cards, room({ blockWhenOver: false })).allow).toBe(false);
    // A budget refusal for the AI is a warning when the blocker is off; its own limit never is.
    expect(decide('ai', cards, room({ used: 2, total: { spentUsd: 49.8, budgetUsd: 50 }, blockWhenOver: false })).allow).toBe(true);
  });

  it('never holds a service with no limit of his own', () => {
    expect(decide('keepa', { what: 'Keepa lookups', held: 'were not made', expected: 11, high: 11 }, room({ service: 'keepa', unit: 'tokens', label: 'Keepa', used: 90_000, limit: null, total: undefined })).allow).toBe(true);
  });
});

describe('the warnings', () => {
  it('fire once a month each, the most serious first', () => {
    const s = settings();
    s.services.serpapi.monthlyLimit = 50;
    const v = buildCostsView(input({ settings: s }));
    const first = costWarnings(v, []);
    expect(first.warnings.map((w) => w.key)).toEqual(['2026-11:serpapi:approaching']);
    expect(first.warnings[0]!.title).toBe('SerpApi: 86% of your limit used');
    expect(costWarnings(v, first.warnings.map((w) => w.key)).warnings).toEqual([]);
    // Over the limit: only "limit reached" is sent, and the lesser warning is remembered with it.
    s.services.serpapi.monthlyLimit = 40;
    const over = costWarnings(buildCostsView(input({ settings: s })), []);
    expect(over.warnings.map((w) => w.key)).toEqual(['2026-11:serpapi:over']);
    expect(over.alsoSent).toEqual(['2026-11:serpapi:approaching']);
    // A new month starts again.
    const dec = buildCostsView(input({ settings: s, now: Date.parse('2026-12-02T17:00:00Z'), serp: { rows: [...serpRows, ...Array.from({ length: 45 }, () => ({ at: '2026-12-02T15:00:00Z' }))], plan: null } }));
    expect(costWarnings(dec, ['2026-11:serpapi:over', '2026-11:serpapi:approaching']).warnings.map((w) => w.key)).toEqual(['2026-12:serpapi:over']);
  });
});

describe('the settings', () => {
  it('refuses a negative price, an infinite limit, an AI price and a warn percent outside 50 to 100', () => {
    const cur = settings();
    expect(patchCostSettings(cur, { services: { keepa: { monthlyPriceUsd: -1 } } })).toMatchObject({ ok: false });
    expect(patchCostSettings(cur, { services: { serpapi: { monthlyLimit: Number.POSITIVE_INFINITY } } })).toMatchObject({ ok: false });
    expect(patchCostSettings(cur, { services: { ai: { monthlyPriceUsd: 20 } } })).toMatchObject({ ok: false });
    expect(patchCostSettings(cur, { services: { ai: { monthlyLimit: null } } })).toMatchObject({ ok: false });
    expect(patchCostSettings(cur, { services: { serpapi: { warnAtPercent: 40 } } })).toMatchObject({ ok: false });
    expect(patchCostSettings(cur, { services: { ebay: {} } })).toMatchObject({ ok: false });
    const ok = patchCostSettings(cur, { totalMonthlyUsd: 60, blockWhenOver: false, services: { keepa: { monthlyPriceUsd: 49, monthlyLimit: 30000, warnAtPercent: 90 } } });
    expect(ok).toMatchObject({ ok: true, value: { totalMonthlyUsd: 60, blockWhenOver: false, services: { keepa: { monthlyPriceUsd: 49, monthlyLimit: 30000, warnAtPercent: 90 } } } });
  });

  it('keeps the AI limit and the AI cap one value, whichever is written', () => {
    const old = { ai: { monthlyCapUsd: 40 } };
    expect(costSettingsOf(old).services.ai.monthlyLimit).toBe(40);
    const before = { ai: { monthlyCapUsd: 25 }, costs: settings() };
    const capWritten = syncAiLimit(before, { ...before, ai: { monthlyCapUsd: 10 } });
    expect(capWritten.costs!.services.ai.monthlyLimit).toBe(10);
    const limitWritten = { ...before, costs: { ...settings(), services: { ...settings().services, ai: { ...settings().services.ai, monthlyLimit: 7 } } } };
    expect(syncAiLimit(before, limitWritten).ai.monthlyCapUsd).toBe(7);
  });
});
