// The market around a part's listing (core/src/tracking/market.ts) on the owner's real records: the Keepa records of the 83
// listings his app counts (fixtures/keepa/stats-sample-2026-11-25.json) and his stored deals after scan 6 (Nov 23-24) and
// after the first keep-current re-check (Nov 25), judged again with the market as the agent does at start (no scan, nothing
// fetched). The records are of Nov 25; on the Nov 23 deals their 90-day averages stand for what Keepa said two days earlier.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { heldDeals, type SanityFinding } from '../src/audit/sanity';
import { parseProductResponse } from '../src/keepa/parse';
import { partTrendFromProduct, type PartTrend, type TrendMarket } from '../src/keepa/trends';
import type { BundleRow, PartRow, ReviewItem } from '../src/scan/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { failingOf } from '../src/tracking/keepCurrent';
import { optionMarket, partMarket, UNUSUAL_ABOVE_AVG90 } from '../src/tracking/market';
import type { BundleSignals, TrendLookup } from '../src/tracking/signals';
import { retrackReport, seedAnnounced, type TrackingState } from '../src/tracking/state';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const SAMPLE = JSON.parse(readFileSync(join(FIX, 'keepa', 'stats-sample-2026-11-25.json'), 'utf8')) as { products: (Record<string, unknown> & { cachedAt: number })[] };
const cachedAt = new Map(SAMPLE.products.map((p) => [p.asin as string, p.cachedAt]));
const MARKET = new Map<string, TrendMarket>(
  parseProductResponse({ products: SAMPLE.products }).products.map((p) => [p.asin, partTrendFromProduct(p, cachedAt.get(p.asin)!).market!]),
);

const read = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(FIX, 'e2e-2026-11-23', dir, 'store', file), 'utf8')) as T;
interface Stored { deals: { at: string; bundles: BundleRow[]; sanity?: SanityFinding[] }; tracking: TrackingState; review: ReviewItem[] }
const stored = (dir: 'after-scan6' | 'after-keepcurrent'): Stored => ({
  deals: read(dir, 'deals.json'),
  tracking: read(dir, 'tracking.json'),
  review: dir === 'after-scan6' ? read<{ questions: ReviewItem[] }>(dir, 'review.json').questions : [],
});

/** The Keepa figures the app judged with (its stored velocity rows), each with the market its record holds. */
function trendOf(t: TrackingState, market = true): TrendLookup {
  const out = new Map<string, PartTrend>();
  for (const s of Object.values(t.signals)) {
    for (const o of s.options) {
      for (const p of o.velocity.parts) {
        if (!p.asin || p.pulledAt === null || out.has(p.asin)) continue;
        const m = MARKET.get(p.asin);
        out.set(p.asin, { asin: p.asin, amazonPrice: null, salesRank: p.salesRank, offerCount: null, pulledAt: p.pulledAt, monthlySold: p.monthlySold, buyBoxEligibleOffers: p.offers, ...(market && m ? { market: m } : {}) });
      }
    }
  }
  return (asin) => out.get(asin);
}

// The owner's numbers (Nov 23): $20, 20%, 50 sold a month.
const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };

function rejudge(s: Stored, market = true) {
  const now = Date.parse(s.deals.at) + 60_000;
  const held = Object.fromEntries([...heldDeals(s.deals.sanity ?? [])].map(([k, f]) => [k, f.sentence]));
  return retrackReport({ ...s.tracking, announced: seedAnnounced(s.tracking) }, { bundles: s.deals.bundles, review: s.review }, trendOf(s.tracking, market), alerts, now, { keepa: true, flatFee: 0, held }).state;
}
const buys = (t: TrackingState): string[] => Object.values(t.signals).filter((x) => t.watch[x.bundleKey]?.watched === true && x.buyNow !== null).map((x) => x.model).sort();

