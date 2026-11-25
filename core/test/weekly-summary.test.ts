// The weekly summary on the owner's real stores (fixtures/e2e-2026-11-23: after-scan6, and after-keepcurrent a day later, where the
// three Buy now deals had gone back below the line). Pure: the stores are read from the fixture files, the clock is fixed, nothing
// is sent. Purchases are the one thing the fixtures do not hold (the owner had recorded none), so one is recorded here the way the app does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Purchase, RunRecord } from '../src/api/contract';
import { buildCostsView } from '../src/costs/view';
import { DEFAULT_COST_SETTINGS } from '../src/costs/types';
import { DEFAULT_FEES } from '../src/money';
import { applyPartOutcome, newPurchase, snapshotOf } from '../src/outcomes/outcomes';
import { weeklySummary, weekUse } from '../src/selfRun/weekly';
import type { BundleRow } from '../src/scan/types';
import type { TrackingState } from '../src/tracking/state';

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23');
const load = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(ROOT, dir, 'store', file), 'utf8')) as T;
const NOW = new Date(2026, 10, 25, 16, 0).getTime();
const WEEK = NOW - 7 * 86_400_000;

function stores(dir: 'after-scan6' | 'after-keepcurrent') {
  const deals = load<{ bundles: BundleRow[] }>(dir, 'deals.json');
  const tracking = load<TrackingState>(dir, 'tracking.json');
  const activity = load<{ runs: RunRecord[] }>(dir, 'activity.json');
  // The owner's search ledger for the week: the 17 searches of scan 5 (Nov 23) and none since.
  const serpRows = Array.from({ length: 17 }, (_, i) => ({ at: new Date(2026, 10, 23, 18, i).toISOString() }));
  const input = {
    now: NOW, settings: structuredClone(DEFAULT_COST_SETTINGS), schedule: { mode: 'daily', at: '07:00' } as const, lastScheduledRunAt: null,
    caps: { searchesPerScan: 18, verifySearchesPerDay: 5 }, serp: { rows: serpRows, plan: { perMonth: 250, planName: 'Free' } },
    keepa: { rows: [{ at: new Date(2026, 10, 23, 18, 5).toISOString(), tokens: 29 }], refillPerMin: 1 },
    ai: { suggestions: [], runs: [{ startedAt: new Date(2026, 10, 23, 18).toISOString(), judgeCostUsd: 0.45 }], label: 'AI (Anthropic)' },
    counts: { '2026-11-24': { telegram: 2 } }, runs: activity.runs, blocked: {},
  };
  return { deals, tracking, activity, costs: buildCostsView(input), week: weekUse(input, WEEK, NOW) };
}

function purchaseOf(bundles: BundleRow[]): Purchase {
  const b = bundles.find((x) => x.key === 'homedepot:326894170')!;
  const snapshot = snapshotOf(b, { fees: DEFAULT_FEES, basis: 'An estimate from your fee settings.', buyNow: true, at: new Date(2026, 10, 24, 10).toISOString() });
  const bought = newPurchase({ id: 'p1', dealId: b.key, snapshot, boughtAt: '2026-11-24', now: new Date(2026, 10, 24, 10).getTime() });
  return applyPartOutcome(bought, bought.parts[0]!.partId, { status: 'sold', date: '2026-11-25', salePrice: 90 }, NOW);
}

