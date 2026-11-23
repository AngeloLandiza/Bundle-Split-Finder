// Signals round 2: the agent tells the owner a bundle is worth buying whenever its estimate or completeness changes, not
// only at the end of a scan: after the drip's lookups and price pulls, after an owner's action, and at start. Keepa here is a
// fake answering with the recorded responses (fixtures/keepa: the RYOBI PCL235B search, 10 tokens; the product pull with
// stats, 1 token an ASIN: B0BGYFTPGK at $44.89 lowest New, monthlySold 500, pick-and-pack $8.02). Fake clock. No network.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(agent.store.get('tracking').signals[KEY]).toBeUndefined();
    await agent.work.drip();
    expect(calls).toEqual(['/token', '/search RYOBI PCL235B', '/product B0BGYFTPGK']);

    // The price pull kept its trend: Keepa's monthlySold and FBA fee are stored for the part, between scans.
    const s = agent.store.get('tracking').signals[KEY]!;
    expect(s.options[0]!.velocity).toMatchObject({ status: 'pass', slowest: { model: 'PCL235B', monthlySold: 500 } });
    // $44.89 - 15% referral - Amazon's FBA fee $8.02 (Keepa) = $30.14 net; - $9 = $21.14, 235% ROI.
    expect(s.buyNow).toMatchObject({ kind: 'buyNow', numbers: { profit: 21.14, minProfit: 20, monthlySold: 500 } });
    // Its earlier points (waiting for the lookup) had no sales figure, so it is judged as first seen (core judgedBy).
    expect(s.verdict).toBe('Worth buying now: est. profit $21.14 (235% ROI), sells about 500 a month, first seen with an estimate.');

    // One message: the drip's line and the buy line together.
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toBe(
      'Keepa lookups between scans gave 1 new estimate (from your fee settings, not your real fees).\n' +
        `1 deal worth buying now. Top: RYOBI PCL235B, est. profit $21.14 (235% ROI). ${s.buyNow!.reason} Estimates from your fee settings.`,
    );

    // The row carries the verdict; the detail says what the fees rest on, and no separate FBA line (it is the estimate).
    const data = { deals: agent.store.get('deals'), review: agent.store.get('review'), runtime: agent.store.get('runtime'), settings: agent.store.get('settings'), tracking: agent.store.get('tracking') };
    expect(dealsResponse(data, { sort: 'profit' }, clock).rows.find((r) => r.id === KEY)).toMatchObject({ buyNow: true, signalNote: s.verdict });
    const detail = dealDetail(data, KEY)!;
    expect(detail.estimate!.basis).toBe("15% referral (at least $0.30); Amazon's FBA fee from Keepa for 1 of 1 part ($8.02); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.");
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
    expect(before.verdict).toBe('Not worth buying now: no sales data for PCL235B yet — Keepa is asked on the next lookup.');
    expect(telegram).toEqual([]);

    await agent.work.drip();
    expect(calls).toEqual(['/token', '/product B0BGYFTPGK']);
    expect(agent.store.get('activity').runs.at(-1)).toMatchObject({ kind: 'lookup', keepaTokensUsed: 1, summary: 'Read sales figures for 1 listing from Keepa.' });
    const after = agent.store.get('tracking').signals[KEY]!;
    expect(after.options[0]!.velocity.status).toBe('pass');
    // Keepa's FBA fee came with the pull: $29.16 at the flat $0 became $21.14, still above $20. The change it was first seen
    // with was never judged with sales data, so it is judged now.
    expect(after.verdict).toBe('Worth buying now: est. profit $21.14 (235% ROI), sells about 500 a month, first seen with an estimate.');
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
    agent.store.update('tracking', (t) => ({ ...t, signals: {}, notified: [] }));
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
