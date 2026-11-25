import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLedger, searchesLeftByKey } from '../src/serpapi/balance';
import { parseAccount, pooledAccount, SearchBudget, type KeyAccount } from '../src/serpapi/budget';
import { BudgetExceededError, RateLimitedError, SerpApiClient, SerpApiError, type LedgerEntry } from '../src/serpapi/client';
import * as fx from './fixtures';

// Key stacking (Nov 25): the desktop agent may hold several SerpApi keys, each its own account. Searches left and the
// month's allowance are sums; the reserve and the per-scan cap are single numbers on the total; the hourly limit is each
// account's own; a search is charged to one key chosen before the call.

const account = (over: Record<string, unknown> = {}) => parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, ...over });
/** A real recorded Amazon search (fixtures/recorded), the body a successful search answers with. */
const RECORDED = JSON.parse(readFileSync(join(__dirname, '../../fixtures/recorded/amazon-search-P553.json'), 'utf8')) as Record<string, unknown>;

const K1 = 'key-1';
const K2 = 'key-2';
const KEYS = [{ id: K1, key: 'serp-key-one-aaaa' }, { id: K2, key: 'serp-key-two-bbbb' }];
const two = (a: Record<string, unknown>, b: Record<string, unknown>): KeyAccount[] => [{ id: K1, account: account(a) }, { id: K2, account: account(b) }];

/** A fake fetch: answers per key from a queue; records which key each call carried. No network. */
function fakeFetch(answers: Record<string, { status: number; body: unknown }[]>) {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    const key = new URL(String(url)).searchParams.get('api_key') ?? '';
    calls.push(key);
    const next = answers[key]?.shift() ?? { status: 200, body: RECORDED };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fn, calls };
}

describe('SearchBudget over several keys', () => {
  it('one key reads exactly as before key stacking', () => {
    const plain = new SearchBudget(account({ total_searches_left: 120, this_hour_searches: 45 }), { reserve: 100, maxPerRun: 40 });
    const pooled = new SearchBudget([{ id: K1, account: account({ total_searches_left: 120, this_hour_searches: 45 }) }], { reserve: 100, maxPerRun: 40 });
    for (const b of [plain, pooled]) {
      expect(b.leftOnAccount).toBe(120);
      expect(b.leftAboveReserve).toBe(20);
      expect(b.leftThisHour).toBe(5);
      expect(b.hourlyLimit).toBe(50);
      expect(b.spendable).toBe(5);
    }
  });

  it('searches left are the sum; the reserve and the per-scan cap apply to the total', () => {
    // Key 1: 60 left; key 2: 143 left. Reserve 100: 103 above it; a per-scan cap of 18 binds.
    const b = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), { reserve: 100, maxPerRun: 18 });
    expect(b.leftOnAccount).toBe(203);
    expect(b.leftAboveReserve).toBe(103);
    expect(b.spendable).toBe(18);
    // A scheduled scan's policy keeps the reserve on the total: at 100 left together nothing is spent.
    const atReserve = new SearchBudget(two({ total_searches_left: 40 }, { total_searches_left: 60 }), { reserve: 100, maxPerRun: 18 });
    expect(atReserve.blockReason(1)).toBe('reserve');
    // The owner's explicit yes (reserve 0) may spend it, still under the per-scan cap.
    expect(new SearchBudget(two({ total_searches_left: 40 }, { total_searches_left: 60 }), { reserve: 0, maxPerRun: 18 }).spendable).toBe(18);
  });

  it('the per-scan cap counts every key together', () => {
    const b = new SearchBudget(two({}, {}), { reserve: 0, maxPerRun: 3 });
    b.record(1, K1);
    b.record(2, K2);
    expect(b.spentThisRun).toBe(3);
    expect(b.blockReason(1)).toBe('run_cap');
  });

  it('the hourly limit is each account own: a key at its limit gives nothing this hour, the other still does', () => {
    const b = new SearchBudget(two({ this_hour_searches: 50 }, { this_hour_searches: 10 }), { reserve: 0, maxPerRun: 100 });
    expect(b.hourlyLimit).toBe(100);
    expect(b.leftThisHour).toBe(40);
    expect(b.pickKey()).toBe(K2);
    const both = new SearchBudget(two({ this_hour_searches: 50 }, { this_hour_searches: 50 }), { reserve: 0, maxPerRun: 100 });
    expect(both.blockReason(1)).toBe('hourly_limit');
    expect(both.pickKey()).toBeNull();
  });

  it('a key out of searches cannot lend its hour to the other: the hour counts what each key can really take', () => {
    // Key 1 has 0 left but a free hour; key 2 has 5 left and 2 searches left this hour.
    const b = new SearchBudget(two({ total_searches_left: 0 }, { total_searches_left: 5, this_hour_searches: 48 }), { reserve: 0, maxPerRun: 100 });
    expect(b.leftThisHour).toBe(2);
    expect(b.spendable).toBe(2);
  });

  it('chooses the key with the most searches left, the earlier key on a tie', () => {
    expect(new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), { reserve: 0, maxPerRun: 10 }).pickKey()).toBe(K2);
    expect(new SearchBudget(two({ total_searches_left: 143 }, { total_searches_left: 60 }), { reserve: 0, maxPerRun: 10 }).pickKey()).toBe(K1);
    expect(new SearchBudget(two({ total_searches_left: 90 }, { total_searches_left: 90 }), { reserve: 0, maxPerRun: 10 }).pickKey()).toBe(K1);
    // What this run spent counts: after 2 on key 2 (61 vs 60) it is still key 2, after 3 they tie and key 1 goes first.
    const b = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 63 }), { reserve: 0, maxPerRun: 10 });
    b.record(2, K2);
    expect(b.pickKey()).toBe(K2);
    b.record(1, K2);
    expect(b.pickKey()).toBe(K1);
  });

  it('a refused key counts for nothing more in the run', () => {
    const b = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), { reserve: 100, maxPerRun: 18 });
    b.markOut(K2);
    expect(b.leftOnAccount).toBe(60);
    expect(b.blockReason(1)).toBe('reserve');
    expect(b.byKey).toEqual([{ id: K1, left: 60, spent: 0, out: false }, { id: K2, left: 0, spent: 0, out: true }]);
  });

  it('pooledAccount sums the plans and names them', () => {
    const p = pooledAccount([account({ total_searches_left: 60 }), account({ plan_name: 'Developer', searches_per_month: 5000, total_searches_left: 4000 })]);
    expect(p).toMatchObject({ searchesPerMonth: 5250, totalSearchesLeft: 4060, rateLimitPerHour: 100, planName: 'Free Plan + Developer' });
    expect(pooledAccount([account(), account()]).planName).toBe('Free Plan');
  });
});

