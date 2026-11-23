// Home Depot's pace in the agent's readers (agent/remoteReaders.ts with a gate from core/src/scan/hdPace.ts), with a fake
// clock whose sleep moves it and a fake helper that answers the worker jobs: the gap is kept across every kind of job, a
// page job asks for one page, the cap stops reading, and a refusal starts the cool-down, during which nothing is queued.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HD_COOLDOWN_MS, HD_DRIP_GAP_MS, HD_GAP_MS, HdPace, HdReadBlocked, type HdMode, type HdPaceState, NEW_PACE_STATE } from '../../core/src/scan/hdPace';
import { remoteReaders } from '../remoteReaders';
import { Store } from '../store';
import { WorkerJobs } from '../workerJobs';

const T0 = Date.UTC(2026, 10, 23, 23);
/** How long the fake helper takes to read one page. */
const READ_MS = 3_000;

let store: Store | null = null;
let jobs: WorkerJobs | null = null;
let live = false;
afterEach(() => {
  live = false;
  jobs?.stop();
  store?.close();
});

type Answer = (kind: string, input: Record<string, unknown>) => unknown;

function setup(limits: { pagesPerScan?: number } = {}) {
  let clock = T0;
  let state: HdPaceState = { ...NEW_PACE_STATE };
  store = Store.open(mkdtempSync(join(tmpdir(), 'sf-pace-')));
  jobs = new WorkerJobs(store);
  const q = jobs;
  const pace = new HdPace({
    now: () => clock, random: () => 0, limits,
    sleep: async (ms) => {
      clock += ms;
    },
    load: () => state, save: (s) => {
      state = s;
    },
  });
  /** Each job the helper took: its kind, its input, and when (the fake clock) it started. */
  const seen: { kind: string; input: Record<string, unknown>; at: number }[] = [];
  let answer: Answer = () => [];
  live = true;
  void (async () => {
    while (live) {
      const job = await q.next(20);
      if (!job) continue;
      seen.push({ kind: job.kind, input: job.input as Record<string, unknown>, at: clock });
      clock += READ_MS;
      q.complete({ id: job.id, ok: true, result: answer(job.kind, job.input as Record<string, unknown>) });
    }
  })();
  const readers = (mode: HdMode) => remoteReaders({ jobs: q, timeouts: { pageMs: 5_000, perItemMs: 0, toolMs: 5_000 }, gate: { take: (signal) => pace.take(mode, signal) } });
  return { pace, seen, readers, answer: (a: Answer) => (answer = a), now: () => clock, advance: (ms: number) => (clock += ms) };
}

const page = (id: string) => ({ itemId: id, kind: 'read', content: { title: `Page ${id}`, bullets: [], description: null } });
const promo = (id: string) => ({ itemId: id, kind: 'read', page: { itemId: id, brand: 'RYOBI', model: `P${id.slice(-3)}`, title: 'Item', price: 99, wasPrice: null, bullets: [], description: null, promotions: [] } });
const helperAnswers: Answer = (kind, input) => {
  const ids = (input.itemIds as string[] | undefined) ?? [];
  if (kind === 'page') return ids.map(page);
  if (kind === 'promoPage') return ids.map(promo);
  if (kind === 'search') return { sourceId: 's', label: 'Search', url: 'https://www.homedepot.com/s/x', results: [{ title: 'RYOBI P737', brand: 'RYOBI', model: 'P737', itemId: '205100737', url: 'https://www.homedepot.com/p/205100737' }] };
  if (kind === 'partPrice') return { brand: 'RYOBI', model: 'P737', status: 'found', itemId: '205100737', matchedModel: 'P737', price: 79, title: 'RYOBI P737', link: 'https://www.homedepot.com/p/205100737' };
  if (kind === 'bundleListing') return { products: [] };
  return [];
};

