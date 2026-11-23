// Home Depot's pace (core/src/scan/hdPace.ts), on a fake clock whose sleep moves the clock: the gap between any two
// reads, the per-scan cap, the drip's daily cap, and the cool-down a refusal starts (doubling when refused again).

import { describe, expect, it } from 'vitest';

import {
  backlogSentence, dripHoursFor, HD_COOLDOWN_MS, HD_DRIP_GAP_MS, HD_GAP_JITTER_MS, HD_GAP_MS, HD_LIMITS, HD_PAGES_PER_SCAN, HdPace, HdReadBlocked,
  type HdPaceState, NEW_PACE_STATE, paceStateOf,
} from '../src/scan/hdPace';

const T0 = Date.UTC(2026, 10, 23, 18);

function harness(random = 0) {
  let clock = T0;
  let state: HdPaceState = { ...NEW_PACE_STATE };
  const sleeps: number[] = [];
  const pace = new HdPace({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => random,
    load: () => state,
    save: (s) => {
      state = s;
    },
  });
  return { pace, sleeps, advance: (ms: number) => (clock += ms), now: () => clock, state: () => state };
}

/** One read: take, a read time of `readMs`, done. */
async function read(h: ReturnType<typeof harness>, mode: 'scan' | 'drip', outcome: 'read' | 'refused' | 'failed' = 'read', readMs = 4_000): Promise<number> {
  const t = await h.pace.take(mode);
  const startedAt = h.now();
  h.advance(readMs);
  t.done(outcome, 'a set item page');
  return startedAt;
}

describe("Home Depot's pace", () => {
  it('keeps the gap from the end of the last read, with its jitter, whatever kind of read came before', async () => {
    const h = harness(0.5);
    const first = await read(h, 'scan');
    const second = await read(h, 'scan');
    // The first read waits for nothing; the second starts the gap plus half the jitter after the first ended (4 s read).
    expect(first).toBe(T0);
    expect(second - (first + 4_000)).toBe(HD_GAP_MS + HD_GAP_JITTER_MS / 2);
    // A read already that far after the last waits for nothing.
    h.advance(60_000);
    const before = h.sleeps.length;
    await read(h, 'scan');
    expect(h.sleeps.length).toBe(before);
  });

  it('runs one read at a time: a second read asked while the first is out waits for it, then for the gap', async () => {
    const h = harness(0);
    const a = await h.pace.take('scan');
    let started = -1;
    const b = h.pace.take('scan').then((t) => {
      started = h.now();
      return t;
    });
    await Promise.resolve();
    expect(started).toBe(-1);
    h.advance(3_000);
    a.done('read');
    (await b).done('read');
    expect(started).toBe(T0 + 3_000 + HD_GAP_MS);
  });

  it('stops at the per-scan cap, counting every kind together, until the next scan begins', async () => {
    const h = harness(0);
    h.pace.beginRun();
    for (let i = 0; i < HD_PAGES_PER_SCAN; i++) await read(h, 'scan');
    expect(h.pace.left('scan')).toBe(0);
    await expect(h.pace.take('scan')).rejects.toMatchObject({ block: { reason: 'cap', cap: HD_PAGES_PER_SCAN } });
    h.pace.beginRun();
    expect(h.pace.left('scan')).toBe(HD_PAGES_PER_SCAN);
    await read(h, 'scan');
  });

  it('a refusal pauses every read for the cool-down, the rest of the scan and the drip included; a refusal right after doubles it', async () => {
    const h = harness(0);
    await read(h, 'scan', 'refused');
    const refusedAt = h.now();
    expect(h.pace.pausedUntil()).toBe(refusedAt + HD_COOLDOWN_MS);
    expect(h.pace.left('scan')).toBe(0);
    expect(h.pace.left('drip')).toBe(0);
    const blocked = await h.pace.take('drip').catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(HdReadBlocked);
    expect((blocked as HdReadBlocked).block).toEqual({ reason: 'paused', until: refusedAt + HD_COOLDOWN_MS });
    expect(h.state().lastRefusal).toEqual({ at: refusedAt, what: 'a set item page' });
    // After it, the next read is refused again: an hour this time.
    h.advance(HD_COOLDOWN_MS);
    await read(h, 'drip', 'refused');
    expect(h.pace.pausedUntil()).toBe(h.now() + 2 * HD_COOLDOWN_MS);
    // A page read after the cool-down ends the run of refusals: the next refusal pauses 30 minutes again.
    h.advance(2 * HD_COOLDOWN_MS);
    await read(h, 'drip', 'read');
    expect(h.state().refusals).toBe(0);
    await read(h, 'drip', 'refused');
    expect(h.pace.pausedUntil()).toBe(h.now() + HD_COOLDOWN_MS);
  });

  it('a read Chrome could not make is not a refusal: no cool-down', async () => {
    const h = harness(0);
    await read(h, 'scan', 'failed');
    expect(h.pace.pausedUntil()).toBeNull();
  });

  it('the drip reads at its own gap and within its daily cap, which starts again the next day', async () => {
    const h = harness(0);
    const a = await read(h, 'drip');
    const b = await read(h, 'drip');
    expect(b - (a + 4_000)).toBe(HD_DRIP_GAP_MS);
    const s = h.state();
    h.pace['d'].save({ ...s, dripPages: HD_LIMITS.dripPagesPerDay });
    expect(h.pace.blocked('drip')).toEqual({ reason: 'daily', cap: HD_LIMITS.dripPagesPerDay });
    h.advance(24 * 60 * 60_000);
    expect(h.pace.left('drip')).toBe(HD_LIMITS.dripPagesPerDay);
  });

  it('a stored state of the wrong shape is a new state', () => {
    expect(paceStateOf(undefined)).toEqual(NEW_PACE_STATE);
    expect(paceStateOf({ pausedUntil: 'soon', refusals: -2, lastRefusal: { at: 'x' } })).toEqual(NEW_PACE_STATE);
  });

  it('says what waits and at what pace, from the constants, and the pause first while paused', () => {
    expect(backlogSentence({ pages: 220, sets: 139, pausedUntil: null })).toBe(
      '139 sets wait for 220 Home Depot pages; between scans at most 40 are read an hour (240 a day), and each scan reads up to 40.',
    );
    expect(backlogSentence({ pages: 2, sets: 1, pausedUntil: T0, clock: () => '6:40 PM' })).toBe(
      'Home Depot paused reading until 6:40 PM; the rest continue then. 1 set waits for 2 Home Depot pages; between scans at most 40 are read an hour (240 a day), and each scan reads up to 40.',
    );
    expect(backlogSentence({ pages: 0, sets: 0, pausedUntil: null })).toBeNull();
    // The drip alone: 40 an hour, 240 a day.
    expect(dripHoursFor(220)).toBe(5.5);
    expect(dripHoursFor(300)).toBe(24 + 1.5);
  });
});
