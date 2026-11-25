// What Home Depot's own page states about buying a Buy now deal (Nov 25), through the agent: the keep-current re-read keeps it,
// a page that says "cannot be bought" takes the deal out of Buy now with the true sentence (and a later page that says it can
// brings it back), the limit and the promotion's end show on the row, one message says the price is about to end, and after the
// end the deal's price is read first and not announced until it is. The owner's deals after scan 6 (fixtures/e2e-2026-11-23),
// the recorded page's statements (fixtures/homedepot-pages/availability-344305163-2026-11-25.json), a fake paired Chrome, a
// fake clock. No SerpApi, no Keepa, no AI: any other host fails the test.

import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuyingFacts } from '../../core/src/hdPage';
import { writePartTrend } from '../../core/src/keepa/trends';
import { HD_DRIP_GAP_MS } from '../../core/src/scan/hdPace';
import { readOneDue } from '../keepCurrent';
import { keptNow, staleBuyKeys } from '../keepCurrent';
import type { BundleSignals } from '../../core/src/tracking/signals';
import { createAgent, type Agent } from '../app';
import { dealsResponse } from '../views';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6');
const TRACKING = JSON.parse(readFileSync(join(DIR, 'store', 'tracking.json'), 'utf8')) as Record<string, unknown> & { signals: Record<string, BundleSignals> };
/** Noon on Nov 25 2026, the owner's clock. */
const T0 = new Date(2026, 10, 25, 12).getTime();
const BOT = '999:bot-secret-token';
/** Each test rebuilds the owner's deals (a full refresh through the real store): slow when the whole suite runs at once. */
const SLOW = 300_000;
const VAC = 'homedepot:344305163'; // PSK1212SB-PCL633B, the recorded page's item, $99
const VAC_ID = '344305163';
const BUY = ['homedepot:341966856', 'homedepot:344305163', 'homedepot:341965772'];
const FBA: Record<string, number> = { B09HDZ5MPV: 7, B09BL9VXZX: 6.5, B0B1QRQYK2: 6.5, B0B88R7HWB: 12.77, B0D7XWRWG5: 7.74, B0CRFS4F6G: 8.24 };
const RECORDED: BuyingFacts = {
  buyable: true, discontinued: false, availability: 'Online', quantityLimit: 3, returnable: '90-Day', promotionStart: '2026-10-26', promotionEnd: '2027-01-31',
};

let agent: Agent;
let clock: number;
let live: boolean;
let telegram: string[];
let other: string[];
/** The promoPage jobs the fake Chrome took (one item id each). */
let taken: string[];
/** What the page of an item states about buying it, as the fake Chrome reads it; none when absent (a page as it was before). */
let stated: Map<string, BuyingFacts>;

const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
  if (url.hostname === 'api.telegram.org') {
    telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  }
  other.push(url.hostname);
  return new Response('{}', { status: 500 });
}) as typeof fetch;

async function chrome(): Promise<void> {
  while (live) {
    const job = await agent.jobs.next(20);
    if (!job) continue;
    const ids = ((job.input as { itemIds?: string[] }).itemIds ?? []).slice();
    if (job.kind === 'promoPage') taken.push(...ids);
    clock += 4_000;
    const result = job.kind === 'promoPage'
      ? await Promise.all(ids.map(async (id) => {
        const b = await agent.work.scanStore.getBundle(`homedepot:${id}`);
        const buying = stated.get(id);
        return {
          itemId: id, kind: 'read',
          page: { itemId: id, brand: 'RYOBI', model: b?.model ?? `M${id}`, title: b?.title ?? `Item ${id}`, price: b?.price ?? 25, wasPrice: null, bullets: [], description: null, promotions: [], ...(buying ? { buying } : {}) },
        };
      }))
      : [];
    agent.jobs.complete({ id: job.id, ok: true, result });
  }
}

