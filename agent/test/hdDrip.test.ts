// Home Depot's pace, between scans (agent/work.ts hdDripOne): while the helper is connected and nothing else runs, the
// agent reads the next waiting Home Depot page at the drip's gap, in the scan's order, and what it settles goes through the
// scan's own code. On the owner's after-scan5 store (139 sets waiting for 220 item pages), a fake clock whose sleep moves
// it, and a fake paired Chrome. No SerpApi, no Keepa, no AI: every network call fails the test.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '../../core/src/api/contract';
import { HD_COOLDOWN_MS, HD_DRIP_GAP_MS, HD_LIMITS } from '../../core/src/scan/hdPace';
import { loadScanFolder } from '../../scripts/data-folder';
import { createAgent, type Agent } from '../app';
import { agentState } from '../views';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan5');
const T0 = Date.UTC(2026, 10, 24, 1);

let agent: Agent;
let clock: number;
let live: boolean;
let network: string[];
/** The jobs the fake Chrome took: kind, item ids, and the clock when it took each. */
let taken: { kind: string; ids: string[]; at: number }[];
let refuse: Set<string>;

async function chrome(): Promise<void> {
  while (live) {
    const job = await agent.jobs.next(20);
    if (!job) continue;
    const ids = ((job.input as { itemIds?: string[] }).itemIds ?? []).slice();
    taken.push({ kind: job.kind, ids, at: clock });
    clock += 4_000;
    const result = job.kind === 'promoPage'
      ? ids.map((id) => (refuse.has(id)
        ? { itemId: id, kind: 'refused', note: 'Error Page' }
        : { itemId: id, kind: 'read', page: { itemId: id, brand: 'RYOBI', model: `M${id}`, title: `Item ${id}`, price: 25, wasPrice: null, bullets: [], description: null, promotions: [] } }))
      : [];
    agent.jobs.complete({ id: job.id, ok: true, result });
  }
}

