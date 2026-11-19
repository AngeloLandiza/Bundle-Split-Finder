import { describe, expect, it } from 'vitest';
import { cachingTokenFetch, checkEbayKeys, type TokenStore } from './ebayEnv';
import type { CachedEbayToken } from './prefs';

// eBay's token kept in storage.session (a fake store here), and the check of the keys. No network.

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const POST = { method: 'POST', headers: { Authorization: 'Basic abc' }, body: 'grant_type=client_credentials' };

function store(initial: CachedEbayToken | null = null): TokenStore & { saved: CachedEbayToken | null } {
  const s = {
    saved: initial,
    get: async () => structuredClone(s.saved),
    set: async (t: CachedEbayToken) => void (s.saved = structuredClone(t)),
    clear: async () => void (s.saved = null),
  };
  return s;
}

const tokenAnswer = (token: string, expiresIn = 7200) => new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'Application Access Token' }), { status: 200 });

describe('cachingTokenFetch', () => {
  it('asks eBay when nothing is saved, and saves the token with its expiry', async () => {
    const s = store();
    let calls = 0;
    const f = cachingTokenFetch((async () => (calls += 1, tokenAnswer('t1'))) as typeof fetch, s, 'app', () => 1000);
    const res = await f(TOKEN_URL, POST);
    expect(((await res.json()) as { access_token: string }).access_token).toBe('t1');
    expect(calls).toBe(1);
    expect(s.saved).toEqual({ appId: 'app', token: 't1', expiresAt: 1000 + 7200_000 });
  });

  it('answers from the saved token while it has more than a minute left, in the shape eBay sends', async () => {
    const s = store({ appId: 'app', token: 'kept', expiresAt: 1000 + 3_600_000 });
    let calls = 0;
    const f = cachingTokenFetch((async () => (calls += 1, tokenAnswer('new'))) as typeof fetch, s, 'app', () => 1000);
    const body = (await (await f(TOKEN_URL, POST)).json()) as { access_token: string; expires_in: number };
    expect(body).toMatchObject({ access_token: 'kept', expires_in: 3600 });
    expect(calls).toBe(0);
  });

  it('asks again when the saved token is nearly out of time, or was granted for another App ID', async () => {
    for (const saved of [{ appId: 'app', token: 'old', expiresAt: 1000 + 30_000 }, { appId: 'other', token: 'old', expiresAt: 1000 + 3_600_000 }]) {
      const s = store(saved);
      const f = cachingTokenFetch((async () => tokenAnswer('fresh')) as typeof fetch, s, 'app', () => 1000);
      expect(((await (await f(TOKEN_URL, POST)).json()) as { access_token: string }).access_token).toBe('fresh');
      expect(s.saved?.token).toBe('fresh');
    }
  });

  it('saves nothing when eBay refuses, and a 401 on any other call drops the saved token', async () => {
    const s = store();
    const f = cachingTokenFetch((async () => new Response('{}', { status: 401 })) as typeof fetch, s, 'app', () => 1);
    expect((await f(TOKEN_URL, POST)).status).toBe(401);
    expect(s.saved).toBeNull();
    s.saved = { appId: 'app', token: 'x', expiresAt: 9e12 };
    await f('https://api.ebay.com/buy/browse/v1/item_summary/search?q=a', { headers: { Authorization: 'Bearer x' } });
    expect(s.saved).toBeNull();
    s.saved = { appId: 'app', token: 'x', expiresAt: 9e12 };
    const ok = cachingTokenFetch((async () => new Response('{}', { status: 200 })) as typeof fetch, s, 'app', () => 1);
    await ok('https://api.ebay.com/buy/browse/v1/item_summary/search?q=a', { headers: { Authorization: 'Bearer x' } });
    expect(s.saved?.token).toBe('x');
  });
});

describe('checkEbayKeys', () => {
  const keys = { appId: 'app', certId: 'cert-secret' };

  it('sends the keys only in the Authorization header of a POST to the token address, and saves the token it gets', async () => {
    const s = store();
    const seen: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => (seen.push({ url, init }), tokenAnswer('t'))) as typeof fetch;
    expect(await checkEbayKeys({ ...keys, fetchFn: f, store: s, now: () => 5 })).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(TOKEN_URL);
    expect(seen[0]!.init?.method).toBe('POST');
    expect((seen[0]!.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('app:cert-secret')}`);
    expect(JSON.stringify([seen[0]!.url, seen[0]!.init?.body])).not.toContain('cert-secret');
    expect(s.saved).toEqual({ appId: 'app', token: 't', expiresAt: 5 + 7200_000 });
  });

  it('says one plain sentence for a refusal, a server error and no answer; never eBay\'s body or the fetch error\'s words', async () => {
    const s = store();
    const answer = (status: number) => (async () => new Response(JSON.stringify({ error: 'invalid_client', note: 'cert-secret' }), { status })) as typeof fetch;
    expect(await checkEbayKeys({ ...keys, fetchFn: answer(401), store: s, now: () => 1 })).toBe('eBay did not accept this App ID and Cert ID.');
    expect(await checkEbayKeys({ ...keys, fetchFn: answer(503), store: s, now: () => 1 })).toBe('eBay had a server problem (HTTP 503). Try again later.');
    const down = (async () => { throw new TypeError('failed to fetch cert-secret'); }) as typeof fetch;
    expect(await checkEbayKeys({ ...keys, fetchFn: down, store: s, now: () => 1 })).toBe('eBay could not be reached. Check the connection, then try again.');
    expect(s.saved).toBeNull();
  });

  it('goes to the base URL it is given (the end-to-end build)', async () => {
    let url = '';
    const f = (async (u: string) => ((url = u), tokenAnswer('t'))) as typeof fetch;
    await checkEbayKeys({ ...keys, fetchFn: f, store: store(), now: () => 1, baseUrl: 'http://localhost:1' });
    expect(url).toBe('http://localhost:1/identity/v1/oauth2/token');
  });
});
