// Buy now is a state; the announcement is an event (Nov 25, docs/decisions.md). On the owner's real records: after scan 6
// (fixtures/e2e-2026-11-23/after-scan6, three Buy now deals announced on Nov 23) and after the first keep-current re-check
// (after-keepcurrent, Nov 25: PBP004 from $53.99 to $50.00 and PCL515B from $79.99 to $53.00 on Amazon), where the old
// rule ("a buy needs a change") took all three off the list. Pure: the stored Keepa figures come from the stored signals'
// velocity rows; no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { heldDeals, type SanityFinding } from '../src/audit/sanity';
import type { PartTrend } from '../src/keepa/trends';
import type { BundleRow, ReviewItem } from '../src/scan/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { failingOf, snapshotOf, verdictChanges } from '../src/tracking/keepCurrent';
import { ANNOUNCE_MARGIN_DOLLARS, type BundleSignals, type TrendLookup } from '../src/tracking/signals';
import { announcedAfter, freshSignals, retrackReport, seedAnnounced, type TrackingState } from '../src/tracking/state';

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23');
const read = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(ROOT, dir, 'store', file), 'utf8')) as T;

interface Stored { deals: { at: string; bundles: BundleRow[]; sanity?: SanityFinding[] }; tracking: TrackingState; review: ReviewItem[] }
const stored = (dir: string): Stored => ({
  deals: read(dir, 'deals.json'),
  tracking: read(dir, 'tracking.json'),
  // after-keepcurrent kept no review.json; open questions only decide Review events, never the state.
  review: dir === 'after-scan6' ? read<{ questions: ReviewItem[] }>(dir, 'review.json').questions : [],
});

/** The Keepa figures the app judged with, from its stored velocity rows (a part never pulled has none). */
function trendOf(t: TrackingState): TrendLookup {
  const out = new Map<string, PartTrend>();
  for (const s of Object.values(t.signals)) {
    for (const o of s.options) {
      for (const p of o.velocity.parts) {
        if (!p.asin || p.pulledAt === null || out.has(p.asin)) continue;
        out.set(p.asin, { asin: p.asin, amazonPrice: null, salesRank: p.salesRank, offerCount: null, pulledAt: p.pulledAt, monthlySold: p.monthlySold, buyBoxEligibleOffers: p.offers });
      }
    }
  }
  return (asin) => out.get(asin);
}

// The owner's numbers (Nov 23): $20, 20%, 50 sold a month.
const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };

/** The stored verdicts judged again under the state rule, as the agent does at start (no scan, nothing fetched). */
function rejudge(s: Stored, now: number, tracking: TrackingState = { ...s.tracking, announced: seedAnnounced(s.tracking) }) {
  const held = Object.fromEntries([...heldDeals(s.deals.sanity ?? [])].map(([k, f]) => [k, f.sentence]));
  return retrackReport(tracking, { bundles: s.deals.bundles, review: s.review }, trendOf(s.tracking), alerts, now, { keepa: true, flatFee: 0, held });
}

const SAW = 'homedepot:341966856'; // PSK1212SB-PCL515B
const VAC = 'homedepot:344305163'; // PSK1212SB-PCL633B
const LIGHT = 'homedepot:341965772'; // PSK1212SB-PCL031B
const inState = (t: TrackingState): string[] => Object.values(t.signals).filter((x) => t.watch[x.bundleKey]?.watched === true && x.buyNow !== null).map((x) => x.model).sort();

