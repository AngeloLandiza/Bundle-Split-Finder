// Keeping deals current between scans (core/src/tracking/keepCurrent.ts), on the owner's app after scan 6
// (fixtures/e2e-2026-11-23/after-scan6: 34 watched deals, 3 of them Buy now). Pure: a fake clock, no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { BundleRow } from '../src/scan/types';
import {
  AMAZON_RECHECK_BUY_NOW_MS, AMAZON_RECHECK_WATCHED_MS, amazonDue, HD_KEEP_CURRENT_PAGES_PER_DAY, HD_RECHECK_BUY_NOW_MS, HD_RECHECK_WATCHED_MS, hdDue,
  keepCost, keepSentence, keepUsageOf, keptDeals, PRICES_STALE_MS, pricesChecked, snapshotOf, staleSince, verdictChanges, type KeepTracking,
} from '../src/tracking/keepCurrent';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6', 'store');
const deals = JSON.parse(readFileSync(join(DIR, 'deals.json'), 'utf8')) as { at: string; bundles: BundleRow[] };
const tracking = JSON.parse(readFileSync(join(DIR, 'tracking.json'), 'utf8')) as KeepTracking;
const NOW = Date.parse(deals.at);
const BUY = ['PSK1212SB-PCL515B', 'PSK1212SB-PCL633B', 'PSK1212SB-PCL031B'];

/** The bundles as if a refresh had just read every price at `at`. */
const checkedAt = (at: number): BundleRow[] =>
  deals.bundles.map((b) => ({ ...b, seenAt: at, parts: b.parts.map((p) => ({ ...p, priceCheckedAt: at })), options: b.options.map((o) => ({ ...o, parts: o.parts.map((p) => ({ ...p, priceCheckedAt: at })) })) }));

describe('the deals kept current (after scan 6)', () => {
  it('every watched deal, the three Buy now deals first, each with its Home Depot item and its Amazon listings', () => {
    const kept = keptDeals(deals.bundles, tracking);
    expect(kept).toHaveLength(34);
    expect(kept.slice(0, 3).map((d) => d.model).sort()).toEqual([...BUY].sort());
    expect(kept.slice(3).every((d) => d.tier === 'watched')).toBe(true);
    const saw = kept.find((d) => d.model === 'PSK1212SB-PCL515B')!;
    expect(saw).toMatchObject({ itemId: '341966856', tier: 'buyNow' });
    expect(saw.parts.map((p) => p.model)).toEqual(['PBP004', 'PBP003', 'PCG002', 'PCL515B']);
    // Its prices are as old as the last reads: Home Depot's from its list, Amazon's from Keepa's pulls the day before.
    expect(pricesChecked(saw)).toEqual({ homeDepotAt: 1795475096212, amazonAt: 1795434405070 });
  });

  it('cadence: a Buy now deal\'s Home Depot price every 4 hours and its Amazon prices every 2; a watched deal\'s every 12', () => {
    // Read at NOW: nothing is due before its cadence.
    const fresh = keptDeals(checkedAt(NOW), tracking);
    expect(hdDue(fresh, NOW + HD_RECHECK_BUY_NOW_MS - 1)).toEqual([]);
    expect(amazonDue(fresh, NOW + AMAZON_RECHECK_BUY_NOW_MS - 1)).toEqual([]);
    // Then the Buy now deals' (and only theirs).
    expect(hdDue(fresh, NOW + HD_RECHECK_BUY_NOW_MS).map((d) => d.model).sort()).toEqual([...BUY].sort());
    const amazon = amazonDue(fresh, NOW + AMAZON_RECHECK_BUY_NOW_MS);
    expect(amazon.every((l) => l.tier === 'buyNow')).toBe(true);
    expect(amazon).toHaveLength(6);
    // A watched deal's after 12 hours, behind the Buy now ones.
    const all = hdDue(fresh, NOW + HD_RECHECK_WATCHED_MS);
    expect(all).toHaveLength(34);
    expect(all.slice(0, 3).every((d) => d.tier === 'buyNow')).toBe(true);
    expect(amazonDue(fresh, NOW + AMAZON_RECHECK_WATCHED_MS)).toHaveLength(44);
    // A read that gave no price is not asked again before its cadence (the try counts).
    const tried = { 'hd:homedepot:341966856': NOW + HD_RECHECK_BUY_NOW_MS };
    expect(hdDue(fresh, NOW + HD_RECHECK_BUY_NOW_MS + 1, tried).map((d) => d.key)).not.toContain('homedepot:341966856');
  });

  it('stale: a Buy now deal not checked for more than 8 hours says since when; a watched one never does', () => {
    const kept = keptDeals(checkedAt(NOW), tracking);
    const buy = kept.find((d) => d.tier === 'buyNow')!;
    const watched = kept.find((d) => d.tier === 'watched')!;
    expect(staleSince(buy, NOW + PRICES_STALE_MS)).toBeNull();
    expect(staleSince(buy, NOW + PRICES_STALE_MS + 1)).toBe(NOW);
    expect(staleSince(watched, NOW + 10 * PRICES_STALE_MS)).toBeNull();
    // On the stored data (Amazon prices pulled Nov 23 morning), each Buy now deal is stale now.
    expect(keptDeals(deals.bundles, tracking).filter((d) => staleSince(d, NOW) !== null).map((d) => d.model).sort()).toEqual([...BUY].sort());
  });

  it('replay: what the three Buy now deals and the watchlist cost a day to keep current, against what is set aside', () => {
    const kept = keptDeals(deals.bundles, tracking);
    const cost = keepCost(kept, { tokensPerPull: 1, refillPerMin: 1 });
    // 3 × 6 + 31 × 2 pages; 6 Buy now listings × 12 + 38 others × 2 tokens.
    expect(cost).toEqual({ buyNow: 3, watched: 31, listingsBuyNow: 6, listingsWatched: 38, pagesPerDay: 80, tokensPerDay: 148, pageShare: 120, tokenShare: 360 });
    expect(keepSentence(cost, { pagesWaiting: 0, pullsWaiting: 0, keepa: true })).toBe(
      'Keeping 3 Buy now deals and 31 other watched deals current: about 80 Home Depot pages a day (Buy now every 4 hours, the others every 12; up to 120 of the 240 read between scans, free) and about 148 Keepa tokens a day for 44 Amazon prices (Buy now every 2 hours, the others every 12; up to 360, a quarter of the refill, above your reserve).',
    );
    expect(keepSentence(cost, { pagesWaiting: 0, pullsWaiting: 0, keepa: false })).toBe(
      'Keeping 3 Buy now deals and 31 other watched deals current: about 80 Home Depot pages a day (Buy now every 4 hours, the others every 12; up to 120 of the 240 read between scans, free). Amazon prices are not refreshed between scans: Keepa is off or has no key.',
    );
  });

  it('budget fitting: a watchlist too long for the pages set aside says so, the oldest-checked go first, and how many wait', () => {
    // The 34 deals twice over and again (102 deals): 6 × 6 + 96 × 2 = 228 pages a day, above the 120.
    const many = [0, 1, 2].flatMap((n) => deals.bundles.map((b) => ({ ...b, key: `${b.key}#${n}`, seenAt: b.seenAt - n * 1000 })));
    const t: KeepTracking = {
      watch: Object.fromEntries(many.map((b) => [b.key, tracking.watch[b.key.split('#')[0]!]])),
      signals: Object.fromEntries(many.map((b) => [b.key, tracking.signals[b.key.split('#')[0]!]])),
    };
    const kept = keptDeals(many, t);
    const cost = keepCost(kept, { tokensPerPull: 1, refillPerMin: 1 });
    expect(cost.pagesPerDay).toBe(9 * 6 + 93 * 2);
    expect(cost.pagesPerDay).toBeGreaterThan(HD_KEEP_CURRENT_PAGES_PER_DAY);
    const due = hdDue(kept, NOW);
    expect(due).toHaveLength(102);
    // Buy now first, then the oldest checked.
    expect(due.slice(0, 9).every((d) => d.tier === 'buyNow')).toBe(true);
    const watched = due.slice(9).map((d) => d.hdCheckedAt);
    expect(watched).toEqual([...watched].sort((a, b) => a - b));
    const left = HD_KEEP_CURRENT_PAGES_PER_DAY - 100;
    expect(keepSentence(cost, { pagesWaiting: due.length - left, pullsWaiting: 0, keepa: true })).toMatch(
      /240 Home Depot pages a day is more than the 120 set aside: the oldest-checked go first\. 82 Home Depot prices wait for today's share; they go first tomorrow\.$/,
    );
  });

  it("the usage of another day starts at 0; a try older than a day is dropped", () => {
    expect(keepUsageOf({ day: '1999-01-01', pages: 50, tokens: 9, tried: { 'hd:x': NOW - 1000, 'hd:y': NOW - 25 * 3600_000 } }, NOW)).toEqual({
      day: expect.any(String), pages: 0, tokens: 0, tried: { 'hd:x': NOW - 1000 },
    });
    expect(keepUsageOf(null, NOW)).toMatchObject({ pages: 0, tokens: 0, tried: {} });
  });
});

