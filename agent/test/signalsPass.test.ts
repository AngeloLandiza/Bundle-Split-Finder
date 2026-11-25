// Signals round 2: the agent tells the owner a bundle is worth buying whenever its estimate or completeness changes, not
// only at the end of a scan: after the drip's lookups and price pulls, after an owner's action, and at start. Keepa here is a
// fake answering with the recorded responses (fixtures/keepa: the RYOBI PCL235B search, 10 tokens; the product pull with
// stats, 1 token an ASIN: B0BGYFTPGK at $44.89 lowest New, monthlySold 500, pick-and-pack $8.02). Fake clock. No network.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writePartTrend } from '../../core/src/keepa/trends';
import { bundleKey } from '../../core/src/scan/types';
import { validateSettings } from '../../core/src/settings';
import { createAgent, type Agent } from '../app';
import { FULFILLMENT_KEEPA_MIGRATION, Store } from '../store';
import { dealDetail, dealsResponse } from '../views';
import { DRIP_POLL_MS, extensionSettingsOf } from '../work';

const T0 = Date.UTC(2026, 10, 23, 15);
const SEARCH = JSON.parse(readFileSync('fixtures/keepa/search-RYOBI-PCL235B.json', 'utf8')) as Record<string, unknown>;
const PRODUCTS = JSON.parse(readFileSync('fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json', 'utf8')) as { products: { asin: string }[] } & Record<string, unknown>;
const BOT = '999:bot-secret-token';
const KEY = bundleKey('318621812');

let agent: Agent;
let dataDir: string;
let clock: number;
let tokens: number;
let calls: string[];
let telegram: string[];

