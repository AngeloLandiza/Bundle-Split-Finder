// Nov 25: a part marked "no Amazon listing" gets one barcode lookup between scans once its Home Depot barcode is known:
// Keepa by code only (never a term search, never SerpApi), its products judged by the same matcher and ladder. The code
// answer is the recorded stats pull of B0BGYFTPGK (fixtures/keepa/product-…-stats.json), whose catalog lists the barcode
// 00033287199938 (gtinList); the part's barcode is given as that one. A fake Keepa and a fake clock; no network.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { barcodeLookupsWanted } from '../../core/src/scan/runner';
import { bundleKey } from '../../core/src/scan/types';
import { createAgent, type Agent } from '../app';

const T0 = Date.UTC(2026, 10, 25, 15);
const PRODUCTS = JSON.parse(readFileSync('fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json', 'utf8')) as { products: { asin: string }[] };
const PCL235B = '033287199938';
const KEY = 'keepa-secret-key-1';

let agent: Agent;
let tokens: number;
let calls: string[];
let codeAnswer: (codes: string[]) => Record<string, unknown>;

const body = (consumed: number, extra: Record<string, unknown> = {}): Response => {
  tokens -= consumed;
  return new Response(JSON.stringify({ ...extra, tokensLeft: tokens, tokensConsumed: consumed, refillRate: 1, refillIn: 30_000, processingTimeInMs: 1 }), { status: 200 });
};

const fetchFn = (async (input: string | URL | Request) => {
  const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
  if (url.hostname !== 'api.keepa.com') {
    calls.push(`other ${url.hostname}`);
    return new Response('{}', { status: 500 });
  }
  const code = url.searchParams.get('code');
  calls.push(`${url.pathname} ${code !== null ? `code=${code}` : url.searchParams.get('term') ?? url.searchParams.get('asin') ?? ''}`.trim());
  if (url.pathname === '/token') return body(0);
  if (url.pathname === '/product' && code !== null) return body(1, codeAnswer(code.split(',')));
  return body(10, { products: [] });
}) as typeof fetch;

async function noListingPart(): Promise<void> {
  const store = agent.work.scanStore;
  await store.putBundle({
    key: bundleKey('318621812'), retailer: 'homedepot', itemId: '318621812', title: 'RYOBI ONE+ 18V Impact Driver Kit', brand: 'RYOBI', model: 'PCL235B',
    upc: null, price: 39, regularPrice: 79, percentOff: 50, link: null, seenAt: T0, split: { components: ['PCL235B'], status: 'resolved', notes: [] },
  });
  await store.putMatch({ key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', status: 'none', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
  // Home Depot's page of the part sold alone, read with its barcode.
  await store.putPartPrice({
    key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', itemId: '318621812', matchedModel: 'PCL235B', price: 59, title: 'Impact Driver',
    link: 'https://www.homedepot.com/p/318621812', seenAt: T0, checkedAt: T0, upc: PCL235B,
  });
  await agent.work.refresh();
}

beforeEach(() => {
  tokens = 40;
  calls = [];
  codeAnswer = () => ({ products: PRODUCTS.products.filter((p) => p.asin === 'B0BGYFTPGK') });
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-drip-code-')), port: 0, timers: false, fetchFn, now: () => T0 });
  agent.store.update('keys', (k) => ({ ...k, keepa: KEY }));
});

afterEach(async () => {
  await agent.work.idle();
  agent.close();
});

describe('the drip asks Keepa by barcode for a part with no listing', () => {
  it('one code request, no search: the listing found, confirmed by the ladder with the reason saying both, counted in Activity', async () => {
    await noListingPart();
    expect(await barcodeLookupsWanted(agent.work.scanStore)).toEqual([{ key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', code: PCL235B }]);
    await agent.work.drip();
    expect(calls).toEqual(['/token', `/product code=${PCL235B}`]);
    const m = await agent.work.scanStore.getMatch('RYOBI:PCL235B');
    expect(m).toMatchObject({ status: 'matched', asin: 'B0BGYFTPGK', grade: 'strong', verifiedBy: 'keepa_catalog' });
    expect(m!.verifyEvidence).toContain(`same barcode as Home Depot's page (${PCL235B})`);
    expect(m!.barcodeLookup).toMatchObject({ code: PCL235B, via: 'code', codeTokens: 1, products: [{ asin: 'B0BGYFTPGK', sameBarcode: true, confirmed: true }] });
    const run = agent.store.get('activity').runs.at(-1)!;
    expect(run.summary).toContain('Looked up 1 part with Keepa: 1 matched.');
    expect(run.summary).toContain('Keepa lookups: 1 found by barcode, 0 by search; Keepa counted 1 token for barcodes and 0 tokens for searches.');
    // The first code answer is kept as a bounded sample, its cost learned; never the key.
    const runtime = agent.store.get('runtime');
    expect(runtime.keepaCodeCost).toMatchObject({ requests: 1, codes: 1, tokens: 1 });
    expect(runtime.keepaCodeSamples?.[0]).toMatchObject({ codes: [PCL235B], productCount: 1 });
    expect(JSON.stringify(runtime)).not.toContain(KEY);
  });

  it('nothing found by code: the part keeps "no listing", the fact is recorded, and it is not asked again', async () => {
    codeAnswer = () => ({});
    await noListingPart();
    await agent.work.drip();
    expect(calls).toEqual(['/token', `/product code=${PCL235B}`]);
    const m = await agent.work.scanStore.getMatch('RYOBI:PCL235B');
    expect(m).toMatchObject({ status: 'none', asin: null, barcodeLookup: { code: PCL235B, via: 'code', products: [] } });
    expect(await barcodeLookupsWanted(agent.work.scanStore)).toEqual([]);
    calls = [];
    await agent.work.drip();
    expect(calls).toEqual([]);
  });
});
