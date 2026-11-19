import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  EbayAuthError, EbayCapError, EbayClient, EbayForbiddenError, EbayRateLimitedError, EbayServerError,
} from '../src/ebay/client';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/ebay/${f}`, import.meta.url), 'utf8'));
// eBay's own bodies: the fixture files wrap them in { about, response }.
const SEARCH = (load('browse-search-PCL206B-2026-11-19.json') as { response: unknown }).response;
const ITEM = (load('browse-item-237179711800-2026-11-19.json') as { response: unknown }).response;

const APP = 'APPID-secret-aaa';
const CERT = 'CERTID-secret-bbb';

interface Call { url: string; init: RequestInit }
interface Reply { status: number; body: unknown }

/** A fake fetch: token calls get tokens t1, t2, ...; other calls pop from `replies` (default 200 with the recorded search). */
function fake(replies: Reply[] = []) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/oauth2/token')) {
      tokens += 1;
      return new Response(JSON.stringify({ access_token: `t${tokens}`, expires_in: 7200 }), { status: 200 });
    }
    const r = replies.shift() ?? { status: 200, body: SEARCH };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, tokenCalls: () => calls.filter((c) => c.url.includes('/oauth2/token')) };
}

const make = (f: ReturnType<typeof fake>, extra: Record<string, unknown> = {}, clock = { t: 1_000_000 }) =>
  ({ client: new EbayClient({ appId: APP, certId: CERT, fetchFn: f.fetchFn, now: () => clock.t, ...extra }), clock });

const OPTS = { categoryIds: ['3247'], conditionNew: true, fixedPrice: true, limit: 200 };

describe('EbayClient', () => {
  it('gets a token with Basic auth, searches with the marketplace header and parses the summaries', async () => {
    const f = fake();
    const { client } = make(f);
    const r = await client.search('RYOBI PCL206B', OPTS);
    expect(r.summaries).toHaveLength(10);
    expect(r.total).toBe((SEARCH as { total: number }).total);
    const tok = f.tokenCalls()[0]!;
    expect(tok.url).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    expect((tok.init.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from(`${APP}:${CERT}`).toString('base64'));
    expect(String(tok.init.body)).toContain(encodeURIComponent('https://api.ebay.com/oauth/api_scope'));
    const s = f.calls[1]!;
    const u = new URL(s.url);
    expect(u.pathname).toBe('/buy/browse/v1/item_summary/search');
    expect(u.searchParams.get('q')).toBe('RYOBI PCL206B');
    expect(u.searchParams.get('filter')).toBe('conditionIds:{1000},buyingOptions:{FIXED_PRICE}');
    expect(u.searchParams.get('category_ids')).toBe('3247');
    expect(u.searchParams.get('limit')).toBe('200');
    const h = s.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer t1');
    expect(h['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
  });

  it('getItem returns a parsed listing without any seller field', async () => {
    const f = fake([{ status: 200, body: ITEM }]);
    const { client } = make(f);
    const l = await client.getItem('v1|237179711800|0');
    expect(l.itemId).toBeTruthy();
    expect(JSON.stringify(l)).not.toMatch(/seller(?!ItemRevision)/i);
    expect(new URL(f.calls[1]!.url).pathname).toBe('/buy/browse/v1/item/' + encodeURIComponent('v1|237179711800|0'));
    expect(client.counts).toEqual({ searches: 0, itemReads: 1, tokens: 1 });
  });

  it('caches the token until 60 s before expiry, then fetches a new one', async () => {
    const f = fake();
    const { client, clock } = make(f);
    await client.search('a', OPTS);
    clock.t += 7000_000; // 7000 s: still inside 7200 - 60
    await client.search('b', OPTS);
    expect(f.tokenCalls()).toHaveLength(1);
    clock.t += 200_000; // 7200 s total: inside the last 60 s
    await client.search('c', OPTS);
    expect(f.tokenCalls()).toHaveLength(2);
    expect((f.calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe('Bearer t2');
  });

  it('refetches the token once on a 401 and retries; a second 401 is an auth error', async () => {
    const f = fake([{ status: 401, body: {} }, { status: 200, body: SEARCH }]);
    const { client } = make(f);
    await expect(client.search('a', OPTS)).resolves.toBeTruthy();
    expect(f.tokenCalls()).toHaveLength(2);
    expect(client.counts.searches).toBe(1);

    const g = fake([{ status: 401, body: {} }, { status: 401, body: {} }]);
    await expect(make(g).client.search('a', OPTS)).rejects.toBeInstanceOf(EbayAuthError);
    expect(g.tokenCalls()).toHaveLength(2);
  });

  it('types 403, 429 and 5xx', async () => {
    await expect(make(fake([{ status: 403, body: {} }])).client.getItem('1')).rejects.toBeInstanceOf(EbayForbiddenError);
    await expect(make(fake([{ status: 429, body: {} }])).client.search('a', OPTS)).rejects.toBeInstanceOf(EbayRateLimitedError);
    const e = await make(fake([{ status: 503, body: {} }])).client.search('a', OPTS).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EbayServerError);
    expect((e as EbayServerError).status).toBe(503);
  });

  it('refuses beyond the caps before any network call, and counts calls', async () => {
    const f = fake();
    const { client } = make(f, { maxSearches: 2, maxItemReads: 0 });
    await client.search('a', OPTS);
    await client.search('b', OPTS);
    const before = f.calls.length;
    await expect(client.search('c', OPTS)).rejects.toBeInstanceOf(EbayCapError);
    await expect(client.getItem('1')).rejects.toBeInstanceOf(EbayCapError);
    expect(f.calls).toHaveLength(before);
    expect(client.counts.searches).toBe(2);
    expect(client.counts.itemReads).toBe(0);
  });

  it('never puts the keys or the token in a URL, an error message or a thrown error', async () => {
    const f = fake([{ status: 500, body: { errors: [{ message: `echo ${APP} ${CERT} t1` }] } }]);
    const { client } = make(f);
    const e = (await client.search('a', OPTS).catch((x: unknown) => x)) as Error;
    for (const c of f.calls) {
      expect(c.url).not.toContain(APP);
      expect(c.url).not.toContain(CERT);
      expect(c.url).not.toContain('t1');
    }
    expect(e.message + JSON.stringify(e)).not.toMatch(/secret|t1/);
  });

  it('a token request answered 429 or 5xx is a limit or a server error, not a refusal of the keys', async () => {
    const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    const caught = async (status: number) => (await new EbayClient({ appId: APP, certId: CERT, fetchFn: answer(status) }).search('a', OPTS).catch((x: unknown) => x)) as Error;
    expect(await caught(429)).toBeInstanceOf(EbayRateLimitedError);
    const e = await caught(503);
    expect(e).toBeInstanceOf(EbayServerError);
    expect((e as EbayServerError).status).toBe(503);
    expect(await caught(401)).toBeInstanceOf(EbayAuthError);
    expect(await caught(400)).toBeInstanceOf(EbayAuthError);
  });

  it('a failed token request is an auth error that names no key', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: `bad ${APP}` }), { status: 401 })) as unknown as typeof fetch;
    const e = (await new EbayClient({ appId: APP, certId: CERT, fetchFn }).search('a', OPTS).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(EbayAuthError);
    expect(e.message).not.toContain('secret');
  });
});
