import { describe, expect, it } from 'vitest';

import { serpApiProductBodyFromKeepa } from '../src/keepa/amazon';
import { parseProductResponse } from '../src/keepa/parse';
import { quotePaid, runPaid, type ProductPage, savedAnswers } from '../src/scan/paid';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { DEFAULT_SCAN_SETTINGS, type PaidAction } from '../src/scan/types';
import { TokenBudget } from '../src/keepa/budget';
import { type SearchResult, MemoryCache } from '../src/serpapi/client';
import { SearchBudget, parseAccount } from '../src/serpapi/budget';
import * as fx from './fixtures';

const FIXTURE = {
  refillRate: 5,
  refillIn: 2,
  tokensLeft: 48,
  tokensConsumed: 1,
  processingTimeInMs: 10,
  products: [{ asin: 'B0B3JWF5ZV', title: 'RYOBI ratchet', partNumber: 'PBLRC25B', stats: { current: [4999, -1, -1, -1] } }],
};

const VERIFY: PaidAction = { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' };
const LOOKUP: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC25B' }] };
const T0 = 1_700_000_000_000;

describe('paid actions with Keepa product pages', () => {
  it('quotes verify as Keepa tokens, not SerpApi searches', () => {
    const budget = new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 5 });
    const keepaBudget = new TokenBudget({ reserve: 0, maxPerRun: 5 });
    const q = quotePaid(
      VERIFY,
      { listingAnswers: () => false },
      budget,
      { verifyUsesKeepa: true, keepaBudget },
    );
    expect(q).toMatchObject({ searches: 0, keepaTokens: 1, refusal: null });
  });

  it('verify through productPage spends no SerpApi searches', async () => {
    const store = new MemoryScanStore();
    await store.putMatch({
      key: 'RYOBI:PBLRC25B',
      brand: 'RYOBI',
      model: 'PBLRC25B',
      asin: 'B0B3JWF5ZV',
      status: 'matched',
      grade: 'probable',
      decidedBy: 'auto',
      alternatives: [],
      waitingSince: null,
      updatedAt: T0,
    });
    const parsed = parseProductResponse(FIXTURE);
    const product = parsed.products[0]!;
    const productPage: ProductPage = async () => ({
      data: serpApiProductBodyFromKeepa(product),
      source: 'cache',
      at: T0,
      billAs: 'keepa',
      keepaTokens: 0,
    });
    const labels: string[] = [];
    const budget = new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 5 });
    const client = {
      search: async () => {
        labels.push('serpapi');
        return { data: {}, source: 'network' as const, at: T0 };
      },
    };
    await runPaid({
      client,
      budget,
      store,
      now: () => T0,
      settings: { ...DEFAULT_SCAN_SETTINGS, amazonRefreshViaKeepa: true },
      productPage,
      keepaBudget: new TokenBudget({ reserve: 0, maxPerRun: 5 }),
    }, VERIFY);
    expect(labels).toEqual([]);
    expect(budget.spentThisRun).toBe(0);
    const match = await store.getMatch('RYOBI:PBLRC25B');
    expect(match?.status).not.toBe('probable');
  });

  it('quotes look up as Keepa tokens when lookupUsesKeepa is set', () => {
    const budget = new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 5 });
    const keepaBudget = new TokenBudget({ reserve: 0, maxPerRun: 30 });
    const q = quotePaid(
      LOOKUP,
      { listingAnswers: () => false },
      budget,
      { lookupUsesKeepa: true, keepaBudget },
    );
    // Step 15: a lookup is the search (10) and one price pull (1), as recorded.
    expect(q).toMatchObject({ searches: 0, keepaTokens: 11, refusal: null });
  });

  it('Look up on Keepa: the search rows carry no price, so the listing it matched is pulled once for it (1 token)', async () => {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: 'homedepot:1', retailer: 'homedepot', itemId: '1', title: 'RYOBI ratchet kit', brand: 'RYOBI', model: 'PBLRC25B', upc: null, price: 49, regularPrice: 99,
      percentOff: 50, link: null, seenAt: T0, split: { components: ['PBLRC25B'], status: 'resolved', notes: [] },
    });
    const product = parseProductResponse(FIXTURE).products[0]!;
    const calls: string[] = [];
    const keepaLookup = async (): Promise<SearchResult> => {
      calls.push('search');
      return {
        data: { organic_results: [{ asin: 'B0B3JWF5ZV', title: 'RYOBI ONE+ HP 18V Brushless Extended Reach 3/8 in. Ratchet (Tool Only) PBLRC25B', brand: 'RYOBI', price: null, extracted_price: null }] },
        source: 'network', at: T0, billAs: 'keepa', keepaTokens: 10,
      };
    };
    const productPage: ProductPage = async (asin, label) => {
      calls.push(`product ${asin} ${label}`);
      return { data: serpApiProductBodyFromKeepa(product), source: 'network', at: T0, billAs: 'keepa', keepaTokens: 1 };
    };
    const budget = new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 5 });
    const client = { search: async () => { calls.push('serpapi'); return { data: {}, source: 'network' as const, at: T0 }; } };
    await runPaid({
      client, budget, store, now: () => T0, settings: { ...DEFAULT_SCAN_SETTINGS, amazonRefreshViaKeepa: true }, productPage,
      keepaBudget: new TokenBudget({ reserve: 0, maxPerRun: 50 }), keepaLookup,
    }, LOOKUP);
    expect(await store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV' });
    expect(calls).toEqual(['search', 'product B0B3JWF5ZV panel:refresh:PBLRC25B']);
    expect((await store.getPrice('B0B3JWF5ZV'))!.price).toBe(49.99);
  });
});