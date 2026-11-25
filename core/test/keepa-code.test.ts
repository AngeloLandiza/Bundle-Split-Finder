// Nov 25: Keepa's product request by barcode (`code` in place of `asin`), through the one client: batched to Keepa's
// documented 100, the same ledger, budget and errors, its cost read from each response's own tokensConsumed and learned
// for the next estimate, and the first answers kept as bounded samples. A fake fetch; no network.
import { describe, expect, it } from 'vitest';

import { codeSampleOf, holdsBarcode, keepCodeSample, learnCodeCost } from '../src/keepa/barcode';
import { TokenBudget } from '../src/keepa/budget';
import { KeepaBudgetExceededError, KeepaClient, type KeepaLedgerEntry } from '../src/keepa/client';
import { KEEPA_CODE_GUARD_TOKENS } from '../src/keepa/estimates';
import type { KeepaCodeSample } from '../src/keepa/barcode';
import { gtinCheckDigit } from '../src/identifiers';
import { parseProductResponse } from '../src/keepa/parse';

const KEY = 'test-keepa-key-secret';
// DCF850B's barcode as Home Depot's page states it (fixtures/homedepot-pages/identifiers-upc-316627328-2026-11-25.json).
const DCF850B = '885911758215';
const upc = (body: string): string => `${body}${gtinCheckDigit(body)}`;
const OTHER = upc('88591175822');
const NONE = upc('88591175823');

interface Asked { url: URL }
function fakeKeepa(answer: (codes: string[]) => Record<string, unknown>, asked: Asked[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push({ url });
    const codes = (url.searchParams.get('code') ?? '').split(',').filter(Boolean);
    return new Response(JSON.stringify(answer(codes)), { status: 200 });
  }) as typeof fetch;
}

const meta = (consumed: number, left = 500) => ({ tokensLeft: left, tokensConsumed: consumed, refillRate: 1, refillIn: 60000, processingTimeInMs: 5 });
const product = (asin: string, title: string, codes: string[], over: Record<string, unknown> = {}) => ({
  asin, title, brand: 'DEWALT', manufacturer: 'DEWALT', partNumber: 'DCF850B', model: 'DCF850B', upcList: codes, stats: { current: [9900, 9500, -1, 1200] }, ...over,
});

/** Two products for DCF850B's barcode, one for OTHER, none for NONE (no `products` field at all). */
const answer = (codes: string[]): Record<string, unknown> => {
  const products: Record<string, unknown>[] = [];
  if (codes.includes(DCF850B)) {
    products.push(product('B0C1AAAAAA', 'DEWALT ATOMIC 20V MAX Impact Driver, Tool Only (DCF850B)', [DCF850B]));
    products.push(product('B0C1BBBBBB', 'DEWALT DCF850B Impact Driver (Bulk Packaged)', [DCF850B]));
  }
  if (codes.includes(OTHER)) products.push(product('B0C1CCCCCC', 'DEWALT DCF860B Impact Driver', [OTHER], { partNumber: 'DCF860B', model: 'DCF860B' }));
  return { ...meta(codes.length), ...(products.length > 0 ? { products } : {}) };
};

function client(opts: { fetchFn: typeof fetch; budget?: TokenBudget; ledger?: KeepaLedgerEntry[]; samples?: KeepaCodeSample[] }) {
  return new KeepaClient({
    apiKey: KEY, budget: opts.budget ?? new TokenBudget({ reserve: 0, maxPerRun: 10_000 }), fetchFn: opts.fetchFn,
    onSpend: (e) => void opts.ledger?.push(e), onCodeAnswer: (s) => void opts.samples?.push(s),
  });
}