const SAW = 'homedepot:341966856'; // PSK1212SB-PCL515B
const VAC = 'homedepot:344305163'; // PSK1212SB-PCL633B
const LIGHT = 'homedepot:341965772'; // PSK1212SB-PCL031B
const part = (s: Stored, key: string, model: string): PartRow => s.deals.bundles.find((b) => b.key === key)!.options[0]!.parts.find((p) => p.model === model)!;

describe('rule 1: a price unusual for the listing', () => {
  const nov23 = stored('after-scan6');

  it('PCL515B on Nov 23: $79.99 is 31% above its 90-day average of $61.12, so it is unusual', () => {
    const m = partMarket(part(nov23, SAW, 'PCL515B'), { ...({} as PartTrend), market: MARKET.get('B0B88R7HWB')! })!;
    expect(m).toMatchObject({ model: 'PCL515B', price: 79.99, avg30: 56.43, avg90: 61.12, avg180: 55.89, aboveAvg90: 0.3087, unusual: true });
    expect(m.notes[0]).toBe('$79.99 is 31% above its 90-day average of $61.12 (30 days $56.43, 180 days $55.89).');
  });

  it('the threshold sits in the gap of the recorded distribution: of 76 priced listings, 6 are at or above it on Nov 25', () => {
    const now = stored('after-keepcurrent');
    const priced = new Map<string, number>();
    for (const b of now.deals.bundles) for (const o of b.options) for (const p of o.parts) {
      const c = p.availability === 'active' && p.asin ? p.prices.find((x) => x.kind === 'amazon_new' && !x.reference)?.price : undefined;
      if (c !== undefined && p.asin) priced.set(p.asin, c);
    }
    const above = [...priced].flatMap(([asin, price]) => {
      const avg = MARKET.get(asin)?.newAvg90 ?? null;
      return avg === null ? [] : [price / avg - 1];
    }).sort((a, b) => a - b);
    const over = above.filter((x) => x >= UNUSUAL_ABOVE_AVG90);
    expect(over.map((x) => Math.round(x * 100))).toEqual([22, 25, 26, 40, 56, 100]);
    // Nothing between 13% and 22%.
    expect(above.filter((x) => x > 0.135 && x < UNUSUAL_ABOVE_AVG90)).toEqual([]);
  });

  it('PSK1212SB-PCL515B on Nov 23 is worth buying at today\'s prices only: at the usual prices of PCG002 and PCL515B it is +$12.28', () => {
    const o = nov23.deals.bundles.find((b) => b.key === SAW)!.options[0]!;
    const m = optionMarket(o, trendOf(nov23.tracking), alerts)!;
    expect(m.usual).toEqual({ profit: 12.28, roiPercent: 12.4, meets: false, parts: [{ model: 'PCG002', price: 34.97, usual: 17.47 }, { model: 'PCL515B', price: 79.99, usual: 61.12 }] });
    const sig = rejudge(nov23).signals[SAW]!;
    expect(sig.buyNow).toBeNull();
    expect(sig.verdict).toBe("Worth buying now at today's prices only: at the 90-day averages of $17.47 for PCG002 and $61.12 for PCL515B it is +$12.28 (12% ROI), below your $20 and 20%. Not marked Buy now.");
    // Leaving the state names the condition in Activity's words.
    expect(failingOf(sig)).toBe('at the 90-day averages of $17.47 for PCG002 and $61.12 for PCL515B it is +$12.28 (12% ROI), below your $20 and 20%');
  });

  it('a listing with no history yet (FVB02\'s record, every average -1) says so and keeps today\'s rule', () => {
    const p = part(nov23, SAW, 'PBP003');
    const m = partMarket(p, { ...({} as PartTrend), market: MARKET.get('B0HQT2JYFV')! })!;
    expect(m).toMatchObject({ unusual: false, noHistory: true, aboveAvg90: null, avg90: null });
    // Its record also says it had no New offer at all on any of the last 90 days.
    expect(m.notes).toEqual(['No price history yet: judged at today’s price alone.', 'No New offer at all on 100% of the last 90 days.']);
    expect(optionMarket({ parts: [p], estimate: { cost: 50, netRevenue: 80, profit: 30, roi: 0.6 } }, () => ({ ...({} as PartTrend), market: MARKET.get('B0HQT2JYFV')! }), alerts)!.usual).toBeNull();
  });
});

