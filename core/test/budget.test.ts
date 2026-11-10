import { describe, expect, it } from 'vitest';

import { planScan } from '../src/scanPlan';
import { forecastUsage, nextRun, runsPerMonth, validateSchedule } from '../src/schedule';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { BudgetExceededError, cacheKey, MemoryCache, RateLimitedError, SerpApiClient, SerpApiError, type LedgerEntry } from '../src/serpapi/client';
import { cleanBrand, parseAmazonProduct, parseAmazonSearch, parseHomeDepotSearch } from '../src/serpapi/parsers';
import { DEV_ALLOCATION, DEV_RESERVE, FREE_PLAN } from '../../scripts/dev-budget';
import * as fx from './fixtures';

const free = (over: Record<string, unknown> = {}) => parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, ...over });

/** A fake fetch that records calls and answers from a queue. No network. */
function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const ok = (extra: Record<string, unknown> = {}) => ({ body: { search_metadata: { status: 'Success' }, ...extra } });

describe('account and budget', () => {
  it('reads the free plan from the Account API response', () => {
    expect(free()).toMatchObject({ searchesPerMonth: 250, totalSearchesLeft: 250, rateLimitPerHour: 50, renewalDate: null });
    expect(() => parseAccount({ error: 'Invalid API key' })).toThrow(/Invalid API key/);
  });

  it('applies the tightest of reserve, run cap and hourly limit', () => {
    expect(new SearchBudget(free(), { reserve: 100, maxPerRun: 40 }).spendable).toBe(40); // run cap
    expect(new SearchBudget(free({ total_searches_left: 120 }), { reserve: 100, maxPerRun: 40 }).spendable).toBe(20); // reserve
    expect(new SearchBudget(free({ this_hour_searches: 45 }), { reserve: 100, maxPerRun: 40 }).spendable).toBe(5); // hourly
    expect(new SearchBudget(free({ total_searches_left: 90 }), { reserve: 100, maxPerRun: 40 }).spendable).toBe(0);
  });

  it('names the reason it stops', () => {
    const b = new SearchBudget(free({ total_searches_left: 102 }), { reserve: 100, maxPerRun: 40 });
    expect(b.canSpend()).toBe(true);
    b.record(2);
    expect(b.blockReason()).toBe('reserve');
    const capped = new SearchBudget(free(), { reserve: 0, maxPerRun: 1 });
    capped.record();
    expect(capped.blockReason()).toBe('run_cap');
    expect(new SearchBudget(free({ this_hour_searches: 50 }), { reserve: 0, maxPerRun: 9 }).blockReason()).toBe('hourly_limit');
  });

  it('keeps the development plan inside the free tier', () => {
    const planned = Object.values(DEV_ALLOCATION).reduce((a, b) => a + b, 0);
    expect(planned + DEV_RESERVE).toBeLessThanOrEqual(FREE_PLAN.searchesPerMonth);
    // The largest single session must also fit the free plan's hourly limit.
    expect(Math.max(...Object.values(DEV_ALLOCATION))).toBeLessThanOrEqual(FREE_PLAN.searchesPerHour);
  });
});

