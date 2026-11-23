// "Paste a link, the price is found": POST /api/price-from-link and agent/priceFromLink.ts, on recorded eBay and Keepa
// responses (fixtures/), a fake fetch and a fake Chrome. No network, no key of any real account.

import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type Agent } from '../app';
import { MemoryCache } from '../../core/src/serpapi/client';
import { priceFromLink, type PriceFromLinkDeps } from '../priceFromLink';

const T0 = Date.UTC(2026, 10, 23, 12);
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, '../../fixtures', name), 'utf8')) as Record<string, unknown>;
const EBAY_ITEM = fixture('ebay/browse-item-237179711800-2026-11-19.json');
const EBAY_ITEM_BODY = (EBAY_ITEM.response ?? EBAY_ITEM) as Record<string, unknown>;
const KEEPA = fixture('keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json');

const APP_ID = 'app-id-secret-1234';
const CERT_ID = 'cert-id-secret-5678';
const KEEPA_KEY = 'keepa-key-secret-9999';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Fake {
  fetchFn: typeof fetch;
  calls: string[];
}
/** eBay's token and item calls and Keepa's product call, answered from the recordings (or from what the test says). */
function fake(over: { item?: () => Response; keepa?: () => Response } = {}): Fake {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.replace(KEEPA_KEY, '[key]'));
    if (url.includes('/identity/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 7200 });
    if (url.includes('get_item_by_legacy_id')) return over.item ? over.item() : json(EBAY_ITEM_BODY);
    if (url.includes('api.keepa.com/product')) return over.keepa ? over.keepa() : json(KEEPA);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

let server: Server;
let agent: Agent;
let base: string;
let dataDir: string;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'sf-link-'));
  agent = createAgent({ dataDir, port, timers: false, now: () => T0 });
  server.on('request', agent.handle);
});
afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const withKeys = (keys: { ebay?: boolean; keepa?: boolean }) =>
  agent.store.update('keys', (k) => ({ ...k, ...(keys.ebay ? { ebay: { appId: APP_ID, certId: CERT_ID } } : {}), ...(keys.keepa ? { keepa: KEEPA_KEY } : {}) }));

const deps = (f: Fake, over: Partial<PriceFromLinkDeps> = {}): PriceFromLinkDeps => ({
  store: agent.store, jobs: agent.jobs, dataDir, now: () => T0, fetchFn: f.fetchFn, helperConnected: () => true, cache: new MemoryCache(), timeoutMs: 400, ...over,
});