describe('KeepaClient.productsByCode', () => {
  it('asks by code, not asin; two products for one barcode, one for another, none for a third', async () => {
    const asked: Asked[] = [];
    const ledger: KeepaLedgerEntry[] = [];
    const c = client({ fetchFn: fakeKeepa(answer, asked), ledger });
    const r = await c.productsByCode([DCF850B, `0${OTHER}`, NONE, DCF850B]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url.pathname).toBe('/product');
    expect(asked[0]!.url.searchParams.has('asin')).toBe(false);
    // Normalised to 12 digits, each once, in the order asked.
    expect(asked[0]!.url.searchParams.get('code')).toBe([DCF850B, OTHER, NONE].join(','));
    expect(asked[0]!.url.searchParams.get('stats')).toBe('180');
    expect(r.data.products.map((p) => p.asin)).toEqual(['B0C1AAAAAA', 'B0C1BBBBBB', 'B0C1CCCCCC']);
    expect(r.data.products[0]).toMatchObject({ upcList: [DCF850B], amazonPrice: 9900 });
    // The cost is the response's own tokensConsumed.
    expect(r.meta.tokensConsumed).toBe(3);
    expect(ledger).toEqual([expect.objectContaining({ kind: 'code', tokens: 3, codes: 3, products: 3 })]);
    expect(JSON.stringify(ledger)).not.toContain(KEY);
  });

  it('a no-match answer (no products field, or an empty list) is no product, not an error', async () => {
    for (const body of [meta(1), { ...meta(1), products: [] }, { ...meta(1), products: [null] }]) {
      const r = await client({ fetchFn: fakeKeepa(() => body) }).productsByCode([NONE]);
      expect(r.data.products).toEqual([]);
      expect(r.meta.tokensConsumed).toBe(1);
    }
    expect(parseProductResponse({}).products).toEqual([]);
  });

  it('batches to the documented 100 codes a request, and adds what each batch consumed', async () => {
    const asked: Asked[] = [];
    const codes = Array.from({ length: 150 }, (_, i) => upc(`7000000${String(i).padStart(4, '0')}`));
    const r = await client({ fetchFn: fakeKeepa((cs) => meta(cs.length * 2), asked) }).productsByCode(codes);
    expect(asked.map((a) => (a.url.searchParams.get('code') ?? '').split(',').length)).toEqual([100, 50]);
    expect(r.meta.tokensConsumed).toBe(300);
  });

  it('an invalid barcode is never sent; none valid is an error before any request', async () => {
    const asked: Asked[] = [];
    await expect(client({ fetchFn: fakeKeepa(answer, asked) }).productsByCode(['12345', '885911758216'])).rejects.toThrow('No valid barcode');
    expect(asked).toHaveLength(0);
  });

  it('the cost is never assumed: held to a search\'s tokens a code until a response says, then to the most a code cost', async () => {
    const c = client({ fetchFn: fakeKeepa((cs) => meta(cs.length)) });
    expect(c.codeCost).toBeNull();
    expect(c.codeEstimate(1)).toBe(KEEPA_CODE_GUARD_TOKENS);
    expect(c.codeEstimate(3)).toBe(3 * KEEPA_CODE_GUARD_TOKENS);
    await c.productsByCode([DCF850B, OTHER]);
    expect(c.codeCost).toEqual({ requests: 1, codes: 2, tokens: 2, maxPerCode: 1 });
    expect(c.codeEstimate(1)).toBe(1);
    expect(c.codeEstimate(100)).toBe(100);
    expect(learnCodeCost(c.codeCost, 1, 4)).toMatchObject({ requests: 2, codes: 3, tokens: 6, maxPerCode: 4 });
  });

  it('the budget refuses before anything is sent: the reserve holds a first code to a search\'s 10 tokens', async () => {
    const asked: Asked[] = [];
    const budget = new TokenBudget({ reserve: 100, maxPerRun: 10_000 }, 105);
    await expect(client({ fetchFn: fakeKeepa(answer, asked), budget }).productsByCode([DCF850B])).rejects.toBeInstanceOf(KeepaBudgetExceededError);
    expect(asked).toHaveLength(0);
  });

  it('a cached answer costs nothing and teaches nothing', async () => {
    const asked: Asked[] = [];
    const c = client({ fetchFn: fakeKeepa(answer, asked) });
    await c.productsByCode([DCF850B]);
    const again = await c.productsByCode([DCF850B]);
    expect(asked).toHaveLength(1);
    expect(again.source).toBe('cache');
    expect(again.meta.tokensConsumed).toBe(0);
    expect(c.codeCost?.requests).toBe(1);
  });
});

describe('the first code answers are kept as bounded samples', () => {
  it('identity fields only, with what it cost, never the key; the first three are kept', async () => {
    const samples: KeepaCodeSample[] = [];
    const big = (codes: string[]) => ({ ...answer(codes), apiKey: KEY, tokenFlowReduction: 0 });
    await client({ fetchFn: fakeKeepa(big), samples }).productsByCode([DCF850B]);
    expect(samples).toHaveLength(1);
    const s = samples[0]!;
    expect(s).toMatchObject({ codes: [DCF850B], tokensConsumed: 1, productCount: 2 });
    expect(s.products[0]).toMatchObject({ asin: 'B0C1AAAAAA', partNumber: 'DCF850B', upcList: [DCF850B] });
    expect(s.fields).toContain('tokensConsumed');
    expect(s.fields).not.toContain('apiKey');
    expect(JSON.stringify(s)).not.toContain(KEY);
    let kept: KeepaCodeSample[] = [];
    for (let i = 0; i < 5; i++) kept = keepCodeSample(kept, { ...s, at: String(i) });
    expect(kept.map((k) => k.at)).toEqual(['0', '1', '2']);
  });

  it('bounds a large answer: three products, titles cut', () => {
    const body = { ...meta(9), products: Array.from({ length: 9 }, (_, i) => product(`B0C1${i}`, 'x'.repeat(5000), [DCF850B])) };
    const s = codeSampleOf(body, [DCF850B], 0);
    expect(s.productCount).toBe(9);
    expect(s.products).toHaveLength(3);
    expect(s.products[0]!.title).toHaveLength(200);
    expect(JSON.stringify(s).length).toBeLessThan(3000);
  });
});

describe('holdsBarcode', () => {
  it("reads upcList, eanList and gtinList in any printed length; a real EAN-13 is not a UPC's", () => {
    expect(holdsBarcode({ upcList: [DCF850B] }, DCF850B)).toBe(true);
    expect(holdsBarcode({ eanList: [`0${DCF850B}`] }, DCF850B)).toBe(true);
    expect(holdsBarcode({ gtinList: [`00${DCF850B}`] }, DCF850B)).toBe(true);
    // B0DGLWKS9S's recorded eanList (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json) is a European EAN-13.
    expect(holdsBarcode({ eanList: ['3253561601224'] }, DCF850B)).toBe(false);
    expect(holdsBarcode({}, DCF850B)).toBe(false);
  });
});
