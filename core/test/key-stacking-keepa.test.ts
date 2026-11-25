import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { minutesUntilTokens, TokenBudget } from '../src/keepa/budget';
import { KeepaClient, KeepaError, type KeepaLedgerEntry } from '../src/keepa/client';
import { parseKeepaLedger } from '../src/costs/usage';

// Key stacking (Nov 25), Keepa: tokens are per key. Tokens available and the refill a minute are sums; a request uses one
// key that holds its tokens; the reserve is on the total.

const FX = join(__dirname, '../../fixtures/keepa');
/** Recorded: a product pull with stats (3 ASINs, 3 tokens), and a search (10 tokens). Their meta is each answer's own. */
const PRODUCT = JSON.parse(readFileSync(join(FX, 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json'), 'utf8')) as Record<string, unknown>;
const SEARCH = JSON.parse(readFileSync(join(FX, 'search-RYOBI-PCL235B.json'), 'utf8')) as Record<string, unknown>;
/** A token status answer carries the same meta fields (no recording of the token call itself; docs/decisions.md step 15). */
const status = (tokensLeft: number, refillRate = 1) => ({ timestamp: 1795386763705, tokensLeft, refillIn: 39108, refillRate, tokenFlowReduction: 0, tokensConsumed: 0 });

const KEYS = [{ id: 'key-1', key: 'keepa-key-one-aaaaaaaa' }, { id: 'key-2', key: 'keepa-key-two-bbbbbbbb' }];

function fakeFetch(byKey: Record<string, { status: number; body: unknown }[]>) {
  const calls: { key: string; path: string }[] = [];
  const fn = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const key = u.searchParams.get('key') ?? '';
    calls.push({ key, path: u.pathname });
    const next = byKey[key]?.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fn, calls };
}

describe('TokenBudget over several keys', () => {
  it('sums the keys; one key must hold a request; the reserve is on the total', () => {
    const b = new TokenBudget({ reserve: 5, maxPerRun: Number.POSITIVE_INFINITY });
    b.noteMeta(8, 0, 1, 'key-1');
    b.noteMeta(9, 0, 1, 'key-2');
    expect(b.knownBalance).toBe(17);
    expect(b.refillRatePerMinute).toBe(2);
    // 17 tokens together, but a lookup (11) needs one key with 11: none has it.
    expect(b.blockReason(11)).toBe('no_tokens');
    expect(b.pickKey(['key-1', 'key-2'], 11)).toBeNull();
    // A 1-token pull: key 2 has the most.
    expect(b.blockReason(1)).toBeNull();
    expect(b.pickKey(['key-1', 'key-2'], 1)).toBe('key-2');
    b.noteMeta(40, 0, 1, 'key-1');
    expect(b.pickKey(['key-1', 'key-2'], 11)).toBe('key-1');
    // The reserve holds on the total: 49 - 45 < 5.
    expect(b.blockReason(45)).toBe('no_tokens');
    expect(new TokenBudget({ reserve: 30, maxPerRun: 100 }).blockReason(11)).toBeNull();
  });

  it('one key without an id reads as before key stacking', () => {
    const b = new TokenBudget({ reserve: 5, maxPerRun: 100 });
    b.noteMeta(57, 0, 1);
    expect(b.knownBalance).toBe(57);
    expect(b.blockReason(11)).toBeNull();
    expect(b.blockReason(53)).toBe('reserve');
  });

  it('a refused key counts for nothing', () => {
    const b = new TokenBudget({ reserve: 0, maxPerRun: 100 });
    b.noteMeta(40, 0, 1, 'key-1');
    b.noteMeta(9, 0, 1, 'key-2');
    b.markOut('key-1');
    expect(b.knownBalance).toBe(9);
    expect(b.pickKey(['key-1', 'key-2'], 1)).toBe('key-2');
  });

  it('the wait until a lookup paces per key, and equals the one-key wait with one key', () => {
    // One key, 3 tokens, reserve 5, a lookup 11: 13 short at 1 a minute.
    expect(minutesUntilTokens([{ tokensLeft: 3, refillRate: 1 }], 11, 5)).toBe(13);
    // Two keys at 1 a minute each: 9 and 3. Key 1 holds 11 in 2 minutes; the total (12) is 11 + reserve 5 after 2 minutes too.
    expect(minutesUntilTokens([{ tokensLeft: 9, refillRate: 1 }, { tokensLeft: 3, refillRate: 1 }], 11, 5)).toBe(2);
    // The reserve can be what waits: 10 and 10, reserve 15: 26 needed together, 6 short at 2 a minute = 3.
    expect(minutesUntilTokens([{ tokensLeft: 10, refillRate: 1 }, { tokensLeft: 10, refillRate: 1 }], 11, 15)).toBe(3);
    expect(minutesUntilTokens([{ tokensLeft: 60, refillRate: 1 }, { tokensLeft: 0, refillRate: 1 }], 11, 5)).toBe(0);
  });
});

describe('KeepaClient with several keys', () => {
  it('token status asks every key (free) and gives the sums; a refused key is marked, the others carry on', async () => {
    const { fn, calls } = fakeFetch({
      'keepa-key-one-aaaaaaaa': [{ status: 200, body: status(57) }],
      'keepa-key-two-bbbbbbbb': [{ status: 401, body: {} }],
    });
    const refused: string[] = [];
    const budget = new TokenBudget({ reserve: 5, maxPerRun: 100 });
    const client = new KeepaClient({ keys: KEYS, budget, fetchFn: fn, onKeyRefused: (id) => void refused.push(id) });
    const s = await client.tokenStatus();
    expect(calls.map((c) => c.path)).toEqual(['/token', '/token']);
    expect(s).toMatchObject({ tokensLeft: 57, refillRate: 1 });
    expect(s.keys?.map((k) => `${k.id}:${k.ok}`)).toEqual(['key-1:true', 'key-2:false']);
    expect(refused).toEqual(['key-2']);
    expect(budget.knownBalance).toBe(57);
  });

  it('every key refused: the first failure is thrown, as with one key', async () => {
    const { fn } = fakeFetch({ 'keepa-key-one-aaaaaaaa': [{ status: 401, body: {} }], 'keepa-key-two-bbbbbbbb': [{ status: 401, body: {} }] });
    const client = new KeepaClient({ keys: KEYS, budget: new TokenBudget({ reserve: 0, maxPerRun: 100 }), fetchFn: fn });
    await expect(client.tokenStatus()).rejects.toMatchObject({ status: 401 });
  });

  it('a request uses the key that holds its tokens, and the ledger row names that key, never the key itself', async () => {
    const { fn, calls } = fakeFetch({
      'keepa-key-one-aaaaaaaa': [{ status: 200, body: status(4) }],
      'keepa-key-two-bbbbbbbb': [{ status: 200, body: status(50) }, { status: 200, body: SEARCH }],
    });
    const ledger: KeepaLedgerEntry[] = [];
    const budget = new TokenBudget({ reserve: 5, maxPerRun: 100 });
    const client = new KeepaClient({ keys: KEYS, budget, fetchFn: fn, onSpend: (e) => void ledger.push(e) });
    await client.tokenStatus();
    await client.searchProducts('RYOBI PCL235B', 1, { label: 'agent:lookup:PCL235B' });
    expect(calls.map((c) => `${c.key.slice(0, 13)}${c.path}`)).toEqual(['keepa-key-one/token', 'keepa-key-two/token', 'keepa-key-two/search']);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'search', tokens: 10, tokensLeft: 50, keyId: 'key-2' });
    expect(JSON.stringify(ledger)).not.toContain('keepa-key');
    // The recorded search left 50 on key 2: with key 1's 4, the run sees 54 and has spent 10.
    expect(budget.knownBalance).toBe(54);
    expect(budget.spentThisRun).toBe(10);
  });

  it('a 401 on a request marks that key and is thrown; the request is not sent again', async () => {
    const { fn, calls } = fakeFetch({
      'keepa-key-one-aaaaaaaa': [{ status: 200, body: status(30) }],
      'keepa-key-two-bbbbbbbb': [{ status: 200, body: status(60) }, { status: 401, body: {} }],
    });
    const budget = new TokenBudget({ reserve: 0, maxPerRun: 100 });
    const client = new KeepaClient({ keys: KEYS, budget, fetchFn: fn });
    await client.tokenStatus();
    await expect(client.getProducts(['B0BGYFTPGK'])).rejects.toBeInstanceOf(KeepaError);
    expect(calls).toHaveLength(3);
    expect(budget.knownBalance).toBe(30);
  });

  it('one plain key writes no key id, as before', async () => {
    const { fn } = fakeFetch({ 'keepa-key-one-aaaaaaaa': [{ status: 200, body: PRODUCT }] });
    const ledger: KeepaLedgerEntry[] = [];
    const client = new KeepaClient({ apiKey: 'keepa-key-one-aaaaaaaa', budget: new TokenBudget({ reserve: 0, maxPerRun: 100 }), fetchFn: fn, onSpend: (e) => void ledger.push(e) });
    await client.getProducts(['B0BGYFTPGK', 'B01H9BL8EO', 'B09M3TL9BB']);
    expect(ledger[0]?.keyId).toBeUndefined();
  });
});

describe('the Keepa ledger with and without a key id', () => {
  it('reads both', () => {
    const text = [
      JSON.stringify({ at: '2026-11-23T15:05:00.000Z', kind: 'search', key: 'keepa:search?…', label: 'agent:lookup:PCL235B', tokens: 10, tokensLeft: 50, refillIn: 39108, refillRate: 1 }),
      JSON.stringify({ at: '2026-11-25T10:00:00.000Z', kind: 'product', key: 'keepa:product?…', label: 'agent:refresh:B0BGYFTPGK', tokens: 1, tokensLeft: 49, refillIn: 1000, refillRate: 1, keyId: 'key-2' }),
    ].join('\n');
    expect(parseKeepaLedger(text).map((r) => r.keyId ?? null)).toEqual([null, 'key-2']);
  });
});
