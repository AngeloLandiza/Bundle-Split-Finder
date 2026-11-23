// Keepa client. Every paid call goes through here; nothing else reaches api.keepa.com.
// Works in Node (scripts, tests) and later in the extension worker (fetch + cache).

import { type Cache, type CacheEntry, MemoryCache } from '../serpapi/client';
import { type TokenBlockReason, TokenBudget, TOKEN_BLOCK_MESSAGE } from './budget';
import { parseProductResponse, parseSearchResponse } from './parse';
import type { KeepaMeta, KeepaProductResponse, KeepaSearchResponse, KeepaTrackingDepth } from './types';
import { KEEPA_DOMAIN_US } from './types';

const KEEPA_NETWORK = 'Network error reaching Keepa';

type KeepaParsed = { meta: KeepaMeta };

export class KeepaBudgetExceededError extends Error {
  constructor(public readonly reason: TokenBlockReason) {
    super(TOKEN_BLOCK_MESSAGE[reason]);
    this.name = 'KeepaBudgetExceededError';
  }
}

export class KeepaError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'KeepaError';
  }
}

export class KeepaRateLimitedError extends KeepaError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'KeepaRateLimitedError';
  }
}

export interface KeepaLedgerEntry {
  at: string;
  kind: 'product' | 'search';
  key: string;
  label: string;
  tokens: number;
  tokensLeft: number;
  refillIn: number;
}

export interface KeepaClientOptions {
  apiKey: string;
  budget: TokenBudget;
  cache?: Cache;
  fetchFn?: typeof fetch;
  onSpend?: (entry: KeepaLedgerEntry) => void | Promise<void>;
  now?: () => number;
  baseUrl?: string;
}

export interface KeepaRequestOptions {
  label?: string;
  maxAgeMs?: number;
  /** Tokens this call may cost; used only for blockReason before the first meta is known. */
  estimate?: number;
  trackingDepth?: KeepaTrackingDepth;
}

export interface KeepaResult<T> {
  data: T;
  source: 'cache' | 'network';
  at: number;
  meta: { tokensLeft: number; tokensConsumed: number };
  /** Full Keepa JSON body; present only on a network response (for fixture recording). */
  raw?: Record<string, unknown>;
}

function cacheKey(path: string, query: Record<string, string>): string {
  return `keepa:${path}?${Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&')}`;
}

export class KeepaClient {
  private readonly fetchFn: typeof fetch;
  private readonly cache: Cache;
  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(private readonly opts: KeepaClientOptions) {
    if (!opts.apiKey) throw new KeepaError('No Keepa key set.');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cache = opts.cache ?? new MemoryCache();
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? 'https://api.keepa.com';
  }

  async getProducts(
    asins: string[],
    domain = KEEPA_DOMAIN_US,
    options: KeepaRequestOptions = {},
  ): Promise<KeepaResult<KeepaProductResponse>> {
    if (asins.length === 0) throw new KeepaError('No ASINs to request.');
    const estimate = options.estimate ?? asins.length;
    // history=0 drops price-history arrays; enough for match fields and smaller fixtures.
    const query: Record<string, string> = { domain: String(domain), asin: asins.join(','), history: '0' };
    if (options.trackingDepth === 'price_and_rank' || options.trackingDepth === 'full') {
      query.stats = '180';
    }
    if (options.trackingDepth === 'full') {
      query.offers = '20';
    }
    return this.call('product', query, (body) => parseProductResponse(body), 'product', estimate, options);
  }

  async searchProducts(
    term: string,
    domain = KEEPA_DOMAIN_US,
    options: KeepaRequestOptions = {},
  ): Promise<KeepaResult<KeepaSearchResponse>> {
    const query = { domain: String(domain), type: 'product', term };
    return this.call('search', query, (body) => parseSearchResponse(body), 'search', options.estimate ?? 10, options);
  }

  private async call<T extends KeepaParsed>(
    path: string,
    query: Record<string, string>,
    parse: (body: Record<string, unknown>) => T,
    kind: KeepaLedgerEntry['kind'],
    estimate: number,
    options: KeepaRequestOptions,
  ): Promise<KeepaResult<T>> {
    const key = cacheKey(path, query);
    const cached = await this.cache.get(key);
    if (cached && (options.maxAgeMs === undefined || this.now() - cached.at <= options.maxAgeMs)) {
      const parsed = parse(cached.data as Record<string, unknown>);
      return {
        data: parsed,
        source: 'cache',
        at: cached.at,
        meta: { tokensLeft: parsed.meta.tokensLeft, tokensConsumed: 0 },
      };
    }

    const reason = this.opts.budget.blockReason(estimate);
    if (reason) throw new KeepaBudgetExceededError(reason);

    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('key', this.opts.apiKey);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await this.fetchFn(url.toString());
    } catch (err) {
      throw new KeepaError(`${KEEPA_NETWORK}: ${(err as Error).message}`);
    }
    if (res.status === 429) throw new KeepaRateLimitedError('Keepa refused the request: no tokens left or rate limited.');
    if (res.status === 401) throw new KeepaError('Keepa did not accept this key.', 401);
    if (!res.ok) throw new KeepaError(`Keepa returned HTTP ${res.status}.`, res.status);

    const body = (await res.json()) as Record<string, unknown>;
    const parsed = parse(body);
    if (parsed.meta.tokensConsumed > 0 || Number.isFinite(parsed.meta.tokensLeft)) {
      this.opts.budget.noteMeta(parsed.meta.tokensLeft, parsed.meta.tokensConsumed, parsed.meta.refillRate);
    }
    if (parsed.meta.error) throw new KeepaError(parsed.meta.error.message);

    await this.opts.onSpend?.({
      at: new Date(this.now()).toISOString(),
      kind,
      key,
      label: options.label ?? 'unlabelled',
      tokens: parsed.meta.tokensConsumed,
      tokensLeft: parsed.meta.tokensLeft,
      refillIn: parsed.meta.refillIn,
    });
    const at = this.now();
    const entry: CacheEntry = { at, data: body };
    await this.cache.set(key, entry);
    return {
      data: parsed,
      source: 'network',
      at,
      meta: { tokensLeft: parsed.meta.tokensLeft, tokensConsumed: parsed.meta.tokensConsumed },
      raw: body,
    };
  }
}