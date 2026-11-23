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
});