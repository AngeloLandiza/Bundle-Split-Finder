// eBay Browse API client. Runs in the extension service worker and in Node: it needs only a fetch
// function and a clock. It reads no environment and writes no log.
//
// Keys and tokens: the App ID and Cert ID go only into the token request's Authorization header; the
// token only into a Bearer header. Neither is ever put in a URL, an error message or a log line, and
// an error carries the HTTP status, never the response body (a body can echo a credential).
//
// Responses go through parseSearch / parseItem, so a seller or buyer field is never kept.

import { parseItem, parseOffer, parseSearch, type EbayOffer } from './parse';
import type { EbayListing, EbayListingSummary } from './types';

const HOST = 'https://api.ebay.com';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
/** The token is treated as expired this long before eBay says it is. */
const EXPIRY_MARGIN_MS = 60_000;

export class EbayError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'EbayError';
  }
}
/** The token request failed, or a call was refused as unauthorised even with a fresh token. */
export class EbayAuthError extends EbayError {
  /** One plain sentence saying what eBay answered (its own error and description, scrubbed of the keys); no key in it. */
  readonly detail: string;
  constructor(message: string, status?: number, detail?: string) { super(message, status); this.name = 'EbayAuthError'; this.detail = detail ?? message; }
}
/** HTTP 403: the keys lack permission for this call. */
export class EbayForbiddenError extends EbayError {
  constructor(message: string) { super(message, 403); this.name = 'EbayForbiddenError'; }
}
/** HTTP 429: eBay's call limit. */
export class EbayRateLimitedError extends EbayError {
  constructor(message: string) { super(message, 429); this.name = 'EbayRateLimitedError'; }
}
export class EbayServerError extends EbayError {
  constructor(message: string, status: number) { super(message, status); this.name = 'EbayServerError'; }
}
/** This client's own cap on searches or item reads was reached; nothing was sent. */
export class EbayCapError extends EbayError {
  constructor(public readonly kind: 'searches' | 'item reads', public readonly cap: number) {
    super(`eBay ${kind} cap of ${cap} reached for this run; no call was made.`);
    this.name = 'EbayCapError';
  }
}

export interface EbayClientOptions {
  appId: string;
  certId: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Per-instance caps; default none. */
  maxSearches?: number;
  maxItemReads?: number;
  baseUrl?: string;
}

export interface EbaySearchOptions {
  categoryIds?: string[];
  /** Only New listings (conditionIds 1000). */
  conditionNew?: boolean;
  /** Only fixed-price listings. */
  fixedPrice?: boolean;
  limit?: number;
}

export interface EbaySearchResult {
  /** eBay's count of matching listings (may exceed the summaries returned). */
  total: number;
  summaries: EbayListingSummary[];
}

function base64(s: string): string {
  if (typeof btoa === 'function') return btoa(s);
  return Buffer.from(s).toString('base64');
}

export class EbayClient {
  private readonly appId: string;
  private readonly certId: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly host: string;
  private readonly maxSearches: number;
  private readonly maxItemReads: number;
  private token: { value: string; expiresAt: number } | null = null;
  readonly counts = { searches: 0, itemReads: 0, tokens: 0 };

  constructor(o: EbayClientOptions) {
    this.appId = o.appId;
    this.certId = o.certId;
    this.fetchFn = o.fetchFn ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.host = o.baseUrl ?? HOST;
    this.maxSearches = o.maxSearches ?? Infinity;
    this.maxItemReads = o.maxItemReads ?? Infinity;
  }