describe('an eBay link', () => {
  it('reads the price, the shipping, the condition and the title from the recorded listing', async () => {
    withKeys({ ebay: true });
    const f = fake();
    const r = await priceFromLink(deps(f), 'https://www.ebay.com/itm/RYOBI-18V-Drill/237179711800?hash=item3752abc&_trksid=p2332490');
    expect(r).toEqual({
      found: true, price: 38.5, currency: 'USD', title: 'RYOBI 18V 1/2 in. Drill/Driver (PCL206B) TOOL ONLY', condition: 'New', shipping: 0,
      source: 'eBay', url: 'https://www.ebay.com/itm/237179711800', readAt: new Date(T0).toISOString(),
    });
    expect(f.calls.some((c) => c.includes('legacy_item_id=237179711800'))).toBe(true);
    expect(f.calls.some((c) => c.includes('api.keepa.com') || c.includes('serpapi.com'))).toBe(false);
  });
  it('says so when the listing has ended, and never gives a price for it', async () => {
    withKeys({ ebay: true });
    const r = await priceFromLink(deps(fake({ item: () => json({ ...EBAY_ITEM_BODY, itemEndDate: new Date(T0 - 60_000).toISOString() }) })), 'https://www.ebay.com/itm/237179711800');
    expect(r).toEqual({ found: false, reason: 'This eBay listing has ended.' });
    const gone = await priceFromLink(deps(fake({ item: () => json({ errors: [{ errorId: 11001 }] }, 404) })), 'https://www.ebay.com/itm/237179711800');
    expect(gone).toMatchObject({ found: false, reason: 'eBay has no listing with that number. It may have ended.' });
  });
  it('refuses an auction bid and a price in another currency', async () => {
    withKeys({ ebay: true });
    const auction = await priceFromLink(deps(fake({ item: () => json({ ...EBAY_ITEM_BODY, buyingOptions: ['AUCTION'] }) })), 'https://www.ebay.com/itm/237179711800');
    expect(auction).toMatchObject({ found: false, reason: expect.stringContaining('auction') as string });
    const cad = await priceFromLink(deps(fake({ item: () => json({ ...EBAY_ITEM_BODY, price: { value: '52.00', currency: 'CAD' } }) })), 'https://www.ebay.com/itm/237179711800');
    expect(cad).toMatchObject({ found: false, reason: expect.stringContaining('priced in CAD') as string });
  });
  it('says shipping is not stated when the listing states none', async () => {
    withKeys({ ebay: true });
    const { shippingOptions: _s, ...noShipping } = EBAY_ITEM_BODY;
    const r = await priceFromLink(deps(fake({ item: () => json(noShipping) })), 'https://www.ebay.com/itm/237179711800');
    expect(r).toMatchObject({ found: true, price: 38.5, shipping: null });
  });
  it('asks for the eBay keys when there are none, and calls nothing', async () => {
    const f = fake();
    const r = await priceFromLink(deps(f), 'https://www.ebay.com/itm/237179711800');
    expect(r).toMatchObject({ found: false, reason: expect.stringContaining('Add your eBay keys in Settings') as string });
    expect(f.calls).toEqual([]);
  });
  it('carries no key in what it says when eBay is unreachable', async () => {
    withKeys({ ebay: true });
    const r = await priceFromLink(deps({ calls: [], fetchFn: (async () => { throw new Error(`down ${APP_ID} ${CERT_ID}`); }) as typeof fetch }), 'https://www.ebay.com/itm/237179711800');
    expect(r.found).toBe(false);
    expect(JSON.stringify(r)).not.toContain(APP_ID);
    expect(JSON.stringify(r)).not.toContain(CERT_ID);
  });
});

describe('an Amazon link', () => {
  it('reads the current New price from one Keepa product pull and labels where it is from', async () => {
    withKeys({ keepa: true });
    const f = fake();
    const r = await priceFromLink(deps(f), 'https://www.amazon.com/RYOBI-Impact-Driver/dp/B0BGYFTPGK/ref=sr_1_3?crid=Z&tag=x-20');
    expect(r).toMatchObject({
      found: true, price: 44.89, currency: 'USD', condition: 'New', source: 'Amazon (Keepa)', url: 'https://www.amazon.com/dp/B0BGYFTPGK',
      title: expect.stringContaining('RYOBI ONE+ 18V') as string, note: expect.stringContaining('lowest current New offer') as string,
    });
    expect(f.calls.filter((c) => c.includes('api.keepa.com/product'))).toHaveLength(1);
    expect(f.calls.some((c) => c.includes('amazon.com') && !c.includes('keepa'))).toBe(false);
    expect(readFileSync(join(dataDir, 'keepa-ledger.jsonl'), 'utf8')).toContain('price from a pasted link');
  });
  it('has no price to give when Keepa knows none, or does not know the product, or has no key', async () => {
    withKeys({ keepa: true });
    const f = fake();
    expect(await priceFromLink(deps(f), 'https://www.amazon.com/dp/B000000000')).toMatchObject({ found: false, reason: expect.stringContaining('does not know') as string });
    const none = { ...KEEPA, products: [{ ...(KEEPA.products as Record<string, unknown>[])[0], stats: { current: [-1, -1, -1, 5] } }] };
    expect(await priceFromLink(deps(fake({ keepa: () => json(none) })), 'https://www.amazon.com/dp/B0BGYFTPGK')).toMatchObject({ found: false, reason: expect.stringContaining('no New price') as string });
    agent.store.update('keys', (k) => ({ ...k, keepa: undefined }));
    const g = fake();
    expect(await priceFromLink(deps(g), 'https://www.amazon.com/dp/B0BGYFTPGK')).toMatchObject({ found: false, reason: expect.stringContaining('Add your Keepa key') as string });
    expect(g.calls).toEqual([]);
  });
  it('spends no token when the budget says the reserve would be broken', async () => {
    withKeys({ keepa: true });
    agent.store.update('runtime', (r) => ({ ...r, keepa: { tokensLeft: 3, refillIn: 1000, refillRate: 1, at: new Date(T0).toISOString() } }));
    const f = fake();
    expect(await priceFromLink(deps(f), 'https://www.amazon.com/dp/B0BGYFTPGK')).toMatchObject({ found: false, reason: expect.stringContaining('no tokens to spare') as string });
    expect(f.calls).toEqual([]);
  });
});

