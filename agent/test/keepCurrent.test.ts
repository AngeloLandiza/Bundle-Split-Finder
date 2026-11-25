// Keeping deals current between scans (agent/work.ts keepHdOne and the drip's keepPulls, agent/keepCurrent.ts), on the
// owner's app after scan 6 (fixtures/e2e-2026-11-23/after-scan6): 34 watched deals, the three PSK1212SB BOGO pairs Buy now.
// A fake clock whose sleep moves it, a fake paired Chrome (promoPage jobs) and a fake Keepa (1 token a product, recorded
// shape). No SerpApi, no AI: any other host fails the test.

import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentState } from '../../core/src/api/contract';
import { writePartTrend } from '../../core/src/keepa/trends';
import { HD_COOLDOWN_MS, HD_DRIP_GAP_MS, NEW_PACE_STATE } from '../../core/src/scan/hdPace';
import { HD_RECHECK_BUY_NOW_MS, AMAZON_RECHECK_BUY_NOW_MS, PRICES_STALE_MS } from '../../core/src/tracking/keepCurrent';
import type { BundleSignals } from '../../core/src/tracking/signals';
import { createAgent, type Agent } from '../app';
import { agentState, dealsResponse } from '../views';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6');
const TRACKING = JSON.parse(readFileSync(join(DIR, 'store', 'tracking.json'), 'utf8')) as Record<string, unknown> & { signals: Record<string, BundleSignals> };
/**
 * The tests' clock starts at noon, the owner's local time, the day after the deals were stored (Nov 24 23:42Z), whatever
 * the machine's time zone. Not the deals' own time: in UTC that is 18 minutes before midnight, and the day's counts
 * (keep-current's pages, Home Depot's "today") would start again partway through a test. Each test spans a few hours.
 */
const T0 = new Date(2026, 10, 25, 12).getTime();
const TEMPLATE = (JSON.parse(readFileSync('fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json', 'utf8')) as { products: Record<string, unknown>[] }).products[0]!;
const BOT = '999:bot-secret-token';
const SAW = 'homedepot:341966856'; // PSK1212SB-PCL515B, $99
const BUY = ['homedepot:341966856', 'homedepot:344305163', 'homedepot:341965772'];
/**
 * FBA fees per listing of the three Buy now deals. The owner's app counted Keepa's FBA fees for them, which the fixture does
 * not keep; this split is made up, but each deal's fees add up to what his estimates subtracted (PSK1212SB-PCL515B $32.77,
 * -PCL633B $27.74, -PCL031B $28.24), so the rebuilt estimates are his to the cent (+$43.19, +$38.79, +$26.47).
 */
const FBA: Record<string, number> = { B09HDZ5MPV: 7, B09BL9VXZX: 6.5, B0B1QRQYK2: 6.5, B0B88R7HWB: 12.77, B0D7XWRWG5: 7.74, B0CRFS4F6G: 8.24 };
const SOLD = new Map<string, number | null>();
const SAW_LINK = 'https://www.homedepot.com/p/RYOBI-ONE-18V-Kit-w-4-0-Ah-Battery-2-0-Ah-Battery-Charger-FREE-ONE-Cordless-Reciprocating-Saw-PSK1212SB-PCL515B/341966856';

let agent: Agent;
let clock: number;
let live: boolean;
let calls: string[];
let telegram: string[];
let tokens: number;
/** The promoPage jobs the fake Chrome took (one item id each). */
let taken: string[];
/** Home Depot's price per item id, as the fake Chrome reads it; the stored price when absent. */
let hdPrice: Map<string, number>;
let refuse: Set<string>;
/** Amazon's New price per ASIN (dollars), as the fake Keepa answers; the stored price when absent. */
let amazonPrice: Map<string, number>;

function keepaBody(consumed: number, extra: Record<string, unknown> = {}): Response {
  tokens -= consumed;
  return new Response(JSON.stringify({ ...extra, tokensLeft: tokens, tokensConsumed: consumed, refillRate: 1, refillIn: 30_000, processingTimeInMs: 1, timestamp: clock }), { status: 200 });
}