  private async getToken(force: boolean): Promise<string> {
    if (!force && this.token && this.now() < this.token.expiresAt) return this.token.value;
    this.token = null;
    this.counts.tokens += 1;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.host}/identity/v1/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + base64(`${this.appId}:${this.certId}`) },
        body: 'grant_type=client_credentials&scope=' + encodeURIComponent(SCOPE),
      });
    } catch {
      throw new EbayError('Network error reaching eBay for a token.');
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
    // The status says what went wrong: a limit or an eBay outage is not the keys' fault, and must not read as if it were.
    if (res.status === 429) throw new EbayRateLimitedError('eBay is limiting calls (HTTP 429).');
    if (res.status >= 500) throw new EbayServerError(`eBay had a server problem (HTTP ${res.status}).`, res.status);
    if (!res.ok || typeof json.access_token !== 'string') {
      const detail = this.answered(res.status, json);
      throw new EbayAuthError(`eBay refused the token request (HTTP ${res.status}). Check the App ID and Cert ID.`, res.status, detail);
    }
    const secs = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 7200;
    this.token = { value: json.access_token, expiresAt: this.now() + secs * 1000 - EXPIRY_MARGIN_MS };
    return json.access_token;
  }

  /**
   * Nov 23: asks eBay for a fresh token and keeps nothing else: the free check of the App ID and Cert ID (Settings, Keys).
   * Throws what a token request throws: EbayAuthError (its `detail` is eBay's own words), EbayRateLimitedError,
   * EbayServerError, or EbayError for no answer.
   */
  async verifyKeys(): Promise<void> {
    await this.getToken(true);
  }

  /** What eBay answered, in one sentence: its `error` code and `error_description` (short, plain characters only), the HTTP status, and neither key. */
  private answered(status: number, json: { error?: unknown; error_description?: unknown }): string {
    const clean = (v: unknown): string => {
      if (typeof v !== 'string') return '';
      // The keys (and the Basic credential they make) come out before the text is cut: a key cut in half by the limit
      // would no longer match, and its first half would stay (security review, Nov 23).
      let t = v.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
      for (const k of [base64(`${this.appId}:${this.certId}`), this.appId, this.certId]) if (k.trim()) t = t.split(k.trim()).join('[key]');
      return t.slice(0, 200);
    };
    const code = clean(json.error);
    const why = clean(json.error_description);
    const said = code && why ? `${code}: ${why}` : code || why;
    return said ? `eBay answered ${said} (HTTP ${status}).` : `eBay answered HTTP ${status} with no reason given.`;
  }

  /** One authorised GET. A 401 drops the token, fetches a new one and retries once. */
  private async get(path: string): Promise<unknown> {
    const url = `${this.host}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken(attempt > 0);
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
      } catch {
        throw new EbayError('Network error reaching eBay.');
      }
      if (res.status === 401) {
        this.token = null;
        if (attempt === 0) continue;
        throw new EbayAuthError('eBay refused the token again (HTTP 401).', 401, 'eBay gave a token but then refused it on the search itself (HTTP 401).');
      }
      if (res.status === 403) throw new EbayForbiddenError('eBay says these keys may not make this call (HTTP 403).');
      if (res.status === 429) throw new EbayRateLimitedError('eBay is limiting calls (HTTP 429).');
      if (res.status >= 500) throw new EbayServerError(`eBay had a server problem (HTTP ${res.status}).`, res.status);
      if (!res.ok) throw new EbayError(`eBay answered HTTP ${res.status}.`, res.status);
      return res.json().catch(() => {
        throw new EbayError('eBay sent a response that is not JSON.', res.status);
      });
    }
    throw new EbayAuthError('eBay refused the token again (HTTP 401).', 401, 'eBay gave a token but then refused it on the search itself (HTTP 401).');
  }

  async search(query: string, opts: EbaySearchOptions = {}): Promise<EbaySearchResult> {
    if (this.counts.searches >= this.maxSearches) throw new EbayCapError('searches', this.maxSearches);
    this.counts.searches += 1;
    const filters: string[] = [];
    if (opts.conditionNew) filters.push('conditionIds:{1000}');
    if (opts.fixedPrice) filters.push('buyingOptions:{FIXED_PRICE}');
    const q = new URLSearchParams({ q: query });
    if (filters.length) q.set('filter', filters.join(','));
    if (opts.categoryIds?.length) q.set('category_ids', opts.categoryIds.join(','));
    if (opts.limit) q.set('limit', String(opts.limit));
    const json = await this.get(`/buy/browse/v1/item_summary/search?${q}`);
    const total = typeof (json as { total?: unknown } | null)?.total === 'number' ? (json as { total: number }).total : 0;
    return { total, summaries: parseSearch(json) };
  }

  async getItem(itemId: string): Promise<EbayListing> {
    if (this.counts.itemReads >= this.maxItemReads) throw new EbayCapError('item reads', this.maxItemReads);
    this.counts.itemReads += 1;
    return parseItem(await this.get(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`));
  }

  /**
   * The owner's pasted eBay link: one item read by the number in the link (Browse getItemByLegacyId, free), as the offer
   * he could buy now. Counts as an item read like getItem. An item eBay no longer has is an EbayError with status 404.
   */
  async getOfferByLegacyId(legacyItemId: string): Promise<EbayOffer> {
    if (this.counts.itemReads >= this.maxItemReads) throw new EbayCapError('item reads', this.maxItemReads);
    this.counts.itemReads += 1;
    const q = new URLSearchParams({ legacy_item_id: legacyItemId });
    return parseOffer(await this.get(`/buy/browse/v1/item/get_item_by_legacy_id?${q}`), this.now());
  }
}
