// Keepa client. Every paid call goes through here; nothing else reaches api.keepa.com.
// Works in Node (scripts, tests) and later in the extension worker (fetch + cache).

import { type Cache, type CacheEntry, MemoryCache } from '../serpapi/client';
import { type TokenBlockReason, TokenBudget, TOKEN_BLOCK_MESSAGE } from './budget';
import { toUpc12 } from '../identifiers';
import { codeSampleOf, type KeepaCodeCost, type KeepaCodeSample, learnCodeCost } from './barcode';
import { KEEPA_CODE_BATCH_MAX, KEEPA_CODE_GUARD_TOKENS } from './estimates';
import { parseMeta, parseProductResponse, parseSearchResponse } from './parse';
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
  /** Nov 25: 'code' is a product request by barcode (productsByCode). */
  kind: 'product' | 'search' | 'code';
  key: string;
  label: string;
  tokens: number;
  tokensLeft: number;
  refillIn: number;
  /** Tokens the account refills a minute, as this answer said (recorded: 1). */
  refillRate?: number;
  /** Nov 25, a code request only: the codes asked and the products that came back, so its cost can be read per code. */
  codes?: number;
  products?: number;
}

export interface KeepaClientOptions {
  apiKey: string;
  budget: TokenBudget;
  cache?: Cache;
  fetchFn?: typeof fetch;
  onSpend?: (entry: KeepaLedgerEntry) => void | Promise<void>;
  now?: () => number;
  baseUrl?: string;
  /** Nov 25: what code requests have cost so far (the agent keeps it between runs); null or absent: not known yet. */
  codeCost?: KeepaCodeCost | null;
  /**
   * Nov 25: each code answer from the network, as a bounded sample (keepa/barcode.ts codeSampleOf: identity fields only,
   * never the key) with what it cost, so the first real responses can be kept and read through the audit export.
   */
  onCodeAnswer?: (sample: KeepaCodeSample, learned: KeepaCodeCost) => void | Promise<void>;
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
  private learned: KeepaCodeCost | null;

  constructor(private readonly opts: KeepaClientOptions) {
    if (!opts.apiKey) throw new KeepaError('No Keepa key set.');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cache = opts.cache ?? new MemoryCache();
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? 'https://api.keepa.com';
    this.learned = opts.codeCost ?? null;
  }

  /** Nov 25: what code requests have cost, as their responses said; null before the first. */
  get codeCost(): KeepaCodeCost | null {
    return this.learned;
  }

  /**
   * Nov 25: the tokens a code request for `codes` codes is held to before it is sent: the most a code has cost so far times
   * the codes (at least 1), or, before any response has said, KEEPA_CODE_GUARD_TOKENS each. Never a figure from the docs.
   */
  codeEstimate(codes: number): number {
    const n = Math.max(1, codes);
    if (this.learned === null) return n * KEEPA_CODE_GUARD_TOKENS;
    return Math.max(1, Math.ceil(this.learned.maxPerCode * n));
  }