/** A Keepa product of the recorded shape for `asin`, its current New price set (stats.current[1]; no Amazon offer). */
async function product(asin: string): Promise<Record<string, unknown>> {
  const stored = (await agent.work.scanStore.getPrice(asin))?.price ?? null;
  const dollars = amazonPrice.get(asin) ?? stored;
  const stats = TEMPLATE.stats as { current: number[] };
  const current = [...stats.current];
  current[0] = -1;
  current[1] = dollars === null ? -1 : Math.round(dollars * 100);
  const fee = FBA[asin];
  return {
    ...TEMPLATE, asin, partNumber: null, title: `Listing ${asin}`, stats: { ...stats, current }, monthlySold: SOLD.get(asin) ?? -1,
    fbaFees: fee === undefined ? null : { lastUpdate: 1, pickAndPackFee: Math.round(fee * 100) },
  };
}

const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
  if (url.hostname === 'api.telegram.org') {
    telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  }
  if (url.hostname !== 'api.keepa.com') {
    calls.push(`other ${url.hostname}`);
    return new Response('{}', { status: 500 });
  }
  calls.push(`${url.pathname} ${url.searchParams.get('term') ?? url.searchParams.get('asin') ?? ''}`.trim());
  if (url.pathname === '/token') return keepaBody(0);
  if (url.pathname === '/product') {
    const asins = (url.searchParams.get('asin') ?? '').split(',');
    return keepaBody(asins.length, { products: await Promise.all(asins.map(product)) });
  }
  // A lookup's search finds nothing (these tests are not about finding listings).
  if (url.pathname === '/search') return keepaBody(10, { products: [] });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

/** The fake paired Chrome: each promoPage job reads the item's page at its price (or refuses it). */
async function chrome(): Promise<void> {
  while (live) {
    const job = await agent.jobs.next(20);
    if (!job) continue;
    const ids = ((job.input as { itemIds?: string[] }).itemIds ?? []).slice();
    if (job.kind === 'promoPage') taken.push(...ids);
    clock += 4_000;
    const result = job.kind === 'promoPage'
      ? await Promise.all(ids.map(async (id) => {
        if (refuse.has(id)) return { itemId: id, kind: 'refused', note: 'Error Page' };
        const b = await agent.work.scanStore.getBundle(`homedepot:${id}`);
        const price = hdPrice.get(id) ?? b?.price ?? 25;
        return { itemId: id, kind: 'read', page: { itemId: id, brand: 'RYOBI', model: b?.model ?? `M${id}`, title: b?.title ?? `Item ${id}`, price, wasPrice: null, bullets: [], description: null, promotions: [] } };
      }))
      : [];
    agent.jobs.complete({ id: job.id, ok: true, result });
  }
}

/**
 * The owner's app after scan 6, rebuilt: the scan store, the watchlist and its history, and the Keepa figures the signals
 * read (each listing's monthlySold as tracking.json stored it, and the FBA fees above). Fees from Keepa, as his.
 */
async function ownersApp(opts: { keepa: boolean }): Promise<void> {
  agent.store.update('keys', (k) => ({ ...k, ...(opts.keepa ? { keepa: 'keepa-secret-key-1' } : {}), telegram: { botToken: BOT, chatId: '42' } }));
  agent.store.update('settings', (s) => ({
    ...s,
    alerts: { ...s.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 },
    settings: { ...s.settings, fees: { ...s.settings.fees, fulfillmentSource: 'keepa', fulfillmentFee: 0 } },
  }));
  for (const s of Object.values(TRACKING.signals)) {
    for (const o of s.options) {
      for (const p of o.velocity.parts) {
        if (!p.asin || p.pulledAt === null) continue;
        SOLD.set(p.asin, p.monthlySold);
        await writePartTrend(agent.work.cache, { asin: p.asin, amazonPrice: null, salesRank: p.salesRank, offerCount: p.offers, pulledAt: p.pulledAt, monthlySold: p.monthlySold, fbaFee: FBA[p.asin] ?? null });
      }
    }
  }
  agent.store.update('tracking', (t) => ({ ...t, ...(TRACKING as object), sanityCleared: [] }));
  await agent.work.refresh();
  telegram.length = 0;
}

const buyNow = (): string[] => {
  const t = agent.store.get('tracking');
  return Object.keys(t.signals).filter((k) => t.watch[k]?.watched && t.signals[k]!.buyNow !== null).sort();
};