/** Answers the next worker job as the paired Chrome would. */
async function chromeAnswers(result: unknown, ok = true): Promise<void> {
  const job = await agent.jobs.next(1000);
  if (!job) throw new Error('no job was queued');
  agent.jobs.complete(ok ? { id: job.id, ok: true, result } : { id: job.id, ok: false, error: String(result) });
}
const PAGE = {
  itemId: '328690510', brand: 'DEWALT', model: 'DCF887B', title: 'DEWALT 20V MAX XR Brushless Cordless Impact Driver (Tool Only)', price: 99, wasPrice: null,
  bullets: [], description: null, promotions: [],
};

describe('a Home Depot link', () => {
  const link = 'https://www.homedepot.com/p/DEWALT-20V-MAX-Impact-Driver-DCF887B/328690510?mtc=x';
  it('reads the price from the page in his Chrome', async () => {
    const [r] = await Promise.all([priceFromLink(deps(fake()), link), chromeAnswers([{ itemId: '328690510', kind: 'read', page: PAGE }])]);
    expect(r).toMatchObject({ found: true, price: 99, currency: 'USD', source: 'Home Depot', title: PAGE.title, url: link });
    expect(agent.jobs.get(agent.store.get('jobs')[0]!.id)).toMatchObject({ kind: 'promoPage', input: { itemIds: ['328690510'] } });
  });
  it('says Chrome is closed when the helper is not connected or does not answer', async () => {
    expect(await priceFromLink(deps(fake(), { helperConnected: () => false }), link)).toEqual({ found: false, reason: 'Open Chrome and try again.' });
    expect(await priceFromLink(deps(fake(), { timeoutMs: 50 }), link)).toEqual({ found: false, reason: 'Open Chrome and try again.' });
  });
  it('gives no price for a page that shows none, and says when Home Depot refused', async () => {
    const [none] = await Promise.all([priceFromLink(deps(fake()), link), chromeAnswers([{ itemId: '328690510', kind: 'read', page: { ...PAGE, price: null } }])]);
    expect(none).toMatchObject({ found: false, reason: expect.stringContaining('no price') as string });
    const [refused] = await Promise.all([priceFromLink(deps(fake()), link), chromeAnswers([{ itemId: '328690510', kind: 'refused', status: 403 }])]);
    expect(refused).toMatchObject({ found: false, reason: expect.stringContaining('did not let the page open') as string });
  });
});

describe('POST /api/price-from-link', () => {
  const ui = (body: unknown) =>
    fetch(`${base}/api/price-from-link`, { method: 'POST', headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('does not read any other site, and calls nothing for it', async () => {
    const res = await ui({ url: 'https://www.facebook.com/marketplace/item/123456789012345' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false, reason: 'Split Finder cannot read this site. Type the price you see.' });
  });
  it('needs the owner’s token and a link', async () => {
    const anon = await fetch(`${base}/api/price-from-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.ebay.com/itm/237179711800' }) });
    expect(anon.status).toBe(401);
    expect((await ui({})).status).toBe(400);
    expect((await ui({ url: 'x'.repeat(3000) })).status).toBe(400);
  });
  it('says what a pasted eBay link has when there are no eBay keys', async () => {
    const res = await ui({ url: 'https://www.ebay.com/itm/237179711800' });
    expect(await res.json()).toMatchObject({ found: false });
  });
});
