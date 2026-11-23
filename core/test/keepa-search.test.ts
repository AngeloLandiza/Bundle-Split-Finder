import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TokenBudget } from '../src/keepa/budget';
import { KeepaClient } from '../src/keepa/client';
import { keepaLookupSearchResult } from '../src/keepa/fetchStep';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import { parseSearchResponse } from '../src/keepa/parse';
import { MemoryCache } from '../src/serpapi/client';

describe('keepa search fixture', () => {
  it('parses ASIN list from recorded search', () => {
    const body = JSON.parse(
      readFileSync(new URL('../../fixtures/keepa/search-RYOBI-PCL235B.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const parsed = parseSearchResponse(body);
    expect(parsed.asinList?.length).toBeGreaterThan(0);
    expect(parsed.asinList).toContain('B0BGYFTPGK');
    expect(parsed.products?.length).toBeGreaterThan(0);
  });

  it('lookup shim parses as amazon search rows', async () => {
    const body = JSON.parse(
      readFileSync(new URL('../../fixtures/keepa/search-RYOBI-PCL235B.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const cache = new MemoryCache();
    await cache.set('keepa:search?domain=1&term=RYOBI PCL235B&type=product', { at: 1, data: body });
    const client = new KeepaClient({ apiKey: 'fixture', budget: new TokenBudget({ reserve: 0, maxPerRun: 20 }), cache });
    const result = await keepaLookupSearchResult(client, 'RYOBI PCL235B', { label: 'test' });
    expect(result.billAs).toBe('keepa');
    const rows = parseAmazonSearch(result.data);
    expect(rows.some((r) => r.asin === 'B0BGYFTPGK')).toBe(true);
  });
});