describe('client', () => {
  const setup = (responses: { status?: number; body: unknown }[], account = free(), policy = { reserve: 100, maxPerRun: 40 }) => {
    const { fn, calls } = fakeFetch(responses);
    const budget = new SearchBudget(account, policy);
    const ledger: LedgerEntry[] = [];
    let clock = 1_000;
    const client = new SerpApiClient({
      apiKey: 'SECRET',
      budget,
      cache: new MemoryCache(),
      fetchFn: fn,
      onSpend: (e) => void ledger.push(e),
      now: () => clock,
    });
    return { client, budget, calls, ledger, tick: (ms: number) => (clock += ms) };
  };

  it('charges one search for a network answer and nothing for a cached one', async () => {
    const { client, budget, calls, ledger } = setup([ok({ products: [] })]);
    const params = { engine: 'home_depot', q: 'dewalt combo kit', page: 1 };
    expect((await client.search(params, { label: 'scan' })).source).toBe('network');
    expect((await client.search({ page: 1, q: 'dewalt combo kit', engine: 'home_depot' })).source).toBe('cache');
    expect(calls).toHaveLength(1);
    expect(budget.spentThisRun).toBe(1);
    expect(ledger).toMatchObject([{ engine: 'home_depot', label: 'scan' }]);
  });

  it('keeps the key out of cache keys and the ledger', async () => {
    const { client, ledger, calls } = setup([ok()]);
    await client.search({ engine: 'amazon', k: 'PBLRC25B' });
    expect(calls[0]).toContain('api_key=SECRET');
    expect(JSON.stringify(ledger)).not.toContain('SECRET');
    expect(cacheKey({ engine: 'amazon', k: 'x', api_key: 'SECRET', no_cache: true })).toBe('engine=amazon&k=x');
  });

  it('refuses to call the network when the budget is closed', async () => {
    const { client, calls } = setup([ok()], free({ total_searches_left: 100 }));
    await expect(client.search({ engine: 'amazon', k: 'x' })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(0);
  });

  it('stops exactly at the run cap', async () => {
    const { client, budget, calls } = setup([ok(), ok(), ok()], free(), { reserve: 100, maxPerRun: 2 });
    await client.search({ engine: 'amazon', k: 'a' });
    await client.search({ engine: 'amazon', k: 'b' });
    await expect(client.search({ engine: 'amazon', k: 'c' })).rejects.toMatchObject({ reason: 'run_cap' });
    expect(calls).toHaveLength(2);
    expect(budget.spentThisRun).toBe(2);
  });

  it('does not charge for refused, failed or errored searches', async () => {
    const { client, budget } = setup([
      { status: 429, body: { error: 'Your account has run out of searches.' } },
      { status: 500, body: {} },
      { body: { search_metadata: { status: 'Error' }, error: 'Proxy timeout' } },
    ]);
    await expect(client.search({ engine: 'amazon', k: 'a' })).rejects.toBeInstanceOf(RateLimitedError);
    await expect(client.search({ engine: 'amazon', k: 'a' })).rejects.toBeInstanceOf(SerpApiError);
    await expect(client.search({ engine: 'amazon', k: 'a' })).rejects.toThrow('Proxy timeout');
    expect(budget.spentThisRun).toBe(0);
  });

  it('charges for a successful search that found nothing', async () => {
    const { client, budget } = setup([ok({ error: "Amazon hasn't returned any results for this query." })]);
    const res = await client.search({ engine: 'amazon', k: 'zzzz' });
    expect(parseAmazonSearch(res.data)).toEqual([]);
    expect(budget.spentThisRun).toBe(1);
  });

  it('refetches when the caller says a cached price is too old', async () => {
    const { client, calls, tick } = setup([ok(), ok()]);
    await client.search({ engine: 'amazon', k: 'a' });
    tick(60_000);
    expect((await client.search({ engine: 'amazon', k: 'a' }, { maxAgeMs: 120_000 })).source).toBe('cache');
    tick(120_000);
    expect((await client.search({ engine: 'amazon', k: 'a' }, { maxAgeMs: 120_000 })).source).toBe('network');
    expect(calls).toHaveLength(2);
  });

  it('checks the account for free and reports a bad key clearly', async () => {
    const good = fakeFetch([{ body: fx.SERPAPI_ACCOUNT_FREE }]);
    expect((await SerpApiClient.account('SECRET', good.fn)).totalSearchesLeft).toBe(250);
    expect(good.calls[0]).toContain('/account.json');
    await expect(SerpApiClient.account('BAD', fakeFetch([{ status: 401, body: {} }]).fn)).rejects.toThrow(/did not accept/);
  });

  it('will not start without a key', () => {
    expect(() => new SerpApiClient({ apiKey: '', budget: new SearchBudget(free(), { reserve: 0, maxPerRun: 1 }) })).toThrow(/No SerpApi key/);
  });
});

describe('parsers (doc-shaped samples)', () => {
  it('reads Home Depot search results', () => {
    const { listings, hasNextPage } = parseHomeDepotSearch(fx.SERPAPI_HD_SEARCH);
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({ itemId: '328814689', model: 'PBLRC2501SB', brand: 'RYOBI', price: 189, regularPrice: 338, badge: 'Special-Buy' });
    expect(listings[1]!.regularPrice).toBeNull();
    expect(hasNextPage).toBe(true);
    expect(parseHomeDepotSearch({}).listings).toEqual([]);
  });

  it('reads Amazon search results', () => {
    const results = parseAmazonSearch(fx.SERPAPI_AMAZON_SEARCH);
    expect(results.map((r) => r.asin)).toEqual(['B0B3JWF5ZV', 'B0SPONSORED']);
    expect(results[0]).toMatchObject({ price: 169, reviews: 181, sponsored: false });
    expect(results[1]!.sponsored).toBe(true);
  });

  it('reads an Amazon product page and cleans its brand and part number', () => {
    const c = parseAmazonProduct(fx.SERPAPI_AMAZON_PRODUCT, 'B0B6Z2ZGVK');
    expect(c).toMatchObject({ asin: 'B0B6Z2ZGVK', brand: 'RYOBI', partNumber: 'PBLRC01B', upcs: ['033287193714'], price: 179 });
    expect(cleanBrand('Brand: DEWALT')).toBe('DEWALT');
    expect(parseAmazonProduct({}, 'X')).toBeNull();
  });
});

describe('schedule', () => {
  const at = (iso: string) => new Date(iso);

  it('validates what the founder types', () => {
    expect(validateSchedule({ mode: 'manual' })).toBeNull();
    expect(validateSchedule({ mode: 'interval', hours: 0 })).toMatch(/1 and 168/);
    expect(validateSchedule({ mode: 'daily', at: '7am' })).toMatch(/24-hour/);
    expect(validateSchedule({ mode: 'daily', at: '07:00' })).toBeNull();
  });

  it('never schedules in manual mode', () => {
    expect(nextRun({ mode: 'manual' }, at('2026-11-10T09:00:00'), null)).toBeNull();
  });

  it('runs an interval from the last run, and catches up once when overdue', () => {
    const s = { mode: 'interval', hours: 6 } as const;
    const now = at('2026-11-10T09:00:00');
    expect(nextRun(s, now, null)).toEqual(now);
    expect(nextRun(s, now, at('2026-11-10T07:00:00'))).toEqual(at('2026-11-10T13:00:00'));
    expect(nextRun(s, now, at('2026-11-08T07:00:00'))).toEqual(now); // Chrome was closed for two days: one run, not eight
  });

  it('runs daily at the chosen time and catches up a missed slot once', () => {
    const s = { mode: 'daily', at: '07:00' } as const;
    expect(nextRun(s, at('2026-11-10T06:00:00'), at('2026-11-09T07:00:00'))).toEqual(at('2026-11-10T07:00:00'));
    expect(nextRun(s, at('2026-11-10T09:00:00'), at('2026-11-09T07:00:00'))).toEqual(at('2026-11-10T09:00:00'));
    expect(nextRun(s, at('2026-11-10T09:00:00'), at('2026-11-10T07:00:30'))).toEqual(at('2026-11-11T07:00:00'));
  });

  it('shows whether a frequency fits the plan before it is saved', () => {
    expect(runsPerMonth({ mode: 'interval', hours: 6 })).toBe(120);
    // Free plan, 100 held in reserve: daily scans of 40 searches cannot fit; 5 per scan can.
    expect(forecastUsage({ mode: 'daily', at: '07:00' }, 40, 250, 100)).toEqual({ searchesPerMonth: 1200, fitsPlan: false, maxPerRunThatFits: 5 });
    // The $75 plan (5,000 searches) fits a daily scan of 40 comfortably.
    expect(forecastUsage({ mode: 'daily', at: '07:00' }, 40, 5000, 100).fitsPlan).toBe(true);
    expect(forecastUsage({ mode: 'manual' }, 40, 250, 100)).toMatchObject({ searchesPerMonth: 0, fitsPlan: true });
  });
});

describe('scan planning', () => {
  const req = { hdPagesWanted: 4, pendingLookups: Array.from({ length: 20 }, (_, i) => `M${i}`), staleRefreshes: ['S0', 'S1', 'S2'] };

  it('does everything when the allowance covers it', () => {
    expect(planScan(40, req)).toMatchObject({ hdPages: 4, searches: 27, deferredLookups: [], deferredRefreshes: [] });
  });

  it('keeps listing pages, then lookups, then refreshes when the allowance is tight', () => {
    const plan = planScan(10, req);
    expect(plan.hdPages).toBe(4);
    expect(plan.lookups).toEqual(['M0', 'M1', 'M2', 'M3', 'M4', 'M5']);
    expect(plan.refreshes).toEqual([]);
    expect(plan.deferredLookups).toHaveLength(14);
    expect(plan.deferredRefreshes).toHaveLength(3);
    expect(plan.searches).toBe(10);
  });

  it('never plans more than it may spend', () => {
    for (const allowance of [0, 1, 2, 3, 5, 26, 27, 100]) {
      const plan = planScan(allowance, req);
      expect(plan.searches).toBeLessThanOrEqual(allowance);
      expect(plan.lookups.length + plan.deferredLookups.length).toBe(20);
    }
    expect(planScan(3, req)).toMatchObject({ hdPages: 1, lookups: ['M0', 'M1'] });
    expect(planScan(0, req).searches).toBe(0);
  });
});