describe('SerpApiClient with several keys', () => {
  const policy = { reserve: 0, maxPerRun: 10 };

  it('charges the search to the chosen key and writes its id (never the key) to the ledger', async () => {
    const { fn, calls } = fakeFetch({});
    const ledger: LedgerEntry[] = [];
    const budget = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), policy);
    const client = new SerpApiClient({ keys: KEYS, budget, fetchFn: fn, onSpend: (e) => void ledger.push(e) });
    const r = await client.search({ engine: 'amazon', k: 'RYOBI P553' }, { label: 'agent:lookup:P553' });
    expect(r.source).toBe('network');
    expect(calls).toEqual(['serp-key-two-bbbb']);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ engine: 'amazon', label: 'agent:lookup:P553', keyId: K2 });
    expect(JSON.stringify(ledger)).not.toContain('serp-key');
    expect(budget.byKey.find((k) => k.id === K2)?.spent).toBe(1);
  });

  it('one plain key writes no key id, as before', async () => {
    const { fn } = fakeFetch({});
    const ledger: LedgerEntry[] = [];
    const client = new SerpApiClient({ apiKey: 'serp-key-one-aaaa', budget: new SearchBudget(account(), policy), fetchFn: fn, onSpend: (e) => void ledger.push(e) });
    await client.search({ engine: 'amazon', k: 'RYOBI P553' });
    expect(ledger[0]?.keyId).toBeUndefined();
  });

  it('a key SerpApi does not accept (401) is marked and the same search goes once with the next key; one charge', async () => {
    const { fn, calls } = fakeFetch({ 'serp-key-two-bbbb': [{ status: 401, body: {} }] });
    const ledger: LedgerEntry[] = [];
    const refused: string[] = [];
    const budget = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), policy);
    const client = new SerpApiClient({ keys: KEYS, budget, fetchFn: fn, onSpend: (e) => void ledger.push(e), onKeyRefused: (id, why) => void refused.push(`${id}:${why}`) });
    await client.search({ engine: 'amazon', k: 'RYOBI P553' });
    expect(calls).toEqual(['serp-key-two-bbbb', 'serp-key-one-aaaa']);
    expect(refused).toEqual([`${K2}:rejected`]);
    expect(ledger.map((e) => e.keyId)).toEqual([K1]);
    expect(budget.spentThisRun).toBe(1);
    // The next search never goes to the refused key.
    await client.search({ engine: 'amazon', k: 'RYOBI P554' });
    expect(calls).toEqual(['serp-key-two-bbbb', 'serp-key-one-aaaa', 'serp-key-one-aaaa']);
  });

  it('an account out of searches (429) falls over the same way', async () => {
    const { fn, calls } = fakeFetch({ 'serp-key-two-bbbb': [{ status: 429, body: {} }] });
    const refused: string[] = [];
    const budget = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), policy);
    const client = new SerpApiClient({ keys: KEYS, budget, fetchFn: fn, onKeyRefused: (id, why) => void refused.push(`${id}:${why}`) });
    await client.search({ engine: 'amazon', k: 'RYOBI P553' });
    expect(calls).toEqual(['serp-key-two-bbbb', 'serp-key-one-aaaa']);
    expect(refused).toEqual([`${K2}:limited`]);
  });

  it('never more than one fall-over, never twice on one key: three keys, two refusals, two sends', async () => {
    const three = [...KEYS, { id: 'key-3', key: 'serp-key-three-cc' }];
    const { fn, calls } = fakeFetch({ 'serp-key-three-cc': [{ status: 401, body: {} }], 'serp-key-two-bbbb': [{ status: 429, body: {} }] });
    const ledger: LedgerEntry[] = [];
    const budget = new SearchBudget([...two({ total_searches_left: 50 }, { total_searches_left: 100 }), { id: 'key-3', account: account({ total_searches_left: 200 }) }], policy);
    const client = new SerpApiClient({ keys: three, budget, fetchFn: fn, onSpend: (e) => void ledger.push(e) });
    await expect(client.search({ engine: 'amazon', k: 'RYOBI P553' })).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toEqual(['serp-key-three-cc', 'serp-key-two-bbbb']);
    expect(ledger).toEqual([]);
    expect(budget.spentThisRun).toBe(0);
  });

  it('no fall-over when the keys left cannot pay within the reserve', async () => {
    const { fn, calls } = fakeFetch({ 'serp-key-two-bbbb': [{ status: 401, body: {} }] });
    // 60 + 143 = 203 left, reserve 100: without key 2, 60 is under the reserve.
    const budget = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), { reserve: 100, maxPerRun: 10 });
    const client = new SerpApiClient({ keys: KEYS, budget, fetchFn: fn });
    await expect(client.search({ engine: 'amazon', k: 'RYOBI P553' })).rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual(['serp-key-two-bbbb']);
  });

  it('any other failure is thrown as with one key: no fall-over on a 500, an errored search or the network', async () => {
    for (const answer of [{ status: 500, body: {} }, { status: 200, body: { search_metadata: { status: 'Error' }, error: 'Something broke.' } }]) {
      const { fn, calls } = fakeFetch({ 'serp-key-two-bbbb': [answer] });
      const budget = new SearchBudget(two({ total_searches_left: 60 }, { total_searches_left: 143 }), policy);
      const client = new SerpApiClient({ keys: KEYS, budget, fetchFn: fn });
      await expect(client.search({ engine: 'amazon', k: 'RYOBI P553' })).rejects.toBeInstanceOf(SerpApiError);
      expect(calls).toEqual(['serp-key-two-bbbb']);
      expect(budget.spentThisRun).toBe(0);
    }
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const budget = new SearchBudget(two({}, {}), policy);
    await expect(new SerpApiClient({ keys: KEYS, budget, fetchFn: down }).search({ engine: 'amazon', k: 'x' })).rejects.toBeInstanceOf(SerpApiError);
  });

  it('a budget that blocks is refused before any key is sent', async () => {
    const { fn, calls } = fakeFetch({});
    const budget = new SearchBudget(two({ total_searches_left: 40 }, { total_searches_left: 50 }), { reserve: 100, maxPerRun: 10 });
    await expect(new SerpApiClient({ keys: KEYS, budget, fetchFn: fn }).search({ engine: 'amazon', k: 'x' })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toEqual([]);
  });
});

