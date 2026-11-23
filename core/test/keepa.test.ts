import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TokenBudget } from '../src/keepa/budget';
import { KeepaBudgetExceededError, KeepaClient } from '../src/keepa/client';
import { keepaProductSearchResult } from '../src/keepa/fetchStep';
import { centsToDollars, parseProductResponse } from '../src/keepa/parse';
import { MemoryCache } from '../src/serpapi/client';

const FIXTURE = (): Record<string, unknown> => {
  const path = new URL('../../fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json', import.meta.url);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {
      refillRate: 5,
      refillIn: 0,
      tokensLeft: 100,
      tokensConsumed: 3,
      processingTimeInMs: 12,
      products: [
        {
          asin: 'B0BGYFTPGK',
          title: 'Fixture product',
          partNumber: 'PCL235B',
          stats: { current: [2499, -1, -1, -1] },
        },
      ],
    };
  }
};

describe('keepa parse', () => {
  it('maps validation ASINs from the recorded fixture', () => {
    const parsed = parseProductResponse(FIXTURE());
    const byAsin = new Map(parsed.products.map((p) => [p.asin, p]));
    expect(byAsin.get('B0BGYFTPGK')).toMatchObject({ brand: 'RYOBI', partNumber: 'PCL235B' });
    expect(byAsin.get('B01H9BL8EO')).toMatchObject({ partNumber: 'DCB606' });
    expect(byAsin.get('B09M3TL9BB')).toMatchObject({ partNumber: 'DCF921B' });
  });

  it('reads Amazon cents from stats.current[0] when stats is present', () => {
    const parsed = parseProductResponse({
      tokensLeft: 1,
      tokensConsumed: 0,
      refillRate: 0,
      refillIn: 0,
      processingTimeInMs: 0,
      products: [{ asin: 'X', stats: { current: [2499, -1, -1, -1] } }],
    });
    expect(parsed.products[0]?.amazonPrice).toBe(2499);
    expect(centsToDollars(parsed.products[0]?.amazonPrice)).toBe(24.99);
  });
});

describe('KeepaClient', () => {
  const KEY = 'test-keepa-key-secret';

  it('caches product responses and does not spend tokens on a cache hit', async () => {
    let fetches = 0;
    const body = FIXTURE();
    const fetchFn = (async () => {
      fetches += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const budget = new TokenBudget({ reserve: 0, maxPerRun: 10 });
    const cache = new MemoryCache();
    const client = new KeepaClient({ apiKey: KEY, budget, cache, fetchFn });

    const first = await client.getProducts(['B0BGYFTPGK'], 1, { estimate: 1 });
    const second = await client.getProducts(['B0BGYFTPGK'], 1, { estimate: 1 });

    expect(first.source).toBe('network');
    expect(second.source).toBe('cache');
    expect(second.meta.tokensConsumed).toBe(0);
    expect(fetches).toBe(1);
    expect(budget.spentThisRun).toBe(body.tokensConsumed);
  });

  it('enforces reserve and no_tokens once balance is known', () => {
    const budget = new TokenBudget({ reserve: 5, maxPerRun: 100 });
    budget.noteMeta(10, 0, 1);
    expect(budget.blockReason(6)).toBe('reserve');
    budget.noteMeta(0, 0, 1);
    expect(budget.blockReason(1)).toBe('no_tokens');
  });

  it('applies reserve from a seeded account balance before any response', () => {
    const budget = new TokenBudget({ reserve: 5, maxPerRun: 100 }, 8);
    expect(budget.blockReason(4)).toBe('reserve');
  });

  it('refuses an empty getProducts call', async () => {
    const client = new KeepaClient({
      apiKey: KEY,
      budget: new TokenBudget({ reserve: 0, maxPerRun: 5 }),
      fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    });
    await expect(client.getProducts([], 1)).rejects.toMatchObject({ message: 'No ASINs to request.' });
  });

  it('blocks before network when the run cap would be exceeded', async () => {
    const fetchFn = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const client = new KeepaClient({
      apiKey: KEY,
      budget: new TokenBudget({ reserve: 0, maxPerRun: 1 }),
      fetchFn,
    });
    await expect(client.getProducts(['A'], 1, { estimate: 2 })).rejects.toBeInstanceOf(KeepaBudgetExceededError);
  });

  it('never puts the api key in thrown errors', async () => {
    const fetchFn = (async () => {
      throw new Error('connection reset');
    }) as typeof fetch;
    const client = new KeepaClient({
      apiKey: KEY,
      budget: new TokenBudget({ reserve: 0, maxPerRun: 5 }),
      fetchFn,
    });
    const err = await client.getProducts(['A'], 1, { estimate: 1 }).catch((e: unknown) => e);
    expect(String(err)).not.toContain(KEY);
  });

  it('marks fetchStep results as Keepa spend, not SerpApi', async () => {
    const cache = new MemoryCache();
    const body = FIXTURE();
    await cache.set('keepa:product?asin=B0BGYFTPGK&domain=1&history=0', { at: 1, data: body });
    const client = new KeepaClient({ apiKey: 'fixture', budget: new TokenBudget({ reserve: 0, maxPerRun: 5 }), cache });
    const result = await keepaProductSearchResult(client, 'B0BGYFTPGK', { label: 'test' });
    expect(result.billAs).toBe('keepa');
    expect(result.keepaTokens).toBe(0);
  });
});