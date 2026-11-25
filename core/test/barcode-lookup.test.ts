// Nov 25: a part's Amazon lookup asks Keepa by its Home Depot barcode first, as a way to FIND candidates, never as proof.
// The code's products go through the matcher and the listing ladder unchanged; a same-barcode product the ladder does not
// confirm stays unconfirmed, with the fact recorded for later measurement; nothing found by code falls back to the term
// search. A fake fetch over Keepa's two requests; no network.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { addLookupWay, lookupWaysSentence, NO_WAYS } from '../src/deals/lookupCopy';
import { TokenBudget } from '../src/keepa/budget';
import { KeepaClient } from '../src/keepa/client';
import { keepaPartLookup, keepaProductSearchResult } from '../src/keepa/fetchStep';
import { partBarcode } from '../src/scan/barcodeLookup';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { keepaLookupOne } from '../src/scan/runner';
import { knownModels } from '../src/scan/split';
import { DEFAULT_SCAN_SETTINGS, type PartPriceRecord } from '../src/scan/types';
import { gtinCheckDigit } from '../src/identifiers';

const KEY = 'test-keepa-key-secret';
// DCF850B's barcode as Home Depot's page states it (fixtures/homedepot-pages/identifiers-upc-316627328-2026-11-25.json).
const DCF850B = '885911758215';
const T = Date.UTC(2026, 10, 25, 12);

// The real record of B0DGLWKS9S (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json): Amazon's catalog says part
// number DWST08017, its title sells DWST60122-1. Given here the part's barcode in its upcList, as a wrong record can carry it.
const WRONG = (JSON.parse(readFileSync(new URL('../../fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json', import.meta.url), 'utf8')) as {
  product: Record<string, unknown>;
}).product;
const DWST08017 = '07617408017' + String(gtinCheckDigit('07617408017'));

interface Seen { path: string; params: URLSearchParams }
type Body = Record<string, unknown>;
const meta = (consumed: number) => ({ tokensLeft: 900, tokensConsumed: consumed, refillRate: 1, refillIn: 60000, processingTimeInMs: 4 });

function keepa(answers: { code?: (codes: string[]) => Body; search?: (term: string) => Body; asin?: (asins: string[]) => Body }) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    seen.push({ path: url.pathname, params: url.searchParams });
    let body: Body = meta(0);
    if (url.pathname === '/product' && url.searchParams.has('code')) body = answers.code?.((url.searchParams.get('code') ?? '').split(',')) ?? meta(1);
    else if (url.pathname === '/product') body = answers.asin?.((url.searchParams.get('asin') ?? '').split(',')) ?? meta(1);
    else if (url.pathname === '/search') body = answers.search?.(url.searchParams.get('term') ?? '') ?? { ...meta(10), products: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const budget = new TokenBudget({ reserve: 0, maxPerRun: 10_000 });
  const client = new KeepaClient({ apiKey: KEY, budget, fetchFn });
  return { seen, client, budget };
}

const dewalt = (asin: string, title: string, over: Body = {}): Body => ({
  asin, title, brand: 'DEWALT', manufacturer: 'DEWALT', partNumber: 'DCF850B', model: 'DCF850B', numberOfItems: 1, packageQuantity: 1,
  upcList: [DCF850B], stats: { current: [9900, 9400, -1, 800] }, ...over,
});

async function world(part: { brand: string; model: string; upc?: string }) {
  const store = new MemoryScanStore();
  if (part.upc) {
    const rec: PartPriceRecord = {
      key: `${part.brand}:${part.model}`, brand: part.brand, model: part.model, itemId: '316627328', matchedModel: part.model, price: 99, title: 't',
      link: 'https://www.homedepot.com/p/316627328', seenAt: T, checkedAt: T, upc: part.upc,
    };
    await store.putPartPrice(rec);
  }
  return store;
}

async function lookUp(store: MemoryScanStore, k: ReturnType<typeof keepa>, part: { brand: string; model: string }) {
  return keepaLookupOne({
    store, settings: DEFAULT_SCAN_SETTINGS, now: () => T, keepaBudget: k.budget, catalog: (await knownModels(store)).catalog, prefix: 'test',
    keepaLookup: (brand, model, label, ask) => keepaPartLookup(k.client, brand, model, label, ask),
    keepaProduct: (asin, label, maxAgeMs) => keepaProductSearchResult(k.client, asin, { label, maxAgeMs }),
  }, { kind: 'lookup', brand: part.brand, model: part.model });
}

