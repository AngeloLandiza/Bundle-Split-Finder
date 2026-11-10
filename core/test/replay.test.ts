import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { REQUESTS } from '../../scripts/fixture-requests';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { SerpApiClient } from '../src/serpapi/client';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import * as fx from './fixtures';

const account = () => parseAccount(fx.SERPAPI_ACCOUNT_FREE);

describe('replayRecorded', () => {
  it('answers a recorded request through the real client and charges the budget once', async () => {
    const replay = replayRecorded();
    const budget = new SearchBudget(account(), { reserve: 0, maxPerRun: 5 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, fetchFn: replay.fetchFn });
    const first = await client.search({ engine: 'amazon', k: 'RYOBI PBLRC25B', amazon_domain: 'amazon.com' });
    expect(first.source).toBe('network');
    expect(parseAmazonSearch(first.data)).toHaveLength(10);
    const again = await client.search({ amazon_domain: 'amazon.com', k: 'RYOBI PBLRC25B', engine: 'amazon' });
    expect(again.source).toBe('cache');
    expect(budget.spentThisRun).toBe(1);
    expect(replay.calls).toEqual(['amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC25B']);
  });

  it('refuses a request that was never recorded, and the budget is not charged', async () => {
    const replay = replayRecorded();
    const budget = new SearchBudget(account(), { reserve: 0, maxPerRun: 5 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, fetchFn: replay.fetchFn });
    await expect(client.search({ engine: 'amazon', k: 'RYOBI NOPE', amazon_domain: 'amazon.com' })).rejects.toThrow(/HTTP 404/);
    expect(budget.spentThisRun).toBe(0);
  });

  it('replays every recorded request', async () => {
    const replay = replayRecorded();
    const budget = new SearchBudget(account(), { reserve: 0, maxPerRun: 20 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, fetchFn: replay.fetchFn });
    expect(REQUESTS).toHaveLength(9);
    for (const req of REQUESTS) {
      const { data } = await client.search(req.params);
      expect((data as { search_metadata: { status: string } }).search_metadata.status).toBe('Success');
    }
    expect(replay.calls).toHaveLength(9);
  });

  it('answers 404 with the cache key in the body, and accepts a URL object', async () => {
    const replay = replayRecorded();
    const res = await replay.fetchFn(new URL('https://serpapi.com/search.json?engine=amazon&k=X+Y&api_key=TEST'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No recording for engine=amazon&k=X Y' });
    expect(replay.calls).toEqual(['engine=amazon&k=X Y']);
  });
});