describe('the verdict follows a refreshed price', () => {
  const row = deals.bundles.find((b) => b.model === 'PSK1212SB-PCL515B')!;
  const before = new Map([[row.key, snapshotOf(row, true)]]);

  it("a Home Depot price rise withdraws Buy now, in one sentence with the before and after, its link and the estimate's label", () => {
    const after = snapshotOf({ ...row, price: 129, estimate: { ...row.estimate!, cost: 129, profit: 13.19, roi: 0.1 } }, false);
    expect(verdictChanges(before, [after])).toEqual([{
      key: row.key, better: false,
      sentence: "PSK1212SB-PCL515B is no longer worth buying: Home Depot's price went from $99.00 to $129.00 (https://www.homedepot.com/p/RYOBI-ONE-18V-Kit-w-4-0-Ah-Battery-2-0-Ah-Battery-Charger-FREE-ONE-Cordless-Reciprocating-Saw-PSK1212SB-PCL515B/341966856). Est. profit $13.19, was $43.19 (an estimate from your fee settings, not your real fees).",
    }]);
  });

  it('an Amazon price that comes back up makes it worth buying again, said the same way', () => {
    const low = { ...row, estimate: { ...row.estimate!, profit: 3.19 }, parts: row.parts.map((p) => (p.model === 'PCL515B' ? { ...p, price: 39.99 } : p)) };
    const was = new Map([[row.key, snapshotOf(low, false)]]);
    expect(verdictChanges(was, [snapshotOf(row, true)])[0]).toMatchObject({
      better: true,
      sentence: "PSK1212SB-PCL515B is worth buying now: Amazon's price of PCL515B went from $39.99 to $79.99 (https://www.amazon.com/dp/B0B88R7HWB). Est. profit $43.19, was $3.19 (an estimate from your fee settings, not your real fees).",
    });
  });

  it('a verdict that did not flip says nothing, nor one no price explains (the signals say why)', () => {
    expect(verdictChanges(before, [snapshotOf({ ...row, price: 98 }, true)])).toEqual([]);
    expect(verdictChanges(before, [snapshotOf(row, false)])).toEqual([]);
  });
});