describe('the lookup asks by barcode before any term search', () => {
  it('two products for one barcode: the ladder confirms the one it confirms, with the reason saying both; no search, no pull', async () => {
    const store = await world({ brand: 'DEWALT', model: 'DCF850B', upc: DCF850B });
    expect(await partBarcode(store, 'DEWALT', 'DCF850B')).toBe(DCF850B);
    const k = keepa({
      code: () => ({ ...meta(2), products: [
        dewalt('B0C1AAAAAA', 'DEWALT ATOMIC 20V MAX 1/4 in. Brushless Cordless Impact Driver, Tool Only (DCF850B)'),
        dewalt('B0C1BBBBBB', 'DEWALT DCF850B Impact Driver (Renewed)'),
      ] }),
    });
    const out = await lookUp(store, k, { brand: 'DEWALT', model: 'DCF850B' });
    // One request: by code. No term search, and no price pull (the code's products carry their price).
    expect(k.seen.map((s) => s.path)).toEqual(['/product']);
    expect(k.seen[0]!.params.get('code')).toBe(DCF850B);
    expect(out).toMatchObject({ status: 'matched', tokens: 2, verified: 1, way: { ...NO_WAYS, barcode: 1, barcodeTokens: 2 } });
    const m = (await store.getMatch('DEWALT:DCF850B'))!;
    expect(m).toMatchObject({ status: 'matched', asin: 'B0C1AAAAAA', grade: 'strong', verifiedBy: 'keepa_catalog' });
    expect(m.verifyEvidence).toBe(
      "Amazon's catalog lists brand DEWALT, part number DCF850B; same barcode as Home Depot's page (885911758215): https://www.amazon.com/dp/B0C1AAAAAA",
    );
    expect((await store.getPrice('B0C1AAAAAA'))?.price).toBe(99);
    // The record: both hold the barcode; one is confirmed, the renewed one is not, and says why.
    expect(m.barcodeLookup).toMatchObject({ code: DCF850B, at: T, via: 'code', codeTokens: 2, searchTokens: 0 });
    const [a, b] = m.barcodeLookup!.products;
    expect(a).toMatchObject({ asin: 'B0C1AAAAAA', sameBarcode: true, grade: 'probable', check: 'confirmed', confirmed: true });
    expect(b).toMatchObject({ asin: 'B0C1BBBBBB', sameBarcode: true, grade: 'reject', confirmed: false });
    expect(b!.note).toMatch(/^same barcode as Home Depot's page \(885911758215\); not confirmed because the matcher rejects its title \(renewed or used listing\)/);
  });

  it("a same-barcode product whose title names another model is not confirmed; the search runs after it", async () => {
    const store = await world({ brand: 'DEWALT', model: 'DWST08017', upc: DWST08017 });
    const k = keepa({ code: () => ({ ...meta(1), products: [{ ...WRONG, upcList: [DWST08017] }] }) });
    const out = await lookUp(store, k, { brand: 'DEWALT', model: 'DWST08017' });
    // The matcher keeps nothing the code found, so the term search ran (it found nothing either).
    expect(k.seen.map((s) => s.path)).toEqual(['/product', '/search']);
    expect(k.seen[1]!.params.get('term')).toBe('DEWALT DWST08017');
    expect(out).toMatchObject({ status: 'none', tokens: 11, way: { ...NO_WAYS, search: 1, codeMisses: 1, barcodeTokens: 1, searchTokens: 10 } });
    const m = (await store.getMatch('DEWALT:DWST08017'))!;
    expect(m).toMatchObject({ status: 'none', asin: null });
    expect(m.verifiedBy).toBeUndefined();
    const [p] = m.barcodeLookup!.products;
    expect(m.barcodeLookup!.via).toBe('search');
    expect(p).toMatchObject({ asin: 'B0DGLWKS9S', sameBarcode: true, grade: 'reject', confirmed: false });
    expect(p!.check).not.toBe('confirmed');
    expect(p!.note).toContain(`same barcode as Home Depot's page (${DWST08017}); not confirmed because`);
    expect(p!.note).toContain('DWST60122');
  });

  it('a same-barcode title match whose catalog fields do not confirm it stays a title match: the barcode alone confirms nothing', async () => {
    const store = await world({ brand: 'DEWALT', model: 'DCF850B', upc: DCF850B });
    const k = keepa({ code: () => ({ ...meta(1), products: [dewalt('B0C1DDDDDD', 'DEWALT DCF850B 20V MAX Impact Driver', { brand: null, partNumber: null, model: null, manufacturer: null })] }) });
    const out = await lookUp(store, k, { brand: 'DEWALT', model: 'DCF850B' });
    expect(out.status).toBe('matched');
    const m = (await store.getMatch('DEWALT:DCF850B'))!;
    expect(m).toMatchObject({ asin: 'B0C1DDDDDD', grade: 'probable' });
    expect(m.verifiedBy).toBeUndefined();
    expect(m.barcodeLookup!.products[0]).toMatchObject({ sameBarcode: true, confirmed: false, check: 'unknown' });
    expect(m.barcodeLookup!.products[0]!.note).toMatch(/^same barcode as Home Depot's page \(885911758215\); not confirmed because the ladder left it unknown: /);
  });

  it('nothing found by code: the term search as today, its candidates judged as always', async () => {
    const store = await world({ brand: 'DEWALT', model: 'DCF850B', upc: DCF850B });
    const k = keepa({
      code: () => meta(1),
      search: () => ({ ...meta(10), products: [{ asin: 'B0C1EEEEEE', title: 'DEWALT ATOMIC 20V MAX Impact Driver (DCF850B), Tool Only', brand: 'DEWALT' }] }),
      asin: (asins) => ({ ...meta(asins.length), products: asins.map((a) => dewalt(a, 'DEWALT ATOMIC 20V MAX Impact Driver (DCF850B), Tool Only', { upcList: undefined })) }),
    });
    const out = await lookUp(store, k, { brand: 'DEWALT', model: 'DCF850B' });
    // Code, then the term search, then the matched listing's price pull (search rows carry no price), as before.
    expect(k.seen.map((s) => s.path)).toEqual(['/product', '/search', '/product']);
    expect(k.seen[2]!.params.get('asin')).toBe('B0C1EEEEEE');
    expect(out).toMatchObject({ status: 'matched', way: { ...NO_WAYS, search: 1, codeMisses: 1, barcodeTokens: 1, searchTokens: 10 } });
    const m = (await store.getMatch('DEWALT:DCF850B'))!;
    expect(m).toMatchObject({ asin: 'B0C1EEEEEE', barcodeLookup: { via: 'search', products: [] } });
  });

  it('without a barcode: the term search alone, no code request', async () => {
    const store = await world({ brand: 'DEWALT', model: 'DCF850B' });
    const k = keepa({ search: () => ({ ...meta(10), products: [] }) });
    const out = await lookUp(store, k, { brand: 'DEWALT', model: 'DCF850B' });
    expect(k.seen.map((s) => s.path)).toEqual(['/search']);
    expect(out).toMatchObject({ status: 'none', tokens: 10, way: { ...NO_WAYS, search: 1, searchTokens: 10 } });
    expect((await store.getMatch('DEWALT:DCF850B'))?.barcodeLookup).toBeUndefined();
  });

  it('codeOnly stops after the code: a part already searched is never searched again by it', async () => {
    const k = keepa({ code: () => meta(1) });
    const r = await keepaPartLookup(k.client, 'DEWALT', 'DCF850B', 'test', { barcode: DCF850B, codeOnly: true });
    expect(k.seen.map((s) => s.path)).toEqual(['/product']);
    expect(r.barcode).toEqual({ code: DCF850B, via: 'code', products: [], codeTokens: 1, searchTokens: 0 });
  });
});

describe('the lookup words say what found the candidates and what each cost, as Keepa counted', () => {
  it('found by barcode, by search, and the tokens of each', () => {
    let w = addLookupWay(undefined, { source: 'network', keepaTokens: 2, barcode: { via: 'code', codeTokens: 2, searchTokens: 0 } });
    w = addLookupWay(w, { source: 'network', keepaTokens: 11, barcode: { via: 'search', codeTokens: 1, searchTokens: 10 } });
    w = addLookupWay(w, { source: 'network', keepaTokens: 10 });
    expect(lookupWaysSentence(w)).toBe('Keepa lookups: 1 found by barcode, 2 by search; Keepa counted 3 tokens for barcodes (1 found nothing) and 20 tokens for searches.');
    expect(lookupWaysSentence(addLookupWay(undefined, { source: 'network', keepaTokens: 10 }))).toBe('');
  });
});