describe("Home Depot's pace in the agent's readers", () => {
  it('keeps the gap between any two jobs of any kind, from the end of the last; a page job asks for one page', async () => {
    const h = setup();
    h.answer(helperAnswers);
    const scan = h.readers('scan');
    await scan.readPages(['311111111', '322222222']);
    await scan.readPartPrices([{ brand: 'RYOBI', model: 'P737' }]);
    await scan.readBundleListing('/b/N-5yc1vZbwo64Zm5d');
    expect(h.seen.map((s) => s.kind)).toEqual(['page', 'page', 'search', 'partPrice', 'bundleListing']);
    expect(h.seen.every((s) => s.kind !== 'page' || (s.input.itemIds as string[]).length === 1)).toBe(true);
    // Each job starts the gap after the one before it ended (random 0: no jitter here).
    const gaps = h.seen.slice(1).map((s, i) => s.at - (h.seen[i]!.at + READ_MS));
    expect(gaps.every((g) => g >= HD_GAP_MS)).toBe(true);
    expect(gaps).toEqual([HD_GAP_MS, HD_GAP_MS, HD_GAP_MS, HD_GAP_MS]);
    // The drip's reads keep its own, longer gap after a scan's read too.
    await h.readers('drip').readPromoPages(['333333333']);
    expect(h.seen.at(-1)!.at - (h.seen.at(-2)!.at + READ_MS)).toBe(HD_DRIP_GAP_MS);
  });

  it('stops at the per-scan cap: the pages past it are skipped and never queued; a part price counts its search and its page', async () => {
    const h = setup({ pagesPerScan: 3 });
    h.answer(helperAnswers);
    const scan = h.readers('scan');
    const got = await scan.readPromoPages(['311111111', '322222222', '333333333', '344444444']);
    expect(got.map((o) => o.kind)).toEqual(['read', 'read', 'read', 'skipped']);
    expect(h.seen).toHaveLength(3);
    await expect(scan.readBundleListing('/b/N-5yc1vZbwo64Zm5d')).rejects.toBeInstanceOf(HdReadBlocked);
    const prices = await scan.readPartPrices([{ brand: 'RYOBI', model: 'P737' }]);
    expect(prices[0]!.status).toBe('not_read');
    expect(h.seen).toHaveLength(3);
    // The next scan has its pages again.
    h.pace.beginRun();
    expect((await scan.readPartPrices([{ brand: 'RYOBI', model: 'P737' }]))[0]!.status).toBe('found');
    expect(h.seen.map((s) => s.kind).slice(3)).toEqual(['search', 'partPrice']);
  });

  it('a refusal ends the batch and starts the cool-down: nothing of any kind is queued during it, the drip included', async () => {
    const h = setup();
    h.answer((kind, input) => {
      const id = (input.itemIds as string[])[0]!;
      return id === '322222222' ? [{ itemId: id, kind: 'refused', note: 'Error Page' }] : [page(id)];
    });
    const scan = h.readers('scan');
    const got = await scan.readPages(['311111111', '322222222', '333333333']);
    expect(got.map((o) => o.kind)).toEqual(['read', 'refused', 'skipped']);
    const refusedAt = h.now();
    expect(h.pace.pausedUntil()).toBe(refusedAt + HD_COOLDOWN_MS);
    expect(h.pace.state().lastRefusal).toEqual({ at: refusedAt, what: 'a bundle page' });
    const queued = h.seen.length;
    // During the cool-down: a bundle list, a part price, the drip's item pages: none reaches the helper.
    await expect(scan.readBundleListing('/b/N-5yc1vZbwo64Zm5d')).rejects.toMatchObject({ block: { reason: 'paused', until: refusedAt + HD_COOLDOWN_MS } });
    expect((await scan.readPartPrices([{ brand: 'RYOBI', model: 'P737' }]))[0]!.status).toBe('not_read');
    expect((await h.readers('drip').readPromoPages(['344444444'])).map((o) => o.kind)).toEqual(['skipped']);
    h.advance(HD_COOLDOWN_MS - 60_000);
    expect((await h.readers('drip').readPromoPages(['344444444'])).map((o) => o.kind)).toEqual(['skipped']);
    expect(h.seen).toHaveLength(queued);
    // Once it has passed, reading continues.
    h.advance(60_000);
    h.answer(helperAnswers);
    expect((await h.readers('drip').readPromoPages(['344444444'])).map((o) => o.kind)).toEqual(['read']);
    expect(h.seen).toHaveLength(queued + 1);
  });

  it('a list Home Depot refused starts the cool-down', async () => {
    const h = setup();
    h.answer((kind) => (kind === 'bundleListing' ? { error: 'Home Depot refused the bundle list (HTTP 403).' } : helperAnswers(kind, {})));
    await expect(h.readers('scan').readBundleListing('/b/N-5yc1vZbwo64Zm5d')).rejects.toThrow('refused');
    expect(h.pace.pausedUntil()).not.toBeNull();
  });

  it('a part price Chrome could not read (not_read) starts the cool-down', async () => {
    const g = setup();
    g.answer((kind, input) => (kind === 'partPrice' ? { brand: 'RYOBI', model: 'P737', status: 'not_read', itemId: null, matchedModel: null, price: null, title: null, link: null } : helperAnswers(kind, input)));
    await g.readers('scan').readPartPrices([{ brand: 'RYOBI', model: 'P737' }]);
    expect(g.pace.pausedUntil()).not.toBeNull();
  });
});