describe('the ledger and the balance per key', () => {
  // Rows as the owner's serpapi-ledger.jsonl holds them: two written before key stacking (no keyId), then one per key.
  const TEXT = [
    { at: '2026-11-23T15:05:00.000Z', engine: 'amazon', key: 'amazon|k=P553', label: 'agent:lookup:P553' },
    { at: '2026-11-23T15:06:00.000Z', engine: 'amazon', key: 'amazon|k=P554', label: 'agent:lookup:P554' },
    { at: '2026-11-25T10:00:00.000Z', engine: 'amazon', key: 'amazon|k=P555', label: 'agent:lookup:P555', keyId: K2 },
    { at: '2026-11-25T10:01:00.000Z', engine: 'amazon', key: 'amazon|k=P556', label: 'agent:lookup:P556', keyId: K1 },
  ].map((r) => JSON.stringify(r)).join('\n');

  it('reads rows with and without a key id', () => {
    const rows = parseLedger(TEXT);
    expect(rows.map((r) => r.keyId ?? null)).toEqual([null, null, K2, K1]);
  });

  it('a row with no key id is the first key: each key less its own rows after its own check', () => {
    const rows = parseLedger(TEXT);
    const checks = { [K1]: { left: 100, at: '2026-11-23T15:00:00.000Z' }, [K2]: { left: 143, at: '2026-11-25T09:00:00.000Z' } };
    const r = searchesLeftByKey(checks, rows, [K1, K2]);
    expect(r.byKey).toEqual({ [K1]: 97, [K2]: 142 });
    expect(r.total).toBe(239);
  });

  it('a key not checked yet is left out; none checked is null', () => {
    const rows = parseLedger(TEXT);
    expect(searchesLeftByKey({ [K2]: { left: 10, at: '2026-11-25T11:00:00.000Z' } }, rows, [K1, K2])).toEqual({ byKey: { [K2]: 10 }, total: 10 });
    expect(searchesLeftByKey({}, rows, [K1, K2]).total).toBeNull();
  });
});
