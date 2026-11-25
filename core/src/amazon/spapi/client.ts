// The one client for Amazon's Selling Partner API (docs/sp-api-notes-2026-11-25.md). Pure: fetch, the clock and the wait
// are injected; no node:* and no chrome.*. Read-only: every method reads; none lists, changes or orders anything.
//
// Rule 3: the four credentials go only to api.amazon.com (the token exchange: client id, secret, refresh token) and
// sellingpartnerapi-na.amazon.com (the access token in its header, the seller id in the restrictions query). A fetch
// error's own text is never used (it can carry the address); every message that leaves goes through scrubSp, which takes
// out every credential and the access token, as they are and URL-encoded, before the text is cut.
//
// Pace: SpLimiter (per operation, at or below the documented rates, and a cap a day). A 429 or a 5xx gets one wait, as
// Amazon's headers say (Retry-After, else x-amzn-RateLimit-Limit), and one more try; never a loop.

import { SpDailyCapError, SpLimiter, type LimiterDeps } from './limiter';
import { parseEligibility, parseFeesBatch, parseOrderMetrics, parseRestrictions, SpParseError } from './parse';
import {
  FEES_BATCH_MAX,
  LWA_TOKEN_URL,
  SAMPLE_CHARS,
  SAMPLES_PER_OPERATION,
  SP_API_BASE,
  TOKEN_MARGIN_MS,
  US_MARKETPLACE_ID,
  type EligibilityResult,
  type FeesResult,
  type OrderMetric,
  type RestrictionsResult,
  type SellerCredentials,
  type SpCallRow,
  type SpOperation,
  type SpSample,
} from './types';

/**
 * rejected  Amazon did not accept the credentials (the token exchange refused them, or a 401)
 * denied    the credentials work but this call is not allowed (403: a role missing, or the seller id is not his)
 * limit     Amazon asked to slow down, and the one wait did not help
 * service   Amazon had a problem (5xx), or answered with a status this app does not expect
 * network   Amazon could not be reached
 * cap       the app's own cap a day for the operation is reached
 * unreadable  the answer came but could not be read
 */
export type SpErrorKind = 'rejected' | 'denied' | 'limit' | 'service' | 'network' | 'cap' | 'unreadable';

export class SpApiError extends Error {
  constructor(readonly kind: SpErrorKind, message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'SpApiError';
  }
}

export interface SpClientOptions {
  credentials: SellerCredentials;
  fetchFn: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** "SplitFinder/0.1.4 (Language=TypeScript)"; Amazon requires a user-agent naming the app and its language. */
  userAgent?: string;
  limiter?: SpLimiter;
  limits?: Omit<LimiterDeps, 'now' | 'sleep'>;
  /** Every call made, for the ledger (spapi-ledger.jsonl). Never given an address or a key. */
  onCall?: (row: SpCallRow) => void;
  /** The first responses per operation, scrubbed and bounded, for the audit export. */
  onSample?: (sample: SpSample) => void;
  /** Samples already kept per operation (so a restart does not keep more than SAMPLES_PER_OPERATION). */
  samplesKept?: Partial<Record<SpCallRow['op'], number>>;
  /** Tests: the two addresses. */
  tokenUrl?: string;
  baseUrl?: string;
  marketplaceId?: string;
}

/** The longest wait the one backoff takes; Amazon asking for more is a limit, said as such. */
export const MAX_BACKOFF_MS = 30_000;

const SECRET_FIELD = /token|secret|password|seller.?id|merchant|client.?id|authorization/i;

/** Every value that must never appear in a message, a log or a sample: each credential and the access token, plain and URL-encoded. */
export function spSecrets(c: Partial<SellerCredentials>, accessToken?: string | null): string[] {
  const out = new Set<string>();
  for (const v of [c.clientId, c.clientSecret, c.refreshToken, c.sellerId, accessToken ?? undefined]) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length < 4) continue;
    out.add(t);
    out.add(encodeURIComponent(t));
    out.add(encodeURIComponent(t).replace(/%20/g, '+'));
  }
  return [...out].sort((a, z) => z.length - a.length);
}

