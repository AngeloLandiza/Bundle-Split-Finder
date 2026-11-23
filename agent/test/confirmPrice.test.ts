// D3: the app confirms a part's sell price through the agent (POST and DELETE /api/deals/:id/parts/:part/price). The price
// is applied by the same core records and report the extension uses; the agent never makes up a figure.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type Agent } from '../app';
import type { DealDetail } from '../../core/src/api/contract';
import { bundleKey, partKey, type BundleRecord, type EbayValueRecord, type MatchRecord } from '../../core/src/scan/types';

const T0 = Date.UTC(2026, 10, 20, 12);
const KEY = bundleKey('1');
const EBAY_1 = 'https://www.ebay.com/itm/111';
const EBAY_2 = 'https://www.ebay.com/itm/222';

let server: Server;
let agent: Agent;
let base: string;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-confirm-')), port, timers: false });
  server.on('request', agent.handle);
  await seed();
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const bundle: BundleRecord = {
  key: KEY, retailer: 'homedepot', itemId: '1', title: 'RYOBI kit', brand: 'RYOBI', model: 'KIT', upc: null, price: 100, regularPrice: null, percentOff: null,
  link: null, seenAt: T0, split: { components: ['A', 'B', 'C', 'D'], status: 'resolved', notes: [] },
};
const match = (model: string, over: Partial<MatchRecord> = {}): MatchRecord => ({
  key: partKey('RYOBI', model), brand: 'RYOBI', model, status: 'none', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null, ...over,
});
const ebayValue: EbayValueRecord = {
  key: partKey('RYOBI', 'A'), brand: 'RYOBI', model: 'A', listings: [], notJudged: 0, complete: true, checkedAt: T0,
  value: { listings: 2, unitsSold: 5, low: 60, high: 75, medianPrice: 70, links: [EBAY_1, EBAY_2], linkPrices: [60, 75] },
};

/** A: no listing, with two stored eBay listings. B: for sale on Amazon at $50. C: still in Review. D: Amazon listing not for sale. */
async function seed(): Promise<void> {
  const s = agent.work.scanStore;
  await s.putBundle(bundle);
  await s.putMatch(match('A'));
  await s.putMatch(match('B', { status: 'matched', asin: 'B000000001', grade: 'exact' }));
  await s.putPrice({ asin: 'B000000001', price: 50, reviews: null, seenAt: T0, checkedAt: T0 });
  await s.putMatch(match('C', { status: 'review' }));
  await s.putMatch(match('D', { status: 'matched', asin: 'B000000004', grade: 'exact' }));
  await s.putPrice({ asin: 'B000000004', price: 40, reviews: null, seenAt: T0, checkedAt: T0 + 1 });
  await s.putEbayValue(ebayValue);
  await agent.work.refresh();
}

function ui(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}
const post = (part: string, body: unknown, deal = KEY) => ui(`/api/deals/${encodeURIComponent(deal)}/parts/${encodeURIComponent(part)}/price`, { method: 'POST', body: JSON.stringify(body) });
const remove = (part: string, deal = KEY) => ui(`/api/deals/${encodeURIComponent(deal)}/parts/${encodeURIComponent(part)}/price`, { method: 'DELETE' });
const detail = async (): Promise<DealDetail> => (await (await ui(`/api/deals/${encodeURIComponent(KEY)}`)).json()) as DealDetail;
const message = async (res: Response): Promise<string> => ((await res.json()) as { error: { message: string } }).error.message;

