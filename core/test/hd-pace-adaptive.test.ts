// Home Depot's adaptive ceiling between scans (core/src/scan/hdPace.ts dripCeiling), from the owner's live data on Nov 25:
// 80 pages read between 5:00 and 9:00 AM, refused four times in a row, a four-hour pause. Fake clock, no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  backlogSentence, ceilingWords, dripCeiling, HD_DRIP_PER_HOUR_FLOOR, HD_DRIP_RAISE_AFTER_MS, HD_DRIP_RAISE_STEP, HdPace, NEW_PACE_STATE, type HdPaceState,
} from '../src/scan/hdPace';
import type { BundleRow } from '../src/scan/types';
import { HD_RECHECK_BUY_NOW_MS, hdDue, keepCost, keptDeals, type KeepTracking } from '../src/tracking/keepCurrent';

const HOUR = 60 * 60_000;
const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();

function paced(start: number) {
  let clock = start;
  let state: HdPaceState = { ...NEW_PACE_STATE };
  const sleeps: number[] = [];
  const pace = new HdPace({
    now: () => clock, random: () => 0, load: () => state, save: (s) => void (state = s),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { pace, sleeps, now: () => clock, set: (t: number) => void (clock = t), state: () => state };
}

describe("Home Depot's adaptive ceiling between scans", () => {
  it("the owner's morning: each refusal halves the hourly ceiling (40, 20, 10, never below 10); the gap follows it; the words say it", async () => {
    const p = paced(at(25, 5));
    expect(p.pace.dripPerHour()).toBe(40);
    expect(p.pace.dripGapMs()).toBe(90_000);
    const ceilings: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // Each refusal comes after its cool-down (30 min, 1 h, 2 h, 4 h).
      p.set(Math.max(p.now(), p.state().pausedUntil ?? 0) + 1);
      const t = await p.pace.take('drip');
      t.done('refused', 'a bundle page');
      ceilings.push(p.pace.dripPerHour());
    }
    expect(ceilings).toEqual([20, 10, HD_DRIP_PER_HOUR_FLOOR, HD_DRIP_PER_HOUR_FLOOR]);
    expect(p.state()).toMatchObject({ refusals: 4, perHour: 10 });
    // One page every 6 minutes at 10 an hour.
    expect(p.pace.dripGapMs()).toBe(6 * 60_000);
    p.set(p.state().pausedUntil! + 1);
    const t = await p.pace.take('drip');
    t.done('read');
    p.set(p.now() + 60_000);
    await (await p.pace.take('drip')).done('read');
    expect(p.sleeps.at(-1)).toBe(5 * 60_000);
    // The summary states the ceiling in force and why.
    p.set(at(25, 11));
    expect(ceilingWords(p.pace.dripPerHour(), at(25, 9, 40), p.now())).toBe('between scans at most 10 are read an hour today, after Home Depot refused pages this morning (240 a day)');
    expect(backlogSentence({ pages: 220, sets: 139, pausedUntil: null, ceiling: ceilingWords(20, at(25, 6), at(25, 8)) })).toBe(
      '139 sets wait for 220 Home Depot pages; between scans at most 20 are read an hour today, after Home Depot refused pages this morning (240 a day), and each scan reads up to 40.',
    );
    // At the full ceiling the words are the ones before.
    expect(ceilingWords(40, null, p.now())).toBe('between scans at most 40 are read an hour (240 a day)');
  });

  it('it stays for the rest of that day, the next day starts where it ended, and it is raised by 5 for each 6 hours with no refusal', () => {
    const s = { perHour: 10, perHourAt: at(25, 9) };
    expect(dripCeiling(s, at(25, 23, 59))).toBe(10);
    expect(dripCeiling(s, at(26, 0, 1))).toBe(10);
    expect(dripCeiling(s, at(26, 6))).toBe(10 + HD_DRIP_RAISE_STEP);
    expect(dripCeiling(s, at(26, 12))).toBe(20);
    expect(dripCeiling(s, at(27, 0))).toBe(30);
    expect(dripCeiling(s, at(27, 12))).toBe(40);
    expect(dripCeiling(s, at(28, 12))).toBe(40);
    expect(HD_DRIP_RAISE_AFTER_MS).toBe(6 * HOUR);
    expect(ceilingWords(10, at(25, 9), at(26, 3))).toBe('between scans at most 10 are read an hour today, after Home Depot refused pages yesterday morning (240 a day)');
  });

  it('a refusal while it is being raised halves the ceiling in force', async () => {
    const p = paced(at(26, 12));
    p.set(at(26, 12));
    // Raised to 20 by noon of the next day.
    (p.state() as HdPaceState).perHour = 10;
    (p.state() as HdPaceState).perHourAt = at(25, 9);
    expect(p.pace.dripPerHour()).toBe(20);
    (await p.pace.take('drip')).done('refused');
    expect(p.pace.dripPerHour()).toBe(10);
    expect(p.state().perHourAt).toBe(p.now());
  });
});

describe('replay on after-scan6: the Buy now checks at the lowest ceiling', () => {
  const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6', 'store');
  const deals = JSON.parse(readFileSync(join(DIR, 'deals.json'), 'utf8')) as { at: string; bundles: BundleRow[] };
  const tracking = JSON.parse(readFileSync(join(DIR, 'tracking.json'), 'utf8')) as KeepTracking;

  it('at 10 pages an hour (one every 6 minutes), each of the three Buy now deals still gets its Home Depot check every 4 hours', () => {
    let bundles = deals.bundles;
    const start = Date.parse(deals.at);
    const reads = new Map<string, number[]>();
    let buySlots = 0;
    const gap = HOUR / HD_DRIP_PER_HOUR_FLOOR;
    for (let t = start; t < start + 24 * HOUR; t += gap) {
      // Buy now first within the ceiling; the other slots go to the pages bundles wait for (watched deals give way).
      const due = hdDue(keptDeals(bundles, tracking).filter((d) => d.tier === 'buyNow'), t)[0];
      if (!due) continue;
      buySlots += 1;
      reads.set(due.key, [...(reads.get(due.key) ?? []), t]);
      bundles = bundles.map((b) => (b.key === due.key ? { ...b, seenAt: t } : b));
    }
    expect([...reads.keys()].sort()).toEqual(['homedepot:341965772', 'homedepot:341966856', 'homedepot:344305163']);
    for (const times of reads.values()) {
      expect(times).toHaveLength(6);
      for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeLessThanOrEqual(HD_RECHECK_BUY_NOW_MS + gap);
    }
    // 18 of the day's 240 slots at the floor; the other 222 go to the pages bundles wait for, then the watched deals.
    expect(buySlots).toBe(18);
    const cost = keepCost(keptDeals(deals.bundles, tracking), { tokensPerPull: 1, refillPerMin: 1 });
    expect(cost.pagesPerDay).toBe(80);
    expect(HD_DRIP_PER_HOUR_FLOOR * 24).toBe(240);
  });
});