/** Control characters to spaces, every secret to "[key]", and only then cut to `max`. */
export function scrubSp(textIn: string, secrets: readonly string[], max = 300): string {
  let t = String(textIn).replace(/[\u0000-\u001f\u007f]/g, ' ');
  for (const s of secrets) t = t.split(s).join('[key]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A body with every field whose name looks like a credential or a seller id replaced, at any depth. */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 12) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).slice(0, 80).map(([k, x]) => [k, SECRET_FIELD.test(k) ? '[removed]' : redact(x, depth + 1)]));
  }
  return v;
}

/** Amazon's own words from an error body: SP-API `{ errors: [{ code, message }] }` or LWA `{ error, error_description }`. */
function amazonSaid(body: unknown): { code: string; message: string } {
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!rec(body)) return { code: '', message: '' };
  const first = Array.isArray(body.errors) && rec(body.errors[0]) ? body.errors[0] : null;
  if (first) return { code: typeof first.code === 'string' ? first.code : '', message: typeof first.message === 'string' ? first.message : '' };
  return { code: typeof body.error === 'string' ? body.error : '', message: typeof body.error_description === 'string' ? body.error_description : '' };
}

/** x-amz-date: yyyyMMddTHHmmssZ. */
const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SpApiClient {
  private token: { value: string; until: number } | null = null;
  private pendingToken: Promise<string> | null = null;
  readonly limiter: SpLimiter;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly samples = new Map<SpCallRow['op'], number>();

  constructor(private readonly o: SpClientOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? realSleep;
    this.limiter = o.limiter ?? new SpLimiter({ now: this.now, sleep: this.sleep, ...(o.limits ?? {}) });
    for (const [op, n] of Object.entries(o.samplesKept ?? {})) this.samples.set(op as SpCallRow['op'], n ?? 0);
  }

  private get marketplace(): string {
    return this.o.marketplaceId ?? US_MARKETPLACE_ID;
  }

  /** Every secret this client holds now. */
  secrets(): string[] {
    return spSecrets(this.o.credentials, this.token?.value);
  }

  private scrub(t: string, max = 300): string {
    return scrubSp(t, this.secrets(), max);
  }

  private fail(kind: SpErrorKind, message: string, status: number | null = null): SpApiError {
    return new SpApiError(kind, this.scrub(message), status);
  }

  private sample(op: SpCallRow['op'], status: number, body: unknown): void {
    if (!this.o.onSample) return;
    const n = this.samples.get(op) ?? 0;
    if (n >= SAMPLES_PER_OPERATION) return;
    this.samples.set(op, n + 1);
    let textBody: string;
    try {
      textBody = JSON.stringify(redact(body)) ?? 'null';
    } catch {
      textBody = '"[not JSON]"';
    }
    try {
      this.o.onSample({ op, at: new Date(this.now()).toISOString(), status, body: scrubSp(textBody, this.secrets(), SAMPLE_CHARS) });
    } catch {
      // A sample that cannot be kept changes nothing.
    }
  }

  private record(op: SpCallRow['op'], status: number | null, items: number): void {
    try {
      this.o.onCall?.({ at: new Date(this.now()).toISOString(), op, status, items });
    } catch {
      // The ledger is a record; a failed write never fails the call.
    }
  }

  // ------------------------------------------------------------ the token

  /** An access token, from the cache while it has more than TOKEN_MARGIN_MS left, else from the exchange. */
  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.until) return this.token.value;
    // Two callers at once share one exchange.
    this.pendingToken ??= this.exchange().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  /** Forgets the cached access token (a 401 on a call: it is asked for again once). */
  forgetToken(): void {
    this.token = null;
  }

  private async exchange(): Promise<string> {
    const c = this.o.credentials;
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken.trim(), client_id: c.clientId.trim(), client_secret: c.clientSecret.trim() });
    let res: Response;
    try {
      res = await this.o.fetchFn(this.o.tokenUrl ?? LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', ...(this.o.userAgent ? { 'user-agent': this.o.userAgent } : {}) },
        body: form.toString(),
        redirect: 'error',
      });
    } catch {
      this.record('token', null, 0);
      throw this.fail('network', 'Could not reach Amazon (api.amazon.com)');
    }
    this.record('token', res.status, 0);
    const body = await res.json().catch(() => undefined);
    this.sample('token', res.status, body);
    const b = body as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (res.ok && typeof b?.access_token === 'string' && b.access_token.length > 0) {
      const life = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in * 1000 : 3_600_000;
      this.token = { value: b.access_token, until: this.now() + Math.max(0, life - TOKEN_MARGIN_MS) };
      return b.access_token;
    }
    const said = amazonSaid(body);
    const words = [said.code, said.message].filter(Boolean).join(': ');
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const what = said.code === 'invalid_client'
        ? 'Check the client id and client secret (Develop Apps, View, LWA credentials).'
        : said.code === 'invalid_grant'
          ? 'The refresh token is not valid: make a new one with Authorize app in Develop Apps.'
          : 'Check the client id, client secret and refresh token.';
      throw this.fail('rejected', `Amazon did not accept these credentials${words ? ` (${words})` : ''} (HTTP ${res.status}). ${what}`, res.status);
    }
    if (res.status === 429) throw this.fail('limit', 'Amazon is limiting sign-ins (HTTP 429)', 429);
    if (res.ok) throw this.fail('unreadable', 'Amazon answered the sign-in in a way this app could not read', res.status);
    throw this.fail('service', `Amazon had a problem signing in (HTTP ${res.status})`, res.status);
  }

  // ------------------------------------------------------------ one call

  /** How long Amazon asked to wait, from its headers; null when it said nothing usable. */
  private waitFrom(res: Response, op: SpOperation): number {
    const after = res.headers.get('retry-after');
    if (after !== null && /^\d+(\.\d+)?$/.test(after.trim())) return Math.ceil(Number(after) * 1000);
    const limit = res.headers.get('x-amzn-ratelimit-limit');
    if (limit !== null && Number(limit) > 0) return Math.ceil(1000 / Number(limit));
    return this.limiter.intervalMs(op) * 2;
  }

  private async call(op: SpOperation, path: string, init: { method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown }, items: number): Promise<unknown> {
    const url = `${this.o.baseUrl ?? SP_API_BASE}${path}${init.query ? `?${new URLSearchParams(init.query).toString()}` : ''}`;
    let waited = false;
    let wait = 0;
    let retriedAuth = false;
    for (;;) {
      try {
        await this.limiter.take(op, wait);
      } catch (err) {
        if (err instanceof SpDailyCapError) throw new SpApiError('cap', err.message);
        throw err;
      }
      const token = await this.accessToken();
      let res: Response;
      try {
        // fetch sets the host header from the address; Amazon's other required headers are set here.
        res = await this.o.fetchFn(url, {
          method: init.method,
          headers: {
            'x-amz-access-token': token,
            'x-amz-date': amzDate(this.now()),
            accept: 'application/json',
            ...(this.o.userAgent ? { 'user-agent': this.o.userAgent } : {}),
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          redirect: 'error',
        });
      } catch {
        this.record(op, null, items);
        throw this.fail('network', 'Could not reach Amazon (sellingpartnerapi-na.amazon.com)');
      }
      this.record(op, res.status, items);
      const body = await res.json().catch(() => undefined);
      this.sample(op, res.status, body);
      if (res.ok) return body;
      if (res.status === 401 && !retriedAuth) {
        // The token may have ended early: one new exchange, one more try.
        retriedAuth = true;
        this.forgetToken();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && !waited) {
        wait = this.waitFrom(res, op);
        if (wait <= MAX_BACKOFF_MS) {
          waited = true;
          continue;
        }
      }
      const said = amazonSaid(body);
      const words = [said.code, said.message].filter(Boolean).join(': ');
      const tail = words ? `: ${words}` : '';
      if (res.status === 401) throw this.fail('rejected', `Amazon did not accept the access${tail} (HTTP 401)`, 401);
      if (res.status === 403) throw this.fail('denied', `Amazon refused this call${tail} (HTTP 403). Check that your app has the roles Product Listing and Amazon Fulfillment, and that the seller id is yours.`, 403);
      if (res.status === 429) throw this.fail('limit', `Amazon is limiting calls (HTTP 429)`, 429);
      if (res.status === 400 || res.status === 404) throw this.fail('denied', `Amazon did not take the request${tail} (HTTP ${res.status})`, res.status);
      throw this.fail('service', `Amazon had a problem${tail} (HTTP ${res.status})`, res.status);
    }
  }

  private parsed<T>(f: () => T): T {
    try {
      return f();
    } catch (err) {
      if (err instanceof SpParseError) throw this.fail('unreadable', err.message);
      throw err;
    }
  }

  // ------------------------------------------------------------ the four reads

  /** May he list `asin` new? Listings Restrictions, conditionType new_new, reasons in US English. */
  async restrictions(asin: string): Promise<RestrictionsResult> {
    const body = await this.call('restrictions', '/listings/2021-08-01/restrictions', {
      method: 'GET',
      query: { asin, sellerId: this.o.credentials.sellerId.trim(), marketplaceIds: this.marketplace, conditionType: 'new_new', reasonLocale: 'en_US' },
    }, 1);
    return this.parsed(() => parseRestrictions(asin, body));
  }

  /** Will FBA take `asin`? FBA Inbound Eligibility, program INBOUND. */
  async eligibility(asin: string): Promise<EligibilityResult> {
    const body = await this.call('eligibility', '/fba/inbound/v1/eligibility/itemPreview', { method: 'GET', query: { asin, program: 'INBOUND', marketplaceIds: this.marketplace } }, 1);
    return this.parsed(() => parseEligibility(asin, body));
  }

  /**
   * Amazon's fee estimate for each ASIN at its price, sold through FBA (IsAmazonFulfilled true). Up to FEES_BATCH_MAX in
   * one call; more are sent in further calls, each paced.
   */
  async fees(items: readonly { asin: string; price: number }[]): Promise<FeesResult[]> {
    const out: FeesResult[] = [];
    for (let i = 0; i < items.length; i += FEES_BATCH_MAX) {
      const batch = items.slice(i, i + FEES_BATCH_MAX);
      const body = await this.call('fees', '/products/fees/v0/feesEstimate', {
        method: 'POST',
        body: batch.map((it) => ({
          IdType: 'ASIN',
          IdValue: it.asin,
          FeesEstimateRequest: {
            MarketplaceId: this.marketplace,
            IsAmazonFulfilled: true,
            PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: it.price }, Shipping: { CurrencyCode: 'USD', Amount: 0 } },
            Identifier: `split-finder-${it.asin}`,
          },
        })),
      }, batch.length);
      out.push(...this.parsed(() => parseFeesBatch(batch, body)));
    }
    return out;
  }

  /**
   * Sales getOrderMetrics by ASIN and day (the seam for outcomes; not wired yet: the owner deferred it to the trial).
   * `interval`: "2026-11-01T00:00:00-08:00--2026-11-25T00:00:00-08:00"; `timeZone`: an IANA name ("US/Pacific").
   */
  async orderMetrics(q: { asin: string; interval: string; timeZone: string }): Promise<OrderMetric[]> {
    const body = await this.call('sales', '/sales/v1/orderMetrics', {
      method: 'GET',
      query: { marketplaceIds: this.marketplace, interval: q.interval, granularity: 'Day', granularityTimeZone: q.timeZone, asin: q.asin },
    }, 1);
    return this.parsed(() => parseOrderMetrics(body));
  }
}