beforeEach(async () => {
  clock = T0;
  network = [];
  taken = [];
  refuse = new Set();
  const fetchFn = (async (input: string | URL | Request) => {
    network.push(String(typeof input === 'string' || input instanceof URL ? input : input.url));
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  agent = createAgent({
    dataDir: mkdtempSync(join(tmpdir(), 'sf-hd-drip-')), port: 0, timers: false, fetchFn, now: () => clock,
    work: { hdSleep: async (ms) => void (clock += ms), hdRandom: () => 0 },
  });
  const fixture = await loadScanFolder(DIR);
  for (const b of await fixture.listBundles()) await agent.work.scanStore.putBundle(b);
  for (const m of await fixture.listMatches()) await agent.work.scanStore.putMatch(m);
  for (const p of await fixture.listPartPrices()) await agent.work.scanStore.putPartPrice(p);
  await agent.work.noteBacklog();
  // The deals as the scan left them (built from the store; nothing fetched).
  await agent.work.refresh();
  live = true;
});

afterEach(async () => {
  live = false;
  await agent.work.idle();
  agent.close();
});

async function connected(): Promise<{ polling: Promise<void> }> {
  const polling = chrome();
  await vi.waitFor(() => expect(agent.jobs.pollers()).toBeGreaterThan(0));
  return { polling };
}

const state = (): AgentState => agentState(
  Object.fromEntries(['agent', 'settings', 'keys', 'deals', 'review', 'suggestions', 'activity', 'autopilot', 'answers', 'jobs', 'pairing', 'outbox', 'runtime', 'tracking'].map((n) => [n, agent.store.get(n as never)])) as never,
  { connected: true, lastSeenAt: null, jobsWaiting: 0, now: clock, busy: null, stopping: false, pipeline: null, nextScanAt: null },
);

describe("the slow free read between scans (Home Depot's pace)", () => {
  it('reads one page a look, at the drip\'s gap, biggest saving first; a set whose last item is read settles through the scan\'s own split', async () => {
    const { polling } = await connected();
    expect(state().agent.homeDepot).toMatchObject({ pagesWaiting: 220, setsWaiting: 139, perHour: 40, perDay: 240, perScan: 40, pausedUntil: null });
    expect(state().agent.homeDepot!.sentence).toBe('139 sets wait for 220 Home Depot pages; between scans at most 40 are read an hour (240 a day), and each scan reads up to 40.');

    await agent.work.drip();
    // The set with the biggest saving (336796097, $59.94, was $99.94): its first item's page, one page in one job.
    const set = (await agent.work.scanStore.getBundle('homedepot:336796097'))!;
    const [first, second] = set.set!.items.map((i) => i.itemId);
    expect(taken).toEqual([{ kind: 'promoPage', ids: [first], at: T0 }]);

    // Asked again at once: its gap has not passed, so nothing is read.
    await agent.work.drip();
    expect(taken).toHaveLength(1);

    // After the gap: the set's second item. The set is whole now: settled from Home Depot's own item list.
    clock += HD_DRIP_GAP_MS;
    await agent.work.drip();
    expect(taken.map((t) => t.ids)).toEqual([[first], [second]]);
    expect(taken[1]!.at - (taken[0]!.at + 4_000)).toBeGreaterThanOrEqual(HD_DRIP_GAP_MS);
    expect((await agent.work.scanStore.getBundle('homedepot:336796097'))!.split).toMatchObject({ status: 'resolved', components: [`M${first}`, `M${second}`] });
    // Its parts' Home Depot readings are the part pipeline's own records, as after a scan.
    expect(await agent.work.scanStore.getPartPrice(`RYOBI:M${first}`)).toMatchObject({ price: 25, itemId: first });
    // The deals are rebuilt with it, the count goes down, the hour's Activity run says what was read.
    const row = agent.store.get('deals').bundles.find((b) => b.key === 'homedepot:336796097')!;
    expect(row.waitingPage ?? false).toBe(false);
    expect(row.parts.map((p) => p.model)).toEqual([`M${first}`, `M${second}`]);
    expect(state().agent.homeDepot).toMatchObject({ pagesWaiting: 218, setsWaiting: 138, readToday: 2 });
    expect(agent.store.get('activity').runs.find((r) => r.id.endsWith('-hd'))?.summary).toBe(
      'Read 2 Home Depot pages between scans (free); 1 bundle settled. 138 sets wait for 218 Home Depot pages; between scans at most 40 are read an hour (240 a day), and each scan reads up to 40.',
    );
    // Free: no search, no Keepa, no model was asked.
    expect(network).toEqual([]);
    live = false;
    await polling;
  });

  it('a refusal pauses it for the cool-down: nothing is read, the state and the rows say until when; then it goes on', async () => {
    const { polling } = await connected();
    const set = (await agent.work.scanStore.getBundle('homedepot:336796097'))!;
    refuse.add(set.set!.items[0]!.itemId);
    await agent.work.drip();
    expect(taken).toHaveLength(1);
    const until = clock + HD_COOLDOWN_MS;
    expect(agent.work.pace.pausedUntil()).toBe(until);
    expect(state().agent.homeDepot!.pausedUntil).toBe(new Date(until).toISOString());
    expect(state().agent.homeDepot!.sentence).toMatch(/^Home Depot paused reading until .+; the rest continue then\. 139 sets wait for 220 Home Depot pages;/);
    // Every look during the cool-down reads nothing.
    for (let t = 0; t < HD_COOLDOWN_MS - HD_DRIP_GAP_MS; t += HD_DRIP_GAP_MS) {
      clock += HD_DRIP_GAP_MS;
      await agent.work.drip();
    }
    expect(taken).toHaveLength(1);
    // A waiting row says it too.
    const deals = (await import('../views')).dealsResponse(
      { deals: agent.store.get('deals'), review: agent.store.get('review'), runtime: agent.store.get('runtime'), settings: agent.store.get('settings'), tracking: agent.store.get('tracking') },
      { sort: 'profit' }, clock,
    );
    expect(deals.rows.find((r) => r.matchKind === 'waiting_page')?.pageWait).toMatch(/^Home Depot paused reading until /);
    // Once it has passed (and Home Depot answers again), reading goes on where it stopped.
    refuse.clear();
    clock = until + 1;
    await agent.work.drip();
    expect(taken.map((t) => t.ids[0])).toEqual([set.set!.items[0]!.itemId, set.set!.items[0]!.itemId]);
    live = false;
    await polling;
  });

  it("stops at today's drip pages, and does not read with Chrome closed", async () => {
    agent.store.update('runtime', (r) => ({ ...r, hdPace: { lastEndedAt: null, pausedUntil: null, refusals: 0, lastRefusal: null, day: agent.work.pace.state().day, dripPages: HD_LIMITS.dripPagesPerDay } }));
    const { polling } = await connected();
    await agent.work.drip();
    expect(taken).toEqual([]);
    live = false;
    await polling;
    agent.store.update('runtime', (r) => ({ ...r, hdPace: undefined }));
    await agent.work.drip();
    expect(taken).toEqual([]);
  });
});
