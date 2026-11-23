// What the worker adds around core's eBay client: eBay's access token kept in chrome.storage.session, and the
// check of the App ID and Cert ID that saves them. Nothing here logs, and nothing puts a key in a URL or a message.
//
// The App ID and Cert ID go only into the token request's Authorization header, to https://api.ebay.com (or the
// replay server in the end-to-end build, which the caller names). An answer carries the HTTP status, never the body.

import type { CachedEbayToken } from './prefs';

export const EBAY_HOST = 'https://api.ebay.com';
const TOKEN_PATH = '/identity/v1/oauth2/token';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
/** A cached token is not used when it has less than this left. */
const MARGIN_MS = 60_000;

export interface TokenStore {
  get(): Promise<CachedEbayToken | null>;
  set(token: CachedEbayToken): Promise<void>;
  clear(): Promise<void>;
}

const isTokenRequest = (input: Parameters<typeof fetch>[0], init?: RequestInit): boolean => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return (init?.method ?? 'GET').toUpperCase() === 'POST' && new URL(url).pathname === TOKEN_PATH;
};

/**
 * `inner`, except that a request for eBay's token is answered from the saved token while it is valid, and a fresh
 * token is saved. A request eBay answers 401 drops the saved token, so the client's one retry fetches a new one.
 * The answer to a cached request is the shape eBay sends (access_token, expires_in), so core's client reads it unchanged.
 */
export function cachingTokenFetch(inner: typeof fetch, store: TokenStore, appId: string, now: () => number): typeof fetch {
  return async (input, init) => {
    if (!isTokenRequest(input, init)) {
      const res = await inner(input, init);
      if (res.status === 401) await store.clear().catch(() => {});
      return res;
    }
    const saved = await store.get().catch(() => null);
    if (saved && saved.appId === appId && saved.expiresAt - MARGIN_MS > now()) {
      return new Response(JSON.stringify({ access_token: saved.token, expires_in: Math.floor((saved.expiresAt - now()) / 1000), token_type: 'Application Access Token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const res = await inner(input, init);
    if (res.ok) {
      const body = (await res.clone().json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token === 'string' && body.access_token !== '') {
        const secs = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 7200;
        await store.set({ appId, token: body.access_token, expiresAt: now() + secs * 1000 }).catch(() => {});
      }
    }
    return res;
  };
}

const base64 = (s: string): string => btoa(s);

/**
 * Asks eBay for a token with these keys (free; the grant is limited to 1,000 a day, and the token is saved so the
 * next scan does not ask again). Resolves to null when eBay gave one, or one plain sentence. Never the body.
 */
export async function checkEbayKeys(
  o: { appId: string; certId: string; fetchFn: typeof fetch; store: TokenStore; now: () => number; baseUrl?: string },
): Promise<string | null> {
  let res: Response;
  try {
    res = await o.fetchFn(`${o.baseUrl ?? EBAY_HOST}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${base64(`${o.appId}:${o.certId}`)}` },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    });
  } catch {
    return 'eBay could not be reached. Check the connection, then try again.';
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
  if (!res.ok || typeof body.access_token !== 'string' || body.access_token === '') {
    if (res.status >= 500) return `eBay had a server problem (HTTP ${res.status}). Try again later.`;
    // eBay's own reason, short and plain, with neither key in it.
    let said = [body.error, body.error_description].filter((v): v is string => typeof v === 'string' && v !== '').join(': ').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    for (const k of [o.appId, o.certId]) if (k.trim()) said = said.split(k.trim()).join('[key]');
    return `eBay did not accept this App ID and Cert ID. eBay answered ${said ? `${said} ` : ''}(HTTP ${res.status}).`;
  }
  const secs = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 7200;
  await o.store.set({ appId: o.appId, token: body.access_token, expiresAt: o.now() + secs * 1000 }).catch(() => {});
  return null;
}