  /**
   * Nov 25: Keepa's product request by `code` in place of `asin` (UPC, EAN, ISBN-13; "Multiple ASINs can have the same
   * product code, so requesting a product code can return multiple products"). Each code is normalised to a 12-digit UPC-A
   * (an invalid one is not sent), duplicates once, KEEPA_CODE_BATCH_MAX a request. Same query as getProducts (history=0,
   * stats=180), same cache, ledger (kind 'code'), budget and errors. The cost is the response's own `tokensConsumed`,
   * learned for the next estimate (codeEstimate). An answer with no `products`, or an empty list, is no product. Throws
   * what `call` throws; a batch refused by the budget throws before it is sent, with the earlier batches' tokens recorded.
   */
  async productsByCode(
    codes: readonly string[],
    domain = KEEPA_DOMAIN_US,
    options: Omit<KeepaRequestOptions, 'estimate' | 'trackingDepth'> = {},
  ): Promise<KeepaResult<KeepaProductResponse>> {
    const valid = [...new Set(codes.map((c) => toUpc12(c)).filter((c): c is string => c !== null))];
    if (valid.length === 0) throw new KeepaError('No valid barcode to request.');
    const products: KeepaProductResponse['products'] = [];
    let consumed = 0;
    let left = 0;
    let at = 0;
    let meta: KeepaMeta | null = null;
    let network = false;
    for (let i = 0; i < valid.length; i += KEEPA_CODE_BATCH_MAX) {
      const batch = valid.slice(i, i + KEEPA_CODE_BATCH_MAX);
      const query: Record<string, string> = { domain: String(domain), code: batch.join(','), history: '0', stats: '180' };
      const r = await this.call('product', query, (body) => parseProductResponse(body), 'code', this.codeEstimate(batch.length), options, {
        codes: batch.length,
        onAnswer: async (body, parsed) => {
          const learned = learnCodeCost(this.learned, batch.length, parsed.meta.tokensConsumed);
          this.learned = learned;
          await this.opts.onCodeAnswer?.(codeSampleOf(body, batch, this.now()), learned);
        },
      });
      for (const p of r.data.products) if (!products.some((x) => x.asin === p.asin)) products.push(p);
      consumed += r.meta.tokensConsumed;
      left = r.meta.tokensLeft;
      meta = r.data.meta;
      at = Math.max(at, r.at);
      if (r.source === 'network') network = true;
    }
    return {
      data: { meta: { ...meta!, tokensLeft: left, tokensConsumed: consumed }, products },
      source: network ? 'network' : 'cache',
      at,
      meta: { tokensLeft: left, tokensConsumed: consumed },
    };
  }

  async getProducts(
    asins: string[],
    domain = KEEPA_DOMAIN_US,
    options: KeepaRequestOptions = {},
  ): Promise<KeepaResult<KeepaProductResponse>> {
    if (asins.length === 0) throw new KeepaError('No ASINs to request.');
    const estimate = options.estimate ?? asins.length;
    // history=0 drops price-history arrays; enough for match fields and smaller fixtures. `stats` is sent at every
    // depth: the current Amazon / New price and sales rank are only in stats.current (no csv with history=0), and
    // keepa.com/api-docs/product.html (read Nov 23, 2026) says stats has "no extra token cost". Token cost per depth
    // is in estimates.ts.
    const query: Record<string, string> = { domain: String(domain), asin: asins.join(','), history: '0', stats: '180' };
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

  /**
   * Step 15: the account's token status, free (Keepa's `token` request consumes no tokens), never cached and never
   * refused by the budget. Its body carries the same meta fields as every other Keepa answer (parseMeta); the balance it
   * reports is noted on the budget like any other answer's, with nothing spent.
   */
  async tokenStatus(): Promise<{ tokensLeft: number; refillRate: number; refillIn: number }> {
    const url = new URL(`${this.baseUrl}/token`);
    url.searchParams.set('key', this.opts.apiKey);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString());
    } catch (err) {
      throw new KeepaError(`${KEEPA_NETWORK}: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new KeepaError('Keepa did not accept this key.', 401);
    if (!res.ok) throw new KeepaError(`Keepa returned HTTP ${res.status}.`, res.status);
    const meta = parseMeta((await res.json()) as Record<string, unknown>);
    if (meta.error) throw new KeepaError(meta.error.message);
    this.opts.budget.noteMeta(meta.tokensLeft, 0, meta.refillRate);
    return { tokensLeft: meta.tokensLeft, refillRate: meta.refillRate, refillIn: meta.refillIn };
  }

  private async call<T extends KeepaParsed>(
    path: string,
    query: Record<string, string>,
    parse: (body: Record<string, unknown>) => T,
    kind: KeepaLedgerEntry['kind'],
    estimate: number,
    options: KeepaRequestOptions,
    code?: { codes: number; onAnswer: (body: Record<string, unknown>, parsed: T) => Promise<void> },
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
      refillRate: parsed.meta.refillRate,
      ...(code ? { codes: code.codes, products: Array.isArray(body.products) ? body.products.length : 0 } : {}),
    });
    await code?.onAnswer(body, parsed);
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