describe('rules 2 to 4: notes, none of which holds a buy', () => {
  const nov25 = stored('after-keepcurrent');

  it('PCG002: Amazon sells it itself', () => {
    const m = partMarket(part(nov25, SAW, 'PCG002'), { ...({} as PartTrend), market: MARKET.get('B0B1QRQYK2')! })!;
    expect(m.amazon).toEqual({ price: 34.97, buyBox: false });
    expect(m.notes).toContain('Amazon sells this itself at $34.97: hard to win sales against.');
  });

  it('PBP004: the lithium battery note, from its record', () => {
    const m = partMarket(part(nov25, SAW, 'PBP004'), { ...({} as PartTrend), market: MARKET.get('B09HDZ5MPV')! })!;
    expect(m).toMatchObject({ unusual: false, hazmat: { unId: 'UN3480', lithium: true } });
    expect(m.notes).toEqual(['Lithium battery (UN3480): Amazon treats it as dangerous goods; check it is approved in your FBA account before buying.']);
  });

  it('PCL515B on Nov 25: 74 sellers against 33 over 90 days is crowding; PCL633B too (43 against 14)', () => {
    expect(partMarket(part(nov25, SAW, 'PCL515B'), { ...({} as PartTrend), market: MARKET.get('B0B88R7HWB')! })!.notes).toEqual([
      '74 sellers offer it new, up from 33 on average over 90 days.',
    ]);
    expect(partMarket(part(nov25, VAC, 'PCL633B'), { ...({} as PartTrend), market: MARKET.get('B0D7XWRWG5')! })!.newOffers).toEqual({ now: 43, avg90: 14, grown: true });
  });
});

describe('replay: which deals are Buy now, without and with the market', () => {
  it('after scan 6 (Nov 23) and after the keep-current re-check (Nov 25)', () => {
    const out = (['after-scan6', 'after-keepcurrent'] as const).map((dir) => {
      const s = stored(dir);
      return { dir, before: buys(rejudge(s, false)), after: buys(rejudge(s)) };
    });
    expect(out).toEqual([
      { dir: 'after-scan6', before: ['PSK1212SB-PCL031B', 'PSK1212SB-PCL515B', 'PSK1212SB-PCL633B'], after: ['PSK1212SB-PCL633B'] },
      { dir: 'after-keepcurrent', before: ['PSK1212SB-PCL031B', 'PSK1212SB-PCL633B'], after: ['PSK1212SB-PCL633B'] },
    ]);
  });

  it('the verdicts in words', () => {
    const v = (dir: 'after-scan6' | 'after-keepcurrent', k: string): string => (rejudge(stored(dir)).signals[k] as BundleSignals).verdict!;
    expect(v('after-scan6', VAC)).toMatch(/^Worth buying now: \+\$38\.79 .*\. At the 90-day average of \$17\.47 for PCG002 it is still \+\$23\.92 \(24% ROI\)\.$/);
    expect(v('after-keepcurrent', VAC)).toMatch(/^Worth buying now: \+\$35\.67 .*\. At the 90-day average of \$17\.47 for PCG002 it is still \+\$20\.80 \(21% ROI\)\.$/);
    expect(v('after-keepcurrent', LIGHT)).toBe("Worth buying now at today's prices only: at the 90-day average of $17.47 for PCG002 it is +$8.48 (9% ROI), below your $20 and 20%. Not marked Buy now.");
    expect(v('after-keepcurrent', SAW)).toBe('Not worth buying now: est. $16.73 is below your $20 and 17% ROI below your 20%.');
  });
});