describe('POST /api/deals/:id/parts/:part/price', () => {
  it('counts a stored eBay listing at its own price, and the deal estimate follows', async () => {
    // Nov 23: C (in Review) and D (inactive) have no price, so the deal has no estimate; what its priced parts bring follows.
    const before = (await detail()).bundle.incomplete!.pricedNet;
    const res = await post('A', { kind: 'ebay-listing', url: EBAY_2 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { confirmed: { price: number; link: string } }).confirmed).toMatchObject({ price: 75, link: EBAY_2, note: null });
    const d = await detail();
    const a = d.bundle.parts.find((p) => p.model === 'A')!;
    expect(a.price).toBe(75);
    expect(a.prices.find((o) => o.kind === 'confirmed')).toMatchObject({ price: 75, link: EBAY_2, reference: false });
    expect(d.row.profit).toBeNull();
    expect(d.bundle.incomplete!.pricedNet).toBeGreaterThan(before);
    expect((await agent.work.scanStore.listConfirmedPrices()).map((c) => c.key)).toEqual(['RYOBI:A']);
  });

  it('refuses an eBay listing that is not stored for the part, and a price that is not the listing’s', async () => {
    const other = await post('A', { kind: 'ebay-listing', url: 'https://www.ebay.com/itm/999' });
    expect(other.status).toBe(400);
    expect(await message(other)).toBe('That is not one of this part’s stored eBay listings.');
    const priced = await post('A', { kind: 'ebay-listing', url: EBAY_1, price: 99 });
    expect(priced.status).toBe(400);
    expect(await message(priced)).toBe('That price is not the one on the eBay listing.');
    expect((await post('A', { kind: 'ebay-listing', url: EBAY_1, price: 60 })).status).toBe(200);
    expect((await post('B', { kind: 'ebay-listing', url: EBAY_1 })).status).toBe(409);
  });

  it('keeps a typed price with a Facebook link and a note', async () => {
    const res = await post('A', { kind: 'typed', price: 64.5, url: 'https://www.facebook.com/marketplace/item/1', note: ' Pickup in Oak Park ' });
    expect(res.status).toBe(200);
    const stored = (await agent.work.scanStore.listConfirmedPrices())[0]!;
    expect(stored).toMatchObject({ price: 64.5, link: 'https://www.facebook.com/marketplace/item/1', note: 'Pickup in Oak Park' });
    const option = (await detail()).bundle.parts.find((p) => p.model === 'A')!.prices.find((o) => o.kind === 'confirmed')!;
    expect(option.note).toBe('Pickup in Oak Park');
  });

  it('refuses a typed price without a link, a price at or below $0, a link that is not a web page, and a bad kind', async () => {
    expect(await message(await post('A', { kind: 'typed', price: 50 }))).toBe('Enter a link to the listing.');
    expect(await message(await post('A', { kind: 'typed', price: 0, url: EBAY_1 }))).toBe('Enter a price above $0.');
    expect(await message(await post('A', { kind: 'typed', price: 5, url: 'javascript:alert(1)' }))).toBe('Enter a link that starts with http or https.');
    expect(await message(await post('A', { kind: 'typed', price: 5, url: EBAY_1, note: 'x'.repeat(201) }))).toBe('That note is too long to store.');
    expect((await post('A', { kind: 'guess', price: 5, url: EBAY_1 })).status).toBe(400);
    expect(await agent.work.scanStore.listConfirmedPrices()).toEqual([]);
  });

  it('shows no form for a part in Review, and none while an Amazon price counts', async () => {
    const review = await post('C', { kind: 'typed', price: 30, url: EBAY_1 });
    expect(review.status).toBe(409);
    expect(await message(review)).toMatch(/^Answer its question first/);
    expect((await post('B', { kind: 'typed', price: 30, url: EBAY_1 })).status).toBe(409);
    expect(await agent.work.scanStore.listConfirmedPrices()).toEqual([]);
  });

  it('counts a confirmed price while the Amazon listing is not for sale', async () => {
    const res = await post('D', { kind: 'typed', price: 70, url: 'https://www.ebay.com/itm/4' });
    expect(res.status).toBe(200);
    const d = (await detail()).bundle.parts.find((p) => p.model === 'D')!;
    expect(d).toMatchObject({ availability: 'inactive', price: 70 });
  });

  it('answers 404 for a deal or a part that is not there', async () => {
    expect((await post('A', { kind: 'typed', price: 5, url: EBAY_1 }, 'nope')).status).toBe(404);
    expect((await post('Z', { kind: 'typed', price: 5, url: EBAY_1 })).status).toBe(404);
  });

  it('is for the app only', async () => {
    const res = await fetch(`${base}/api/deals/${encodeURIComponent(KEY)}/parts/A/price`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/deals/:id/parts/:part/price', () => {
  it('removes the price, and the part counts at $0 again', async () => {
    await post('A', { kind: 'typed', price: 64.5, url: EBAY_1 });
    const res = await remove('A');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { confirmed: null }).confirmed).toBeNull();
    const a = (await detail()).bundle.parts.find((p) => p.model === 'A')!;
    expect(a.price).toBeNull();
    expect(a.prices.some((o) => o.kind === 'confirmed')).toBe(false);
    expect(await agent.work.scanStore.listConfirmedPrices()).toEqual([]);
  });

  it('says so when there is nothing to remove', async () => {
    const res = await remove('A');
    expect(res.status).toBe(404);
    expect(await message(res)).toBe('This part has no confirmed price.');
  });
});