function keepaBody(consumed: number, extra: Record<string, unknown> = {}): Response {
  tokens -= consumed;
  return new Response(JSON.stringify({ ...extra, tokensLeft: tokens, tokensConsumed: consumed, refillRate: 1, refillIn: 30_000, processingTimeInMs: 1, timestamp: clock }), { status: 200 });
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
  if (url.pathname === '/search') {
    const { tokensLeft: _l, tokensConsumed: _c, ...rest } = SEARCH;
    return keepaBody(10, url.searchParams.get('term') === 'RYOBI PCL235B' ? rest : { products: [] });
  }
  if (url.pathname === '/product') {
    const asins = (url.searchParams.get('asin') ?? '').split(',');
    return keepaBody(asins.length, { products: PRODUCTS.products.filter((p) => asins.includes(p.asin)) });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

function open(): Agent {
  const a = createAgent({ dataDir, port: 0, timers: false, fetchFn, now: () => clock });
  a.store.update('keys', (k) => ({ ...k, keepa: 'keepa-secret-key-1', telegram: { botToken: BOT, chatId: '42' } }));
  // The owner's numbers (Nov 23): $20, 20%, 50 sold a month.
  a.store.update('settings', (s) => ({ ...s, alerts: { ...s.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 } }));
  // The deal here is $9 for a $79 tool: a 235% ROI, which the sanity checks hold for a look (core/src/audit/sanity.ts). These
  // tests are about the signals, so the owner has said "This is right" about its estimate; the hold has its own tests below.
  a.store.update('tracking', (t) => ({ ...t, sanityCleared: [`bundle|${KEY}|too_good`] }));
  return a;
}

/** A RYOBI PCL235B bundle at $9 (was $79), resolved, its one part waiting for a lookup, as a scan leaves it. */
async function waitingPart(): Promise<void> {
  const store = agent.work.scanStore;
  await store.putBundle({
    key: KEY, retailer: 'homedepot', itemId: '318621812', title: 'RYOBI ONE+ 18V Impact Driver', brand: 'RYOBI', model: 'PCL235B',
    upc: null, price: 9, regularPrice: 79, percentOff: 89, link: null, seenAt: T0, split: { components: ['PCL235B'], status: 'resolved', notes: [] },
  });
  await store.putMatch({ key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', status: 'waiting', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: T0 });
  await agent.work.refresh();
}

beforeEach(() => {
  clock = T0;
  calls = [];
  telegram = [];
  dataDir = mkdtempSync(join(tmpdir(), 'sf-signals-'));
  agent = open();
});

afterEach(async () => {
  await agent.work.idle();
  agent.close();
});

describe('buy signals between scans', () => {
  it('a drip-produced estimate above the numbers, with sales data: buyNow, one digest line; judged again the same day, nothing repeats', async () => {
    tokens = 21;
    await waitingPart();
    // Not confirmed yet (waiting for its lookup): not watched, no signal, no message.
    // Signals round 3: judged all the same (the row shows the verdict), never a buy.
    expect(agent.store.get('tracking').signals[KEY]).toMatchObject({ buyNow: null, verdict: 'Not worth buying now: not confirmed yet: waiting for a part to be looked up.' });
    await agent.work.drip();
    expect(calls).toEqual(['/token', '/search RYOBI PCL235B', '/product B0BGYFTPGK']);

    // The price pull kept its trend: Keepa's monthlySold and FBA fee are stored for the part, between scans.
    const s = agent.store.get('tracking').signals[KEY]!;
    expect(s.options[0]!.velocity).toMatchObject({ status: 'pass', slowest: { model: 'PCL235B', monthlySold: 500 } });
    // $44.89 - 15% referral - Amazon's FBA fee $8.02 (Keepa) = $30.14 net; - $9 = $21.14, 235% ROI.
    expect(s.buyNow).toMatchObject({ kind: 'buyNow', numbers: { profit: 21.14, minProfit: 20, monthlySold: 500 } });
    // Its earlier points (waiting for the lookup) had no sales figure, so it is judged as first seen (core judgedBy).
    expect(s.verdict).toBe('Worth buying now: +$21.14 (234.9% ROI), sells about 500 a month, first seen with an estimate.');

    // One message: the drip's line and the buy line together.
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toBe(
      'Keepa lookups between scans gave 1 new estimate (from your fee settings, not your real fees).\n' +
        `1 deal worth buying now. Top: RYOBI PCL235B, est. profit $21.14 (235% ROI). ${s.buyNow!.reason} Estimates from your fee settings, before sales tax and inbound shipping.`,
    );

    // The row carries the verdict; the detail says what the fees rest on, and no separate FBA line (it is the estimate).
    const data = { deals: agent.store.get('deals'), review: agent.store.get('review'), runtime: agent.store.get('runtime'), settings: agent.store.get('settings'), tracking: agent.store.get('tracking') };
    expect(dealsResponse(data, { sort: 'profit' }, clock).rows.find((r) => r.id === KEY)).toMatchObject({ buyNow: true, signalNote: s.verdict });
    const detail = dealDetail(data, KEY)!;
    expect(detail.estimate!.basis).toBe("15% referral (at least $0.30); Amazon's FBA fee from Keepa for the 1 part ($8.02); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.");
    expect(detail.fbaEstimate).toBeNull();

    // Judged again the same day (an owner's action rebuilds the deals): nothing new is sent.
    clock += 60_000;
    await agent.work.refresh();
    expect(telegram).toHaveLength(1);
    expect(agent.store.get('tracking').signals[KEY]!.buyNow).not.toBeNull();
  });

  it('missing sales data: the verdict says the pull is queued, the drip pulls the listing (1 token), and the deal is judged again', async () => {
    tokens = 21;
    const store = agent.work.scanStore;
    // Matched by a SerpApi lookup before: priced, catalog-verified, but Keepa was never asked about its listing.
    await store.putBundle({
      key: KEY, retailer: 'homedepot', itemId: '318621812', title: 'RYOBI ONE+ 18V Impact Driver', brand: 'RYOBI', model: 'PCL235B',
      upc: null, price: 9, regularPrice: 79, percentOff: 89, link: null, seenAt: T0, split: { components: ['PCL235B'], status: 'resolved', notes: [] },
    });
    await store.putMatch({ key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', status: 'matched', asin: 'B0BGYFTPGK', grade: 'strong', alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
    await store.putPrice({ asin: 'B0BGYFTPGK', price: 44.89, reviews: null, seenAt: T0, checkedAt: T0 });
    await agent.work.refresh();
    const before = agent.store.get('tracking').signals[KEY]!;
    expect(before.buyNow).toBeNull();
    // Signals round 3: no Keepa fee either; one pull answers both, and the verdict says so once.
    expect(before.verdict).toBe('Not worth buying now: before fulfillment for 1 of 1 part — Keepa is asked next.');
    expect(telegram).toEqual([]);

    await agent.work.drip();
    expect(calls).toEqual(['/token', '/product B0BGYFTPGK']);
    expect(agent.store.get('activity').runs.at(-1)).toMatchObject({ kind: 'lookup', keepaTokensUsed: 1, summary: 'Read sales figures for 1 listing from Keepa.' });
    const after = agent.store.get('tracking').signals[KEY]!;
    expect(after.options[0]!.velocity.status).toBe('pass');
    // Keepa's FBA fee came with the pull: $29.16 at the flat $0 became $21.14, still above $20. The change it was first seen
    // with was never judged with sales data, so it is judged now.
    expect(after.verdict).toBe('Worth buying now: +$21.14 (234.9% ROI), sells about 500 a month, first seen with an estimate.');
    expect(after.buyNow).not.toBeNull();
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toMatch(/^1 deal worth buying now\. Top: RYOBI PCL235B, est\. profit \$21\.14 \(235% ROI\)\./);
    // Pulled once: the next round asks nothing.
    clock += DRIP_POLL_MS;
    await agent.work.drip();
    expect(calls.filter((c) => c.startsWith('/product'))).toHaveLength(1);
  });

  it('with the morning digest, the buy line waits for the morning; quiet work still runs', async () => {
    tokens = 21;
    agent.store.update('settings', (s) => ({ ...s, notifications: { ...s.notifications, digest: 'morning', morningAt: '07:00' } }));
    await waitingPart();
    await agent.work.drip();
    expect(agent.store.get('tracking').signals[KEY]!.buyNow).not.toBeNull();
    expect(telegram).toEqual([]);
  });

  it('at start: an estimate made after the last evaluation (the drip, before a restart) is judged and sent once', async () => {
    tokens = 21;
    await waitingPart();
    await agent.work.drip();
    // As the owner's app had it (Nov 23): an estimate the drip made, with no signal judged and nothing sent.
    // Nov 25: nothing sent means nothing announced either (tracking.announced, the event's record).
    agent.store.update('tracking', (t) => ({ ...t, signals: {}, notified: [], announced: {} }));
    agent.store.update('runtime', (r) => ({ ...r, notifiedDeals: [] }));
    await agent.work.idle();
    agent.close();
    telegram = [];
    agent = open();
    await vi.waitFor(() => expect(agent.store.get('tracking').signals[KEY]?.buyNow).toBeTruthy(), { timeout: 10_000 });
    await vi.waitFor(() => expect(telegram).toHaveLength(1), { timeout: 10_000 });
    expect(telegram[0]).toMatch(/^1 deal worth buying now\. Top: RYOBI PCL235B/);
    // Nothing was fetched at start.
    expect(calls).toEqual(['/token', '/search RYOBI PCL235B', '/product B0BGYFTPGK']);
  });
});

describe('fees for every part that counts (signals round 3)', () => {
  const DEAL_B = bundleKey('337440459');

  /** Two unwatched bundles with complete estimates (no discount), both parts verified and priced, Keepa never asked. */
  async function twoDeals(): Promise<void> {
    const store = agent.work.scanStore;
    for (const [itemId, brand, model, asin, price, amazon] of [
      ['318621812', 'RYOBI', 'PCL235B', 'B0BGYFTPGK', 9, 44.89],
      ['337440459', 'DEWALT', 'DCF921B', 'B09M3TL9BB', 120, 154.99],
    ] as const) {
      await store.putBundle({
        key: bundleKey(itemId), retailer: 'homedepot', itemId, title: `${brand} ${model}`, brand, model, upc: null, price, regularPrice: null, percentOff: null,
        link: null, seenAt: T0, split: { components: [model], status: 'resolved', notes: [] },
      });
      await store.putMatch({ key: `${brand}:${model}`, brand, model, status: 'matched', asin, grade: 'strong', alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
      await store.putPrice({ asin, price: amazon, reviews: null, seenAt: T0, checkedAt: T0 });
    }
    await agent.work.refresh();
  }

  const view = () => {
    const data = { deals: agent.store.get('deals'), review: agent.store.get('review'), runtime: agent.store.get('runtime'), settings: agent.store.get('settings'), tracking: agent.store.get('tracking') };
    return dealsResponse(data, { sort: 'profit' }, clock).rows;
  };

  it('unwatched deals get their Keepa fees, the highest estimate first, 1 token each above the reserve; the queue is shown; no pull again within the window', async () => {
    tokens = 6; // the reserve (5) and one pull
    await twoDeals();
    // Before any pull: both estimates are before fulfillment, labelled so, never a buy, whatever the margin.
    expect(view().map((r) => [r.bundle.model, r.profit, r.beforeFulfillment, r.buyNow ?? false, r.signalNote])).toEqual([
      ['PCL235B', 29.16, { parts: 1, of: 1 }, false, 'Not worth buying now: before fulfillment for 1 of 1 part — Keepa is asked next.'],
      ['DCF921B', 11.74, { parts: 1, of: 1 }, false, 'Not worth buying now: est. $11.74 is below your $20 and 10% ROI below your 20%; before fulfillment for 1 of 1 part — Keepa is asked next.'],
    ]);
    expect(agent.store.get('tracking').watch).toEqual({});

    await agent.work.drip();
    // PCL235B first (the higher estimate): its pull brings Amazon's FBA fee ($8.02) and its sales; DCF921B waits.
    expect(calls).toEqual(['/token', '/product B0BGYFTPGK']);
    expect(agent.work.state().drip).toMatchObject({ feesWaiting: 1 });
    const first = view().find((r) => r.id === KEY)!;
    expect(first).toMatchObject({ profit: 21.14, signalNote: 'Worth buying now: +$21.14 (234.9% ROI), sells about 500 a month, first seen with an estimate.' });
    expect(first.beforeFulfillment).toBeUndefined();
    // Unwatched: the verdict shows, but nothing is sent and the row is not a buy.
    expect(first.buyNow).toBe(false);
    expect(telegram).toEqual([]);

    tokens = 6;
    clock += DRIP_POLL_MS;
    await agent.work.drip();
    expect(calls.slice(2)).toEqual(['/token', '/product B09M3TL9BB']);
    expect(agent.work.state().drip?.feesWaiting).toBeUndefined();
    const b = view().find((r) => r.id === DEAL_B)!;
    // $154.99 - $23.25 (15%) - $7.60 (Keepa) = $124.14; - $120 = $4.14.
    expect(b).toMatchObject({ profit: 4.14, signalNote: 'Not worth buying now: est. $4.14 is below your $20 and 3% ROI below your 20%.' });

    // Pulled within the freshness window: not again.
    tokens = 50;
    clock += DRIP_POLL_MS;
    await agent.work.drip();
    expect(calls.filter((c) => c.startsWith('/product'))).toHaveLength(2);
  });

  it('Deals order: a full estimate before one that leaves a fee out, of the same sign', async () => {
    tokens = 6;
    await twoDeals();
    // Before any pull PCL235B ($29.16) leads; give DCF921B its fee and lower its price so it is fully fee'd but smaller.
    agent.store.update('settings', (st) => ({ ...st }));
    await agent.work.scanStore.putBundle({ ...(await agent.work.scanStore.getBundle(DEAL_B))!, price: 100 });
    tokens = 5;
    await agent.work.refresh();
    expect(view().map((r) => r.bundle.model)).toEqual(['DCF921B', 'PCL235B']);
    expect(view().map((r) => r.profit)).toEqual([31.74, 29.16]);
    // Neither is fee'd yet: plain order by estimate. Now DCF921B's fee comes (the highest first: DCF921B at $31.74).
    tokens = 6;
    await agent.work.drip();
    expect(calls).toEqual(['/token', '/product B09M3TL9BB']);
    // DCF921B, fully fee'd at $24.14, comes before PCL235B at $29.16 before fulfillment: both above zero.
    expect(view().map((r) => [r.bundle.model, r.profit, r.beforeFulfillment ?? null])).toEqual([
      ['DCF921B', 24.14, null],
      ['PCL235B', 29.16, { parts: 1, of: 1 }],
    ]);
  });
});

describe("the fulfillment fee's source (signals round 2)", () => {
  const stored = (fees: { fulfillmentFee: number }) => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-fees-'));
    const first = Store.open(dir);
    first.update('settings', (s) => {
      const { fulfillmentSource: _f, referralSource: _r, ...old } = s.settings.fees;
      return { ...s, settings: { ...s.settings, fees: { ...old, ...fees } } };
    });
    first.update('runtime', (r) => ({ ...r, migrations: (r.migrations ?? []).filter((m) => m !== FULFILLMENT_KEEPA_MIGRATION), migrationLog: [] }));
    first.close();
    return dir;
  };

  it("a new store takes Keepa's FBA fee and keeps the owner's referral rate", () => {
    const store = Store.open(mkdtempSync(join(tmpdir(), 'sf-fees-')));
    expect(store.get('settings').settings.fees).toMatchObject({ fulfillmentSource: 'keepa', referralSource: 'flat', referralRate: 0.15 });
    store.close();
  });

  it('a stored $0 flat fee moves to Keepa once, logged; the flat choice made afterwards is kept', () => {
    const dir = stored({ fulfillmentFee: 0 });
    const second = Store.open(dir);
    expect(second.get('settings').settings.fees).toMatchObject({ fulfillmentSource: 'keepa', referralSource: 'flat', fulfillmentFee: 0, referralRate: 0.15 });
    expect(second.get('runtime').migrationLog).toEqual([expect.objectContaining({ name: FULFILLMENT_KEEPA_MIGRATION, sentence: expect.stringMatching(/^Fulfillment fee: Amazon's FBA fee from Keepa now/) })]);
    second.update('settings', (s) => ({ ...s, settings: { ...s.settings, fees: { ...s.settings.fees, fulfillmentSource: 'flat' } } }));
    second.close();
    const third = Store.open(dir);
    expect(third.get('settings').settings.fees.fulfillmentSource).toBe('flat');
    expect(third.get('runtime').migrationLog).toHaveLength(1);
    third.close();
  });

  it('a flat fee the owner set stays flat, with nothing logged', () => {
    const second = Store.open(stored({ fulfillmentFee: 5.5 }));
    expect(second.get('settings').settings.fees).toMatchObject({ fulfillmentSource: 'flat', fulfillmentFee: 5.5 });
    expect(second.get('runtime').migrationLog ?? []).toEqual([]);
    second.close();
  });

  it('an unknown source is refused by the settings check', () => {
    const store = Store.open(mkdtempSync(join(tmpdir(), 'sf-fees-')));
    const ext = extensionSettingsOf(store.get('settings'));
    expect(validateSettings({ ...ext, fees: { ...ext.fees, fulfillmentSource: 'amazon' as never } }).fees).toBe("Choose Amazon's FBA fee from Keepa or a flat amount for fulfillment.");
    expect(validateSettings(ext).fees).toBeUndefined();
    store.close();
  });
});

describe('buy safety: a buy waits for its listings to be confirmed (Nov 23)', () => {
  /** PCL235B at $9 on a title match of `asin` ($44.89), its Keepa figures stored (500 sold a month, FBA fee $8.02). */
  async function titleMatched(asin: string): Promise<void> {
    const store = agent.work.scanStore;
    await store.putBundle({
      key: KEY, retailer: 'homedepot', itemId: '318621812', title: 'RYOBI ONE+ 18V Impact Driver', brand: 'RYOBI', model: 'PCL235B',
      upc: null, price: 9, regularPrice: 79, percentOff: 89, link: null, seenAt: T0, split: { components: ['PCL235B'], status: 'resolved', notes: [] },
    });
    await store.putMatch({ key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', status: 'matched', asin, grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
    await store.putPrice({ asin, price: 44.89, reviews: null, seenAt: T0, checkedAt: T0 });
    await writePartTrend(agent.work.cache, { asin, amazonPrice: 44.89, salesRank: 1000, offerCount: 5, pulledAt: T0, monthlySold: 500, fbaFee: 8.02 });
    await agent.work.refresh();
  }
  const rowOf = () => {
    const data = { deals: agent.store.get('deals'), review: agent.store.get('review'), runtime: agent.store.get('runtime'), settings: agent.store.get('settings'), tracking: agent.store.get('tracking') };
    return dealsResponse(data, { sort: 'profit' }, clock).rows.find((r) => r.id === KEY);
  };

  it('a title match above the numbers is held back, not announced; the drip checks it first; confirmed, it is a buy, sent once', async () => {
    tokens = 21;
    await titleMatched('B0BGYFTPGK');
    const held = agent.store.get('tracking').signals[KEY]!;
    expect(held.buyNow).toBeNull();
    expect(held.buyPending).toEqual({ optionId: 'whole', listings: 1, asins: ['B0BGYFTPGK'] });
    expect(held.verdict).toBe('Looks worth buying: +$21.14 (234.9% ROI), sells about 500 a month — 1 listing not confirmed yet.');
    expect(rowOf()).toMatchObject({ buyNow: false, buyPending: { listings: 1 } });
    expect(telegram).toEqual([]);

    await agent.work.drip();
    expect(calls).toEqual(['/token', '/product B0BGYFTPGK']);
    const s = agent.store.get('tracking').signals[KEY]!;
    expect(s.buyPending).toBeUndefined();
    expect(s.buyNow).toMatchObject({ kind: 'buyNow', numbers: { profit: 21.14 } });
    expect(s.verdict).toBe('Worth buying now: +$21.14 (234.9% ROI), sells about 500 a month, its listings confirmed now.');
    expect(rowOf()).toMatchObject({ buyNow: true });
    expect(rowOf()!.buyPending).toBeUndefined();
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toMatch(/^1 deal worth buying now\. Top: RYOBI PCL235B, est\. profit \$21\.14 \(235% ROI\)\. Its Amazon listings are confirmed now/);

    clock += 60_000;
    await agent.work.refresh();
    expect(telegram).toHaveLength(1);
  });

  it('a title match the catalog contradicts is removed: no estimate, no buy, nothing sent', async () => {
    tokens = 21;
    // B09M3TL9BB is DEWALT's DCF921B: Amazon's catalog contradicts it as RYOBI PCL235B.
    await titleMatched('B09M3TL9BB');
    expect(agent.store.get('tracking').signals[KEY]!.buyPending?.asins).toEqual(['B09M3TL9BB']);
    await agent.work.drip();
    expect(calls).toEqual(['/token', '/product B09M3TL9BB']);
    expect(await agent.work.scanStore.getMatch('RYOBI:PCL235B')).toMatchObject({ status: 'none', asin: null, rejectedAsins: ['B09M3TL9BB'] });
    const s = agent.store.get('tracking').signals[KEY]!;
    expect(s.buyNow).toBeNull();
    expect(s.buyPending).toBeUndefined();
    expect(telegram).toEqual([]);
  });
});

describe('checking the app\'s own work: a held deal is never Buy now until the owner looks', () => {
  /**
   * The case the first line lets through (found by npm run audit:sanity on the owner's data, Nov 24): Amazon's B0FD253MKS
   * "RYOBI 18V Cordless Hand Vacuums PCL700B & PCL702B (Tools Only)", two tools, counted for PCL700B alone. Built from
   * after-scan5's own records (scan/matches.json RYOBI:PCL700B, a title match the catalog could not settle; partPrices.json:
   * Home Depot sells PCL700B alone at $94, page 319962849) with the $299 the owner's deals counted for the listing. At 3.2
   * times Home Depot's price it is under the price guard's 4 (core/src/scan/priceGuard.ts), and no field confirmation is
   * involved, so only the second line sees it. The deal here is PCL700B on its own at Home Depot's price; Keepa's figures
   * are stored, so without the hold it would "look worth buying" (its listing not confirmed yet).
   */
  const HELD = bundleKey('319962849');
  const ASIN = 'B0FD253MKS';
  const LISTING = `listing|RYOBI:PCL700B|${ASIN}`;

  async function twoToolListing(): Promise<void> {
    const store = agent.work.scanStore;
    await store.putBundle({
      key: HELD, retailer: 'homedepot', itemId: '319962849', title: 'ONE+ 18V Cordless Hand Vacuum with Powered Brush (Tool Only)', brand: 'RYOBI', model: 'PCL700B',
      upc: null, price: 94, regularPrice: 94, percentOff: null, link: 'https://www.homedepot.com/p/319962849', seenAt: T0,
      split: { components: ['PCL700B'], status: 'resolved', notes: [] },
    });
    await store.putPartPrice({
      key: 'RYOBI:PCL700B', brand: 'RYOBI', model: 'PCL700B', itemId: '319962849', matchedModel: 'PCL700B', price: 94,
      title: 'ONE+ 18V Cordless Hand Vacuum with Powered Brush (Tool Only)', link: 'https://www.homedepot.com/p/319962849', seenAt: T0, checkedAt: T0,
    });
    await store.putListing({ asin: ASIN, brand: 'RYOBI', title: 'RYOBI 18V Cordless Hand Vacuums PCL700B & PCL702B (Tools Only)', models: ['PCL700B', 'PCL702B'], image: null, price: 299, reviews: null, seenAt: T0, checkedAt: T0 });
    await store.putPrice({ asin: ASIN, price: 299, reviews: null, seenAt: T0, checkedAt: T0 });
    await store.putMatch({
      key: 'RYOBI:PCL700B', brand: 'RYOBI', model: 'PCL700B', status: 'matched', asin: ASIN, grade: 'probable', alternatives: [], decidedBy: 'auto',
      updatedAt: T0, waitingSince: null,
      catalogChecks: [{ asin: ASIN, status: 'unknown', reason: "Amazon's catalog lists no part number that is PCL700B", at: T0, ladder: 2 }],
    });
    await writePartTrend(agent.work.cache, { asin: ASIN, amazonPrice: 299, salesRank: 1000, offerCount: 5, pulledAt: T0, monthlySold: 500, fbaFee: 8.02 });
    await agent.work.refresh();
  }
  const view = (key = HELD) => {
    const data = { deals: agent.store.get('deals'), review: agent.store.get('review'), runtime: agent.store.get('runtime'), settings: agent.store.get('settings'), tracking: agent.store.get('tracking') };
    return { row: dealsResponse(data, { sort: 'profit' }, clock).rows.find((r) => r.id === key)!, detail: dealDetail(data, key)! };
  };

  it('the first line lets it through; the second holds it on three checks: Needs a look with the links, no buy, nothing sent', async () => {
    await twoToolListing();
    // Through the first line: still the counted listing, an estimate on it.
    expect(await agent.work.scanStore.getMatch('RYOBI:PCL700B')).toMatchObject({ status: 'matched', asin: ASIN });
    const { row: r, detail } = view();
    expect(r.profit).toBeGreaterThan(100);
    expect(r.buyNow).toBe(false);
    expect(r.needsLook).toMatchObject({
      kind: 'title_extra_model', part: 'PCL700B', asin: ASIN, clearKey: LISTING,
      sentence: 'The Amazon listing counted for PCL700B also names PCL702B: "RYOBI 18V Cordless Hand Vacuums PCL700B & PCL702B (Tools Only)". It may sell more than the part.',
    });
    expect(r.needsLook!.links.map((l) => l.url)).toEqual(['https://www.homedepot.com/p/319962849', 'https://www.homedepot.com/p/319962849', `https://www.amazon.com/dp/${ASIN}`]);
    expect(detail.needsLook!.map((f) => f.kind)).toEqual(['title_extra_model', 'price_vs_home_depot', 'too_good']);
    expect(detail.needsLook![1]!.sentence).toBe("Amazon's $299.00 for PCL700B is 3.18 times Home Depot's $94.00 for it sold alone.");
    const s = agent.store.get('tracking').signals[HELD]!;
    expect(s.buyNow).toBeNull();
    // Without the hold it would read "Looks worth buying" (its listing not confirmed yet); held, it never does.
    expect(s.verdict).toMatch(/^Not worth buying now: needs a look: The Amazon listing counted for PCL700B also names PCL702B/);
    expect(telegram).toEqual([]);
  });

  it('"This is right" on each finding is remembered; with nothing left to look at, the deal is judged as any other', async () => {
    await twoToolListing();
    await agent.work.settleNeedsLook(HELD, LISTING, 'right');
    expect(view().row.needsLook).toMatchObject({ kind: 'too_good' });
    await agent.work.settleNeedsLook(HELD, `bundle|${HELD}|too_good`, 'right');
    expect(view().row.needsLook).toBeUndefined();
    expect(agent.store.get('tracking').sanityCleared).toEqual([`bundle|${KEY}|too_good`, LISTING, `bundle|${HELD}|too_good`]);
    // Judged as any other: a title match not confirmed yet, so "looks worth buying", never announced.
    expect(agent.store.get('tracking').signals[HELD]!.verdict).toMatch(/^Looks worth buying: .* — 1 listing not confirmed yet\.$/);
    await agent.work.refresh();
    expect(agent.store.get('deals').sanity!.filter((f) => f.bundleId === HELD)).toEqual([]);
    await expect(agent.work.settleNeedsLook(HELD, `bundle|${HELD}|too_good`, 'right')).rejects.toThrow('already settled');
  });

  it('"Wrong listing" withdraws the match: no listing, never chosen again for the part, the findings go with it', async () => {
    await twoToolListing();
    await expect(agent.work.settleNeedsLook(HELD, `bundle|${HELD}|too_good`, 'wrong')).rejects.toThrow('about the estimate');
    await agent.work.settleNeedsLook(HELD, LISTING, 'wrong');
    // Nov 25: the app replaces it itself (core/src/scan/recheck.ts). PCL700B has no other stored listing here, so it joins the
    // lookup queue for a fresh search instead of being asked.
    expect(await agent.work.scanStore.getMatch('RYOBI:PCL700B')).toMatchObject({ status: 'waiting', asin: null, rejectedAsins: [ASIN] });
    expect(await agent.work.scanStore.getRecheck!('RYOBI:PCL700B')).toMatchObject({ stage: 'lookup', withdrawn: [expect.objectContaining({ asin: ASIN, by: 'owner' })] });
    expect(view().row.needsLook).toBeUndefined();
    expect(view().row.profit).toBeNull();
  });

  it('the layering: the Nov 24 example (B0DGLWKS9S for DWST08017, 9.7 times Home Depot) is refused by the first line and never reaches the audit', async () => {
    // fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json on one part: the $39.99 adaptor plate, a $389 backpack
    // confirmed by Amazon's wrong catalog part number.
    const store = agent.work.scanStore;
    const NOV24 = bundleKey('322961591');
    const asin = 'B0DGLWKS9S';
    await store.putBundle({
      key: NOV24, retailer: 'homedepot', itemId: '322961591', title: 'Adaptor Plate for TOUGHSYSTEM 2.0', brand: 'DEWALT', model: 'DWST08017',
      upc: null, price: 39.99, regularPrice: 39.99, percentOff: null, link: 'https://www.homedepot.com/p/322961591', seenAt: T0,
      split: { components: ['DWST08017'], status: 'resolved', notes: [] },
    });
    await store.putPartPrice({
      key: 'DEWALT:DWST08017', brand: 'DEWALT', model: 'DWST08017', itemId: '322961591', matchedModel: 'DWST08017', price: 39.99,
      title: 'Adaptor Plate for TOUGHSYSTEM 2.0', link: 'https://www.homedepot.com/p/322961591', seenAt: T0, checkedAt: T0,
    });
    await store.putListing({ asin, brand: 'DEWALT', title: 'DWST60122-1 Dewalt Pro Backpack x McLaren F1 Team, Limited Edition', models: [], image: null, price: 389, reviews: null, seenAt: T0, checkedAt: T0 });
    await store.putPrice({ asin, price: 389, reviews: null, seenAt: T0, checkedAt: T0 });
    await store.putMatch({
      key: 'DEWALT:DWST08017', brand: 'DEWALT', model: 'DWST08017', status: 'matched', asin, grade: 'strong', alternatives: [], decidedBy: 'auto',
      updatedAt: T0, waitingSince: null, source: 'page', verifiedBy: 'keepa_catalog',
      verifyEvidence: `Amazon's catalog lists brand DEWALT, part number DWST08017: https://www.amazon.com/dp/${asin}`,
    });
    await agent.work.refresh();
    // The first line (the price guard, before the agent publishes) withdrew it: no listing counted. Nov 25: the app tries the
    // part's other listings before asking (core/src/scan/recheck.ts); with none stored here it joins the lookup queue.
    expect(await store.getMatch('DEWALT:DWST08017')).toMatchObject({ status: 'waiting', asin: null });
    expect(await store.getRecheck!('DEWALT:DWST08017')).toMatchObject({ stage: 'lookup', withdrawn: [expect.objectContaining({ asin, by: 'price_guard' })] });
    expect((await store.getReview('match:DEWALT:DWST08017'))?.answer).toBe('resolved by a later scan');
    // So the second line has nothing to hold: no finding, no estimate, no buy.
    expect(agent.store.get('deals').sanity!.filter((f) => f.bundleId === NOV24)).toEqual([]);
    expect(view(NOV24).row).toMatchObject({ profit: null, buyNow: false });
    expect(view(NOV24).row.needsLook).toBeUndefined();
  });
});