async function ownersApp(): Promise<void> {
  agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: BOT, chatId: '42' } }));
  agent.store.update('settings', (s) => ({
    ...s,
    alerts: { ...s.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 },
    settings: { ...s.settings, fees: { ...s.settings.fees, fulfillmentSource: 'keepa', fulfillmentFee: 0 } },
  }));
  for (const s of Object.values(TRACKING.signals)) {
    for (const o of s.options) {
      for (const p of o.velocity.parts) {
        if (!p.asin || p.pulledAt === null) continue;
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

beforeEach(() => {
  clock = T0;
  telegram = [];
  other = [];
  taken = [];
  stated = new Map();
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-buying-'));
  cpSync(join(DIR, 'scan'), join(dataDir, 'scan'), { recursive: true });
  agent = createAgent({ dataDir, port: 0, timers: false, fetchFn, now: () => clock, work: { hdSleep: async (ms) => void (clock += ms), hdRandom: () => 0 } });
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

/** The drip reads the three Buy now deals, oldest checked first, one page each. */
async function readBuyNow(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await agent.work.drip();
    clock += HD_DRIP_GAP_MS;
  }
}

describe('what the page states, kept by the keep-current re-read', () => {
  it('a deal never read since this was kept says "not checked yet" and stays Buy now; once read, the row says the limit and when the price ends', async () => {
    await ownersApp();
    expect(buyNow()).toEqual([...BUY].sort());
    expect(row(VAC).buying).toMatchObject({ state: 'unchecked', line: "Home Depot's page: not checked yet", limit: null, limitLine: null, priceEndsLine: null });
    expect(row(VAC).buyNow).toBe(true);
    stated.set(VAC_ID, RECORDED);
    const { polling } = await connected();
    await readBuyNow();
    expect(taken).toEqual(['344305163', '341965772', '341966856']);
    // Kept on the record with the time it was read; the two other pages stated nothing, so those deals are still unchecked.
    expect((await agent.work.scanStore.getBundle(VAC))!.buying).toEqual({ ...RECORDED, readAt: expect.any(Number) });
    expect((await agent.work.scanStore.getBundle('homedepot:341966856'))!.buying).toBeUndefined();
    expect(row('homedepot:341966856').buying!.state).toBe('unchecked');
    // Still Buy now, the verdict unchanged, nothing sent.
    expect(buyNow()).toEqual([...BUY].sort());
    expect(row(VAC).signalNote).toMatch(/^Worth buying now/);
    expect(telegram).toEqual([]);
    const b = row(VAC).buying!;
    expect(b).toMatchObject({
      state: 'can', limit: 3, limitLine: 'Limit 3 per order', priceEnds: '2027-01-31', priceEndsLine: "Home Depot's price ends Jan 31", returnsLine: "90-Day returns, per Home Depot's page",
    });
    expect(b.line).toMatch(/^Home Depot's page says it can be bought online \(read \d{1,2}:\d{2} [AP]M\)$/);
    // The allowance: the limit times the row's own estimate, labelled as an estimate.
    expect(b.limitProfitLine).toBe(`Up to 3 per order: about +$${Math.round(3 * row(VAC).profit!)} at this estimate (an estimate from your fee settings, not your real fees)`);
    expect(other).toEqual([]);
    live = false;
    await polling;
  }, SLOW);

  it('a page that says it cannot be bought takes the deal out of Buy now with the true sentence, once, in Activity and Telegram; a later page that says it can brings it back by itself', async () => {
    await ownersApp();
    stated.set(VAC_ID, { ...RECORDED, buyable: false });
    const { polling } = await connected();
    await readBuyNow();
    expect(buyNow()).toEqual(['homedepot:341965772', 'homedepot:341966856']);
    const said = agent.store.get('activity').runs.filter((r) => r.id.includes('-keep-')).map((r) => r.summary);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^PSK1212SB-PCL633B is no longer worth buying: Home Depot's page says it cannot be bought right now \(read \d{1,2}:\d{2} [AP]M\)\. Est\. profit /);
    expect(telegram).toEqual(said);
    expect(row(VAC)).toMatchObject({ buyNow: false });
    expect(row(VAC).signalNote).toMatch(/^Not worth buying now: Home Depot's page says it cannot be bought right now \(read /);
    expect(row(VAC).buying).toMatchObject({ state: 'cannot' });
    // Four hours later the page says it can be bought again: back in the state, with no new announcement (it was told on Nov 23).
    stated.set(VAC_ID, RECORDED);
    clock += 4 * 3_600_000 + 5 * HD_DRIP_GAP_MS;
    telegram.length = 0;
    for (let i = 0; i < 4; i += 1) {
      await agent.work.drip();
      clock += HD_DRIP_GAP_MS;
    }
    expect(buyNow()).toEqual([...BUY].sort());
    expect(row(VAC).signalNote).toMatch(/^Worth buying now/);
    expect(telegram.filter((t) => /PSK1212SB-PCL633B/.test(t))).toEqual([]);
    expect(other).toEqual([]);
    // Discontinued says so too (the sentence is the core test's); a page that states neither is not a reason.
    live = false;
    await polling;
  }, SLOW);
});

describe("the promotion's end", () => {
  const SOON = new Date(2027, 0, 29, 9).getTime();

  /** A Buy now deal whose page was read at `readAt`, as the re-read keeps it. */
  async function readAt(at: number, facts: BuyingFacts = RECORDED): Promise<void> {
    const b = (await agent.work.scanStore.getBundle(VAC))!;
    await agent.work.scanStore.putBundle({ ...b, buying: { ...facts, readAt: at }, seenAt: at });
    await agent.work.refresh();
  }

  it('one message, once per deal, labelled an estimate, with the link: not before the window, not for stale prices, not with alerts off', async () => {
    await ownersApp();
    await readAt(T0);
    expect(await agent.work.announcePriceEnds()).toBe(0);
    // Two days before the end, nothing was read since: its Home Depot and Amazon prices are older than the stated limit.
    clock = SOON;
    expect(staleBuyKeys({ deals: agent.store.get('deals'), tracking: agent.store.get('tracking') }, clock).has(VAC)).toBe(true);
    expect(await agent.work.announcePriceEnds()).toBe(0);
    // Every price of the three Buy now deals current: Home Depot's and Amazon's read a minute ago.
    const at = SOON - 60_000;
    for (const k of BUY) {
      const b = (await agent.work.scanStore.getBundle(k))!;
      await agent.work.scanStore.putBundle({ ...b, seenAt: at, ...(k === VAC ? { buying: { ...RECORDED, readAt: at } } : {}) });
    }
    for (const asin of Object.keys(FBA)) {
      const p = await agent.work.scanStore.getPrice(asin);
      if (p) await agent.work.scanStore.putPrice({ ...p, checkedAt: at, ...(p.seenAt !== null ? { seenAt: at } : {}) });
    }
    await agent.work.refresh();
    expect(buyNow()).toContain(VAC);
    // Alerts off: nothing is said, and nothing is marked said.
    agent.store.update('settings', (s) => ({ ...s, alerts: { ...s.alerts, enabled: false } }));
    expect(await agent.work.announcePriceEnds()).toBe(0);
    expect(agent.store.get('tracking').notified).not.toContain('homedepot:344305163|priceEnds|2027-01-31');
    agent.store.update('settings', (s) => ({ ...s, alerts: { ...s.alerts, enabled: true } }));
    expect(await agent.work.announcePriceEnds()).toBe(1);
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toMatch(/^PSK1212SB-PCL633B is worth buying now, and Home Depot's price of \$99\.00 ends Jan 31 \(in 2 days\): buy before then\. Est\. profit \$[\d.]+ \(an estimate from your fee settings, not your real fees\)\. https:\/\/www\.homedepot\.com\/p\//);
    // Once.
    expect(await agent.work.announcePriceEnds()).toBe(0);
    clock += 3_600_000;
    expect(await agent.work.announcePriceEnds()).toBe(0);
    expect(telegram).toHaveLength(1);
    expect(agent.store.get('tracking').notified).toContain('homedepot:344305163|priceEnds|2027-01-31');
  }, SLOW);

  it('after the end the deal\'s price is read first, and it is not announced as a buy until that read confirms the price', async () => {
    await ownersApp();
    const lastDay = new Date(2027, 0, 31, 12).getTime();
    await readAt(lastDay);
    const after = new Date(2027, 1, 1, 9).getTime();
    clock = after;
    // The price was last read on the last day, before the end of it: the row says it ended and the price has not been read since.
    const kept = keptNow({ deals: agent.store.get('deals'), tracking: agent.store.get('tracking') });
    expect(kept.find((d) => d.key === VAC)!.priceEndsAt).toBe(new Date(2027, 0, 31, 23, 59, 59, 999).getTime());
    expect(row(VAC).buying).toMatchObject({ priceEnded: true, priceEndsLine: "Home Depot's price ended Jan 31; it has not been read since" });
    expect(staleBuyKeys({ deals: agent.store.get('deals'), tracking: agent.store.get('tracking') }, clock).has(VAC)).toBe(true);
    // First in line, whatever the other deals' cadence.
    const out = await readOneDue(
      { store: agent.work.scanStore, now: () => clock, readPromoPages: async (ids) => ids.map((id) => ({ itemId: id, kind: 'read' as const, page: { itemId: id, brand: 'RYOBI', model: 'PSK1212SB-PCL633B', title: 't', price: 129, wasPrice: 183, bullets: [], description: null, promotions: [] } })) },
      keptNow({ deals: agent.store.get('deals'), tracking: agent.store.get('tracking') }), { day: '2027-02-01', pages: 0, tokens: 0, tried: {} },
    );
    expect(out!.deal.key).toBe(VAC);
    expect(out).toMatchObject({ checked: true, changed: true });
    expect((await agent.work.scanStore.getBundle(VAC))!.seenAt).toBe(clock);
    await agent.work.refresh();
    // The read confirmed the price (now $129): no longer "not read since".
    expect(staleBuyKeys({ deals: agent.store.get('deals'), tracking: agent.store.get('tracking') }, clock).has(VAC)).toBe(false);
    expect(row(VAC).buying!.priceEnded).toBe(false);
  }, SLOW);
});
