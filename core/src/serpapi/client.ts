// SerpApi client. Every paid search goes through search(), and search() refuses
// to run without room in the budget. There is no other way to reach the network.
//
// Runs in a Chrome extension service worker and in Node (tests, scripts): it
// only needs a fetch function, a cache and a budget.

import type { KeepaProduct } from '../keepa/types';
import { type AccountInfo, type BlockReason, BLOCK_MESSAGE, parseAccount, SearchBudget } from './budget';

export type Params = Record<string, string | number | boolean | undefined>;

export interface CacheEntry {
  at: number; // epoch ms when the response was stored
  data: unknown;
}

export interface Cache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export class MemoryCache implements Cache {
  private readonly map = new Map<string, CacheEntry>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, entry: CacheEntry) {
    this.map.set(key, entry);
  }
}

export interface LedgerEntry {
  at: string;
  engine: string;
  key: string;
  label: string;
}

export class BudgetExceededError extends Error {
  constructor(public readonly reason: BlockReason) {
    super(BLOCK_MESSAGE[reason]);
    this.name = 'BudgetExceededError';
  }
}

/** A network failure's message starts with this, then a colon and the reason. */
export const NETWORK_ERROR_PREFIX = 'Network error reaching SerpApi';
const ACCOUNT_UNREACHED = `${NETWORK_ERROR_PREFIX}: the account check got no answer.`;

export class SerpApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SerpApiError';
  }
}

/** HTTP 429: the hourly limit was hit or the account is out of searches. Not counted. */
export class RateLimitedError extends SerpApiError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'RateLimitedError';
  }
}

export interface ClientOptions {
  apiKey: string;
  budget: SearchBudget;
  cache?: Cache;
  fetchFn?: typeof fetch;
  /** Called once for every search that counted against the quota. */
  onSpend?: (entry: LedgerEntry) => void | Promise<void>;
  now?: () => number;
  baseUrl?: string;
}

/** Stable key for a search: same engine and parameters, in any order, give the same key. */
export function cacheKey(params: Params): string {
  return Object.keys(params)
    .filter((k) => k !== 'api_key' && k !== 'no_cache' && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
}

export interface SearchOptions {
  /** Shown in the ledger: which feature or test asked for this search. */
  label?: string;
  /** Accept a cached response up to this old. Default: forever (the caller decides when prices are stale). */
  maxAgeMs?: number;
}

export interface SearchResult {
  data: unknown;
  source: 'cache' | 'network';
  /** When this response was received from SerpApi, epoch ms. */
  at: number;
  /** Default serpapi: counts toward searchesUsed. Keepa product pulls use billAs keepa. */
  billAs?: 'serpapi' | 'keepa';
  /** Tokens charged when billAs is keepa and source is network. */
  keepaTokens?: number;
  /** Parsed Keepa product when the step used Keepa (for trend cache). */
  keepaProduct?: KeepaProduct;
}

export class SerpApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly cache: Cache;
  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(private readonly opts: ClientOptions) {
    if (!opts.apiKey) throw new SerpApiError('No SerpApi key set. Add your key in Settings.');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cache = opts.cache ?? new MemoryCache();
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? 'https://serpapi.com';
  }

  /**
   * Account status. Free: SerpApi does not count this call. A request that never reaches SerpApi
   * throws the network error a search throws, without the fetch error's own text: that text can
   * carry the request URL, and this URL holds the key.
   */
  static async account(apiKey: string, fetchFn: typeof fetch = fetch, baseUrl = 'https://serpapi.com'): Promise<AccountInfo> {
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}/account.json?api_key=${encodeURIComponent(apiKey)}`);
    } catch {
      throw new SerpApiError(ACCOUNT_UNREACHED);
    }
    if (res.status === 401) throw new SerpApiError('SerpApi did not accept this key.', 401);
    if (!res.ok) throw new SerpApiError(`SerpApi account check failed (HTTP ${res.status}).`, res.status);
    return parseAccount(await res.json());
  }

  async search(params: Params, options: SearchOptions = {}): Promise<SearchResult> {
    const key = cacheKey(params);
    const cached = await this.cache.get(key);
    if (cached && (options.maxAgeMs === undefined || this.now() - cached.at <= options.maxAgeMs)) {
      return { data: cached.data, source: 'cache', at: cached.at };
    }

    const reason = this.opts.budget.blockReason(1);
    if (reason) throw new BudgetExceededError(reason);

    const query = new URLSearchParams();
    for (const k of Object.keys(params).sort()) {
      if (params[k] !== undefined) query.set(k, String(params[k]));
    }
    query.set('api_key', this.opts.apiKey);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/search.json?${query.toString()}`);
    } catch (err) {
      throw new SerpApiError(`${NETWORK_ERROR_PREFIX}: ${(err as Error).message}`);
    }
    if (res.status === 429) throw new RateLimitedError('SerpApi refused the search: hourly limit reached or no searches left.');
    if (res.status === 401) throw new SerpApiError('SerpApi did not accept this key.', 401);
    if (!res.ok) throw new SerpApiError(`SerpApi returned HTTP ${res.status}.`, res.status);

    const data = (await res.json()) as Record<string, unknown>;
    const status = (data.search_metadata as Record<string, unknown> | undefined)?.status;
    if (status === 'Error') {
      // Errored searches are not counted by SerpApi, so the budget is not charged.
      throw new SerpApiError(typeof data.error === 'string' ? data.error : 'SerpApi search failed.');
    }

    // A successful search counts as 1, even when it returns no results.
    this.opts.budget.record(1);
    await this.opts.onSpend?.({
      at: new Date(this.now()).toISOString(),
      engine: String(params.engine ?? ''),
      key,
      label: options.label ?? 'unlabelled',
    });
    const at = this.now();
    await this.cache.set(key, { at, data });
    return { data, source: 'network', at };
  }
}