const data = () => ({
  deals: agent.store.get('deals'), review: agent.store.get('review'), runtime: agent.store.get('runtime'), settings: agent.store.get('settings'), tracking: agent.store.get('tracking'),
});
const row = (key: string) => dealsResponse(data(), { sort: 'profit' }, clock).rows.find((r) => r.id === key)!;
const state = (): AgentState => agentState(
  Object.fromEntries(['agent', 'settings', 'keys', 'deals', 'review', 'suggestions', 'activity', 'autopilot', 'answers', 'jobs', 'pairing', 'outbox', 'runtime', 'tracking'].map((n) => [n, agent.store.get(n as never)])) as never,
  { connected: true, lastSeenAt: null, jobsWaiting: 0, now: clock, busy: null, stopping: false, pipeline: null, nextScanAt: null },
);

beforeEach(() => {
  clock = T0;
  calls = [];
  telegram = [];
  taken = [];
  tokens = 0;
  hdPrice = new Map();
  amazonPrice = new Map();
  refuse = new Set();
  // The scan store of after-scan6 as the app keeps it on disk (each file a list of [key, record] pairs).
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-keep-'));
  cpSync(join(DIR, 'scan'), join(dataDir, 'scan'), { recursive: true });
  agent = createAgent({
    dataDir, port: 0, timers: false, fetchFn, now: () => clock,
    work: { hdSleep: async (ms) => void (clock += ms), hdRandom: () => 0 },
  });
  live = true;
});

afterEach(async () => {
  live = false;
  await agent.work.idle();
  agent.close();
});

async function connected(): Promise<{ polling: Promise<void> }> {
  const polling = chrome();
  while (agent.jobs.pollers() === 0) await new Promise((r) => setTimeout(r, 2));
  return { polling };
}