describe('after the first keep-current re-check (Nov 25): the three PSK1212SB deals judged again under the state rule', () => {
  const s = stored('after-keepcurrent');
  const NOW = Date.parse(s.deals.at) + 60_000;
  const { state, evaluated } = rejudge(s, NOW);
  const sig = (k: string): BundleSignals => state.signals[k]!;

  it('what was announced on Nov 23 is seeded from the history of that day', () => {
    expect(seedAnnounced(s.tracking)).toMatchObject({
      [SAW]: { optionId: 'split:PSK1212SB', profit: 43.19 },
      [VAC]: { optionId: 'split:PSK1212SB', profit: 38.79 },
      [LIGHT]: { optionId: 'split:PSK1212SB', profit: 26.47 },
    });
  });

  it('PCL515B below $20 is not a buy; PCL633B and PCL031B are, in the present tense with the movement as information', () => {
    expect(sig(SAW).buyNow).toBeNull();
    expect(sig(SAW).verdict).toBe('Not worth buying now: est. $16.73 is below your $20 and 17% ROI below your 20%.');
    expect(sig(VAC).buyNow).toMatchObject({ kind: 'buyNow', optionId: 'split:PSK1212SB', numbers: { profit: 35.67 } });
    expect(sig(VAC).verdict).toBe('Worth buying now: +$35.67 (36% ROI), sells about 100 a month. Down from $38.79 at the last check.');
    expect(sig(LIGHT).buyNow).toMatchObject({ numbers: { profit: 23.35 } });
    expect(sig(LIGHT).verdict).toBe('Worth buying now: +$23.35 (23.6% ROI), sells about 200 a month. Down from $26.47 at the last check.');
    // Every safety rule still holds for them: confirmed listings (nothing pending), every fee counted.
    expect(sig(VAC).options[0]!.unconfirmed).toBeUndefined();
    expect(sig(VAC).options[0]!.notBuyNow).toBeNull();
  });

  it('the two that return to Buy now are not announced as new; the one that left is no longer announced', () => {
    expect(evaluated).toEqual(expect.arrayContaining([SAW, VAC, LIGHT]));
    expect(sig(VAC).announce).toBe(false);
    expect(sig(LIGHT).announce).toBe(false);
    expect(freshSignals(state, ['buyNow'], NOW, new Set(evaluated)).lines.map((l) => l.model)).toEqual([]);
    expect(state.announced![SAW]).toBeUndefined();
    expect(state.announced![VAC]).toMatchObject({ profit: 38.79 });
  });

  it('a later rise of the margin or more over the figure announced is sent once; less is not', () => {
    const at = NOW + 3 * 3600_000;
    /** The deal as if Amazon's prices had moved its estimate to `profit` (the cost unchanged). */
    const priced = (profit: number): Stored => {
      const moved = <E extends { cost: number }>(e: E): E => ({ ...e, profit, roi: profit / e.cost });
      return {
      ...s,
      deals: { ...s.deals, bundles: s.deals.bundles.map((b) => (b.key !== VAC ? b : { ...b, estimate: moved(b.estimate!), options: b.options.map((o) => (o.estimate ? { ...o, estimate: moved(o.estimate) } : o)) })) },
      };
    };
    // $4.00 above the announced $38.79: below the $5 margin, still a buy, not sent.
    const small = rejudge(priced(42.79), at, state);
    expect(small.state.signals[VAC]!.buyNow).not.toBeNull();
    expect(small.state.signals[VAC]!.announce).toBe(false);
    expect(freshSignals(small.state, ['buyNow'], at, new Set(small.evaluated)).lines).toEqual([]);
    // $5.21 above it: news, once.
    const up = rejudge(priced(38.79 + ANNOUNCE_MARGIN_DOLLARS + 0.21), at, small.state);
    expect(up.state.signals[VAC]!.announce).toBe(true);
    const sent = freshSignals(up.state, ['buyNow'], at, new Set(up.evaluated));
    expect(sent.lines.map((l) => [l.model, l.signal.reason.split('. ')[0]])).toEqual([['PSK1212SB-PCL633B', 'Estimated profit is up $5.21 since you were last told ($38.79), to $44.00 (44% ROI)']]);
    const told: TrackingState = { ...up.state, notified: sent.notified, announced: announcedAfter(up.state.announced, sent.lines, at) };
    expect(told.announced![VAC]).toMatchObject({ profit: 44 });
    // Judged again the next day at the same figure: still a buy, not sent again.
    const next = rejudge(priced(44), at + 86_400_000, told);
    expect(next.state.signals[VAC]!.buyNow).not.toBeNull();
    expect(freshSignals(next.state, ['buyNow'], at + 86_400_000, new Set(next.evaluated)).lines).toEqual([]);
  });

  it('leaving the state is said once, with the condition that now fails and the before and after', () => {
    const was = stored('after-scan6');
    const before = new Map([SAW, VAC, LIGHT].map((k) => [k, snapshotOf(was.deals.bundles.find((b) => b.key === k)!, true)]));
    const after = [SAW, VAC, LIGHT].map((k) => {
      const b = s.deals.bundles.find((x) => x.key === k)!;
      return snapshotOf(b, sig(k).buyNow !== null, sig(k).buyNow !== null ? null : failingOf(sig(k)));
    });
    expect(verdictChanges(before, after)).toEqual([
      {
        key: SAW, better: false,
        sentence: "PSK1212SB-PCL515B is no longer worth buying: est. $16.73 is below your $20 and 17% ROI below your 20%. Amazon's price of PBP004 went from $53.99 to $50.00 (https://www.amazon.com/dp/B09HDZ5MPV); Amazon's price of PCL515B went from $79.99 to $53.00 (https://www.amazon.com/dp/B0B88R7HWB). Est. profit $16.73, was $43.19 (an estimate from your fee settings, not your real fees).",
      },
      { key: VAC, better: false, quiet: true, sentence: 'PSK1212SB-PCL633B is still worth buying: est. profit $35.67, was $38.79 (an estimate from your fee settings).' },
      { key: LIGHT, better: false, quiet: true, sentence: 'PSK1212SB-PCL031B is still worth buying: est. profit $23.35, was $26.47 (an estimate from your fee settings).' },
    ]);
    // Once: the next refresh starts from a snapshot that is not Buy now, so nothing is said again.
    const again = new Map([[SAW, after[0]!]]);
    expect(verdictChanges(again, [after[0]!])).toEqual([]);
  });
});

describe('replay: deals in the state under the old rule and the new', () => {
  it('after scan 6 and after the keep-current re-check', () => {
    const counts = (['after-scan6', 'after-keepcurrent'] as const).map((dir) => {
      const s = stored(dir);
      return { dir, old: inState(s.tracking), now: inState(rejudge(s, Date.parse(s.deals.at) + 60_000).state) };
    });
    expect(counts).toEqual([
      { dir: 'after-scan6', old: ['PSK1212SB-PCL031B', 'PSK1212SB-PCL515B', 'PSK1212SB-PCL633B'], now: ['PSK1212SB-PCL031B', 'PSK1212SB-PCL515B', 'PSK1212SB-PCL633B'] },
      { dir: 'after-keepcurrent', old: [], now: ['PSK1212SB-PCL031B', 'PSK1212SB-PCL633B'] },
    ]);
  });
});