describe('the weekly summary on after-scan6', () => {
  const s = stores('after-scan6');
  const input = { now: NOW, from: WEEK, bundles: s.deals.bundles, tracking: s.tracking, openQuestions: 24, costs: s.costs, week: s.week, runs: s.activity.runs, pagesWaiting: 130, paused: false };

  it('counts the deals found this week, the Buy now announcements and the Buy now deals as of now', () => {
    const w = weeklySummary({ ...input, purchases: [] });
    // All 258 bundles were first stored by scan 5 on Nov 23; 36 of them have every part priced.
    expect(w.counts).toEqual({ dealsFound: 36, buyNowAnnounced: 3, buyNowNow: 3, purchases: 0 });
  });

  it('says "No purchases recorded" and has nothing to compare when he recorded none; every dollar figure says what it is', () => {
    const w = weeklySummary({ ...input, purchases: [] });
    expect(w.text).toContain('- No purchases recorded this week.');
    expect(w.text).toContain('- No sales recorded this week.');
    expect(w.text).toContain('- No finished deals recorded yet, so there is nothing to compare an estimate with.');
    expect(w.text).toContain('- 24 questions are open in Review.');
    expect(w.text).toContain('- 130 Home Depot pages wait to be read.');
    // The cost lines: the week's own use, and the month against its limits (the free plan, no limits set: inside).
    expect(w.text).toContain('- SerpApi 17 searches, Keepa 29 tokens, AI $0.45 (recorded), eBay 0 calls, Telegram 2 messages.');
    expect(w.text).toContain('- This month is inside your limits.');
    // Plain text a chat app shows as it is: no table, no markup.
    expect(w.text).not.toMatch(/[|*_`#]/);
    for (const line of w.text.split('\n')) expect(line.length).toBeLessThan(260);
    expect(w.short).toBe('Your week: 36 new deals, 3 announced as worth buying now. No purchases recorded. 24 questions open. Costs inside your limits.');
  });

  it('a recorded purchase and sale: the money is labelled recorded or estimate, and only what he recorded is counted', () => {
    const w = weeklySummary({ ...input, purchases: [purchaseOf(s.deals.bundles)] });
    expect(w.counts.purchases).toBe(1);
    expect(w.text).toMatch(/- 1 purchase recorded: \$\d+\.\d\d paid \(recorded\); estimated profit when bought -?\$\d+\.\d\d \(estimate\)\./);
    expect(w.text).toMatch(/- Realised this week: -?\$\d+\.\d\d from 1 part sold or returned \(recorded; Amazon's fees estimated for 1\)\./);
    // One part of two is sold: the deal is not finished, so there is still nothing to compare.
    expect(w.text).toContain('nothing to compare');
  });

  it('what the costs hold back is listed, with a scan that stopped at a limit and a paused agent', () => {
    const w = weeklySummary({
      ...input, purchases: [], paused: true,
      runs: [{ kind: 'scan', startedAt: new Date(2026, 10, 24, 7).toISOString(), status: 'limit' }],
      costs: { ...s.costs, services: s.costs.services.map((x) => (x.service === 'serpapi' ? { ...x, state: 'over' as const, sentence: 'Limit reached: 40 of 40 searches.', blocked: [{ what: 'The 7:00 scan\'s Amazon lookups', why: 'It was expected to use 12 searches and none are left.', at: new Date(2026, 10, 24, 7).toISOString() }] } : x)) },
    });
    expect(w.text).toContain('- SerpApi: Limit reached: 40 of 40 searches.');
    expect(w.text).toContain('- The 7:00 scan\'s Amazon lookups. It was expected to use 12 searches and none are left.');
    expect(w.text).toContain('- 1 scan stopped at a limit.');
    expect(w.text).toContain('- The agent is paused, so no scan runs.');
    expect(w.short).toContain('Costs need a look.');
  });
});

describe('the weekly summary on after-keepcurrent', () => {
  it('the three Buy now deals went back below the line: announced that week, none now', () => {
    const s = stores('after-keepcurrent');
    const w = weeklySummary({ now: NOW, from: WEEK, bundles: s.deals.bundles, tracking: s.tracking, purchases: [], openQuestions: 0, costs: s.costs, week: s.week, runs: s.activity.runs, pagesWaiting: null, paused: false });
    expect(w.counts).toMatchObject({ dealsFound: 47, buyNowAnnounced: 3, buyNowNow: 0 });
    expect(w.text).toContain('- 3 deals were announced as worth buying now; 0 are worth buying now as of this message.');
    expect(w.text).toContain('- No questions are open.');
    // The owner's two scans of Nov 23 that stopped at their limit; nothing else was held back.
    expect(w.text).toContain('Held back\n- 2 scans stopped at a limit.');
    expect(w.text).not.toContain('Nothing.');
  });

  it('a week before Nov 23 holds none of it: nothing found, nothing announced', () => {
    const s = stores('after-keepcurrent');
    const w = weeklySummary({ now: NOW - 14 * 86_400_000, from: WEEK - 14 * 86_400_000, bundles: s.deals.bundles, tracking: s.tracking, purchases: [], openQuestions: 0, costs: s.costs, week: s.week, runs: [], pagesWaiting: null, paused: false });
    expect(w.counts).toMatchObject({ dealsFound: 0, buyNowAnnounced: 0 });
    expect(w.text).toContain('- No new deals found.');
  });
});

describe('what the week used', () => {
  it('counts only what is in the week, and the days after its first for the counted calls', () => {
    const rows = [{ at: new Date(2026, 10, 17, 12).toISOString() }, { at: new Date(2026, 10, 19, 12).toISOString() }, { at: new Date(2026, 10, 25, 12).toISOString() }];
    const w = weekUse(
      { serp: { rows, plan: null }, keepa: { rows: [], refillPerMin: null }, ai: { suggestions: [], runs: [] }, counts: { '2026-11-18': { telegram: 5 }, '2026-11-19': { telegram: 1, ebay: 3 }, '2026-11-25': { ebay: 2 } } },
      WEEK, NOW,
    );
    expect(w.serpapi.used).toBe(2);
    expect(w.telegram.used).toBe(1);
    expect(w.ebay.used).toBe(5);
  });
});