describe("Home Depot's price of a Buy now or watched deal, re-read between scans", () => {
  it('Buy now first (oldest checked first), then the watched deals; a Buy now deal again after 4 hours, a watched one not before 12', async () => {
    await ownersApp({ keepa: false });
    expect(buyNow()).toEqual([...BUY].sort());
    const { polling } = await connected();
    const read = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await agent.work.drip();
        clock += HD_DRIP_GAP_MS;
      }
    };
    await read(3);
    // The three Buy now deals, oldest checked first (344305163 was last seen 16:21, the other two 17:04, by item id).
    expect(taken).toEqual(['344305163', '341965772', '341966856']);
    // Each the same price: only its checked time moved, and the row says it.
    expect(row(SAW).pricesChecked!.homeDepotAt).toBe(new Date((await agent.work.scanStore.getBundle(SAW))!.seenAt).toISOString());
    await read(31);
    // Then the 31 other watched deals, each once.
    const watched = new Set(Object.keys(agent.store.get('tracking').watch).map((k) => k.replace('homedepot:', '')));
    expect(taken).toHaveLength(34);
    expect(new Set(taken)).toEqual(watched);
    expect(agent.store.get('runtime').keepCurrent).toMatchObject({ pages: 34 });
    // The next reads are the pages bundles wait for, not these deals again.
    await read(2);
    expect(taken.slice(34).every((id) => !watched.has(id))).toBe(true);
    // Four hours after their read, the Buy now deals come first again; no watched deal before its 12 hours.
    const first = taken.length;
    clock = T0 + HD_RECHECK_BUY_NOW_MS + 4 * HD_DRIP_GAP_MS;
    await read(4);
    expect(taken.slice(first, first + 3)).toEqual(['344305163', '341965772', '341966856']);
    expect(watched.has(taken[first + 3]!)).toBe(false);
    // The Activity run of the hour says what was checked; nothing was spent.
    expect(agent.store.get('activity').runs.some((r) => /watched deals' prices checked/.test(r.summary))).toBe(true);
    expect(calls).toEqual([]);
    live = false;
    await polling;
  }, 240_000); // 40 page reads through the real store: slow when the whole suite runs at once.

  it("a price rise withdraws Buy now at once: one sentence in Activity with the before and after and the link, and the owner's message", async () => {
    await ownersApp({ keepa: false });
    hdPrice.set('341966856', 129);
    const { polling } = await connected();
    for (let i = 0; i < 3; i += 1) {
      await agent.work.drip();
      clock += HD_DRIP_GAP_MS;
    }
    expect(taken).toEqual(['344305163', '341965772', '341966856']);
    expect((await agent.work.scanStore.getBundle(SAW))!.price).toBe(129);
    expect(buyNow()).toEqual(['homedepot:341965772', 'homedepot:344305163']);
    // Nov 25: leaving the state names the condition that now fails first, then the price that moved.
    const sentence = `PSK1212SB-PCL515B is no longer worth buying: est. $13.19 is below your $20 and 10% ROI below your 20%. Home Depot's price went from $99.00 to $129.00 (${SAW_LINK}). Est. profit $13.19, was $43.19 (an estimate from your fee settings, not your real fees).`;
    expect(agent.store.get('activity').runs.filter((r) => r.id.includes('-keep-')).map((r) => r.summary)).toEqual([sentence]);
    expect(telegram).toEqual([sentence]);
    // The row is no longer Buy now; its verdict and its price's age both show.
    expect(row(SAW)).toMatchObject({ buyNow: false, price: 129 });
    expect(row(SAW).signalNote).toMatch(/^Not worth buying now/);
    expect(row(SAW).pricesChecked).toBeDefined();
    live = false;
    await polling;
  });

  it("at a low ceiling (after refusals) Buy now still goes first; a watched deal's refresh gives way to the pages bundles wait for", async () => {
    await ownersApp({ keepa: false });
    // Home Depot refused pages this morning: the ceiling is 10 an hour (one page every 6 minutes).
    agent.store.update('runtime', (r) => ({ ...r, hdPace: { ...NEW_PACE_STATE, perHour: 10, perHourAt: clock - 60_000, lastRefusal: { at: clock - 60_000, what: 'a bundle page' } } }));
    const backlog = await agent.work.noteBacklog();
    expect(backlog.pages).toBeGreaterThan(0);
    const { polling } = await connected();
    for (let i = 0; i < 4; i += 1) {
      await agent.work.drip();
      clock += 6 * 60_000;
    }
    expect(taken.slice(0, 3)).toEqual(['344305163', '341965772', '341966856']);
    const watched = new Set(Object.keys(agent.store.get('tracking').watch).map((k) => k.replace('homedepot:', '')));
    expect(taken).toHaveLength(4);
    expect(watched.has(taken[3]!)).toBe(false);
    // The words say the ceiling in force and why; the Agent panel says Buy now goes first.
    expect(state().agent.homeDepot!.sentence).toMatch(/between scans at most 10 are read an hour today, after Home Depot refused pages this (morning|afternoon|evening) \(240 a day\)/);
    expect(state().agent.keepCurrent!.sentence).toMatch(/Home Depot's ceiling is 10 pages an hour today: Buy now deals are read first, the other watched deals after the pages bundles wait for\.$/);
    live = false;
    await polling;
  });

  it('a refusal pauses it like any other read; the refused deal is read first once reading goes on', async () => {
    await ownersApp({ keepa: false });
    refuse.add('344305163');
    const { polling } = await connected();
    await agent.work.drip();
    expect(taken).toEqual(['344305163']);
    const until = agent.work.pace.pausedUntil()!;
    expect(until - clock).toBeLessThanOrEqual(HD_COOLDOWN_MS);
    // Every look during the cool-down reads nothing.
    for (let t = HD_DRIP_GAP_MS; t < HD_COOLDOWN_MS - HD_DRIP_GAP_MS; t += HD_DRIP_GAP_MS) {
      clock += HD_DRIP_GAP_MS;
      await agent.work.drip();
    }
    expect(taken).toEqual(['344305163']);
    // After it: the same deal first (a refusal is not a try).
    refuse.clear();
    clock = until + 1;
    await agent.work.drip();
    expect(taken).toEqual(['344305163', '344305163']);
    expect(calls).toEqual([]);
    live = false;
    await polling;
  });

  it('stale: with Chrome closed and no Keepa, a Buy now row says since when its prices were not checked, is not announced, and keeps its verdict', async () => {
    await ownersApp({ keepa: false });
    // The stored Amazon prices of these parts were pulled on Nov 23 (PBP004 at 1795434405070): more than 8 hours ago.
    const r = row(SAW);
    expect(r.buyNow).toBe(true);
    expect(r.signalNote).toMatch(/^Worth buying now|^Its Amazon listings/);
    expect(r.pricesChecked).toEqual({
      homeDepotAt: new Date((await agent.work.scanStore.getBundle(SAW))!.seenAt).toISOString(),
      amazonAt: new Date(1795434405070).toISOString(),
      staleSince: new Date(1795434405070).toISOString(),
    });
    // A watched deal that is not Buy now shows its ages, never a stale label.
    const other = dealsResponse(data(), { sort: 'profit' }, clock).rows.find((x) => x.watched && !x.buyNow)!;
    expect(other.pricesChecked!.staleSince).toBeUndefined();
    // Judged again (an owner's action rebuilds the deals) the next day: a stale buy is not sent.
    agent.store.update('tracking', (t) => ({ ...t, notified: [] }));
    clock += 24 * 60 * 60_000;
    await agent.work.refresh();
    expect(telegram.join('\n')).not.toMatch(/PSK1212SB/);
    expect(PRICES_STALE_MS).toBe(8 * 60 * 60_000);
  });
});

describe("Amazon's price of each part of those deals, refreshed through Keepa", () => {
  it('Buy now parts first, 1 token each, within the reserve; a price drop withdraws Buy now with its sentence; not again before 2 hours', async () => {
    await ownersApp({ keepa: true });
    // 14 tokens, the reserve 5: 9 pulls, the 6 Buy now listings first, then 3 of the watched deals' (oldest checked);
    // nothing is left for a lookup (11 tokens), which comes after them in the drip's order.
    tokens = 14;
    amazonPrice.set('B0B88R7HWB', 39.99);
    await agent.work.drip();
    const pulls = calls.filter((c) => c.startsWith('/product'));
    expect(calls[0]).toBe('/token');
    expect(pulls).toHaveLength(9);
    // The listings of the three PSK1212SB deals first, oldest checked first (PBP004, pulled Nov 23 at 1795434405070).
    expect(pulls[0]).toBe('/product B09HDZ5MPV');
    expect(pulls.slice(0, 6).map((c) => c.split(' ')[1]).sort()).toEqual(['B09BL9VXZX', 'B09HDZ5MPV', 'B0B1QRQYK2', 'B0B88R7HWB', 'B0CRFS4F6G', 'B0D7XWRWG5']);
    expect(calls.some((c) => c.startsWith('/search'))).toBe(false);
    expect(calls.some((c) => c.startsWith('other'))).toBe(false);
    expect(agent.store.get('runtime').keepCurrent).toMatchObject({ tokens: 9 });
    expect((await agent.work.scanStore.getPrice('B0B88R7HWB'))).toMatchObject({ price: 39.99, checkedAt: clock });
    expect(buyNow()).toEqual(['homedepot:341965772', 'homedepot:344305163']);
    const sentence = "PSK1212SB-PCL515B is no longer worth buying: est. $9.19 is below your $20 and 9% ROI below your 20%. Amazon's price of PCL515B went from $79.99 to $39.99 (https://www.amazon.com/dp/B0B88R7HWB).";
    const keep = agent.store.get('activity').runs.filter((r) => r.id.includes('-keep-')).map((r) => r.summary);
    expect(keep).toHaveLength(1);
    expect(keep[0]).toMatch(new RegExp(`^${sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Est\\. profit \\$\\d+\\.\\d\\d, was \\$43\\.19 \\(an estimate from your fee settings, not your real fees\\)\\.$`));
    expect(telegram.join('\n')).toContain(sentence);
    expect(agent.store.get('activity').runs.some((r) => r.summary.includes('Checked 9 Amazon prices of watched deals with Keepa.'))).toBe(true);
    // Five minutes later: nothing due for Buy now before its 2 hours.
    calls = [];
    tokens = 40;
    clock += 5 * 60_000 + 1;
    await agent.work.drip();
    expect(calls.filter((c) => c.startsWith('/product') && ['B09HDZ5MPV', 'B09BL9VXZX', 'B0B1QRQYK2'].some((a) => c.endsWith(a)))).toEqual([]);
    expect(AMAZON_RECHECK_BUY_NOW_MS).toBe(2 * 60 * 60_000);
  });

  it("the Agent panel says what it costs a day at the current settings (after scan 6's watchlist)", async () => {
    await ownersApp({ keepa: true });
    agent.store.update('runtime', (r) => ({ ...r, keepa: { tokensLeft: 100, refillIn: 0, refillRate: 1, at: new Date(clock).toISOString() } }));
    const k = state().agent.keepCurrent!;
    // Rebuilt from the scan store (the app's checks at start included), the watched deals hold 43 distinct listings: 146
    // tokens. The deals as the owner's app stored them hold 44: 148 (core/test/keep-current.test.ts).
    expect(k).toMatchObject({ buyNow: 3, watched: 31, pagesPerDay: 80, tokensPerDay: 146, pageShare: 120, tokenShare: 360, keepa: true, pagesWaiting: 0, pullsWaiting: 0 });
    expect(k.sentence).toMatch(/^Keeping 3 Buy now deals and 31 other watched deals current: about 80 Home Depot pages a day .* and about 146 Keepa tokens a day for 43 Amazon prices /);
  });
});
