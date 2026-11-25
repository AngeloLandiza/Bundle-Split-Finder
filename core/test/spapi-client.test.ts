// Amazon's Selling Partner API client, read-only (docs/sp-api-notes-2026-11-25.md). A fake fetch built from the model
// shapes in the notes; no network. Nothing here was answered by Amazon: the first real responses are kept as samples and
// these shapes corrected from them.

import { describe, expect, it } from 'vitest';

import { scrubSp, SpApiClient, SpApiError, spSecrets } from '../src/amazon/spapi/client';
import { SpLimiter } from '../src/amazon/spapi/limiter';
import { parseEligibility, parseFeesBatch, parseOrderMetrics, parseRestrictions, sellerCentralLink } from '../src/amazon/spapi/parse';
import type { SellerCredentials, SpCallRow, SpSample } from '../src/amazon/spapi/types';
import { fbaReasonWords } from '../src/amazon/spapi/words';

const CREDS: SellerCredentials = {
  clientId: 'amzn1.application-oa2-client.0123456789abcdef0123456789abcdef',
  clientSecret: 'amzn1.oa2-cs.v1.fedcba9876543210fedcba9876543210fedcba9876543210',
  refreshToken: 'Atzr|IwEBIExampleRefreshToken+with/slashes=and=pluses+0123456789',
  sellerId: 'A1B2C3D4E5F6G7',
};
const ACCESS = 'Atza|IwEBIExampleAccessToken0123456789abcdef';
const PBP004 = 'B09HDZ5MPV';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  at: number;
}

/** A clock that only moves when the client waits, and a fetch that answers by path and records every call. */
function harness(route: (url: URL, init: RequestInit | undefined, n: number) => Response | Promise<Response>) {
  let now = Date.parse('2026-11-25T18:00:00Z');
  const calls: Call[] = [];
  const waits: number[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers: { ...(init?.headers as Record<string, string> | undefined) }, body: init?.body === undefined ? undefined : String(init.body), at: now });
    return route(url, init, calls.length);
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    waits.push(ms);
    now += ms;
  };
  const rows: SpCallRow[] = [];
  const samples: SpSample[] = [];
  const client = new SpApiClient({
    credentials: CREDS, fetchFn, now: () => now, sleep, userAgent: 'SplitFinder/1.0 (Language=TypeScript)',
    onCall: (r) => rows.push(r), onSample: (s) => samples.push(s),
  });
  return { client, calls, waits, rows, samples, advance: (ms: number) => (now += ms), now: () => now };
}

const tokenOk = (life = 3600) => json(200, { access_token: ACCESS, refresh_token: CREDS.refreshToken, token_type: 'bearer', expires_in: life });

/** The answers the models describe, one per path. */
function amazon(over: Partial<Record<string, (url: URL, init: RequestInit | undefined) => Response>> = {}) {
  return (url: URL, init: RequestInit | undefined): Response => {
    const key = `${url.host}${url.pathname}`;
    const h = over[key];
    if (h) return h(url, init);
    if (key === 'api.amazon.com/auth/o2/token') return tokenOk();
    if (key === 'sellingpartnerapi-na.amazon.com/listings/2021-08-01/restrictions') return json(200, { restrictions: [] });
    if (key === 'sellingpartnerapi-na.amazon.com/fba/inbound/v1/eligibility/itemPreview') return json(200, { payload: { asin: url.searchParams.get('asin'), program: 'INBOUND', isEligibleForProgram: true } });
    throw new Error(`no route for ${key}`);
  };
}

describe('the token: exchanged once, cached for its life less a margin, asked again after', () => {
  it('sends the refresh grant form to api.amazon.com only, and the access token in its header to the SP-API host', async () => {
    const h = harness(amazon());
    await h.client.restrictions(PBP004);
    const [token, call] = h.calls;
    expect(token!.url.href).toBe('https://api.amazon.com/auth/o2/token');
    expect(token!.method).toBe('POST');
    expect(token!.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(token!.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', refresh_token: CREDS.refreshToken, client_id: CREDS.clientId, client_secret: CREDS.clientSecret });
    expect(call!.url.host).toBe('sellingpartnerapi-na.amazon.com');
    expect(call!.headers['x-amz-access-token']).toBe(ACCESS);
    expect(call!.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(call!.headers['user-agent']).toBe('SplitFinder/1.0 (Language=TypeScript)');
    expect(Object.fromEntries(call!.url.searchParams)).toEqual({ asin: PBP004, sellerId: CREDS.sellerId, marketplaceIds: 'ATVPDKIKX0DER', conditionType: 'new_new', reasonLocale: 'en_US' });
    // No credential but the access token (and the seller id in the restrictions query) ever reaches the SP-API host.
    expect(JSON.stringify(call)).not.toContain(CREDS.clientSecret);
    expect(JSON.stringify(call)).not.toContain(CREDS.refreshToken);
  });

  it('reuses the token for its life less five minutes, then exchanges again', async () => {
    const h = harness(amazon());
    await h.client.restrictions(PBP004);
    h.advance(54 * 60_000);
    await h.client.restrictions(PBP004);
    expect(h.calls.filter((c) => c.url.host === 'api.amazon.com')).toHaveLength(1);
    h.advance(2 * 60_000); // 56 minutes: inside the 5-minute margin of a 60-minute token
    await h.client.restrictions(PBP004);
    expect(h.calls.filter((c) => c.url.host === 'api.amazon.com')).toHaveLength(2);
  });

  it('a 401 on a call forgets the token and exchanges once more, then tries once', async () => {
    let first = true;
    const h = harness(amazon({
      'sellingpartnerapi-na.amazon.com/listings/2021-08-01/restrictions': () => {
        if (first) {
          first = false;
          return json(401, { errors: [{ code: 'Unauthorized', message: 'The access token you provided has expired.' }] });
        }
        return json(200, { restrictions: [] });
      },
    }));
    expect((await h.client.restrictions(PBP004)).status).toBe('allowed');
    expect(h.calls.filter((c) => c.url.host === 'api.amazon.com')).toHaveLength(2);
  });

  it("a refused refresh token says so in the owner's words, with no credential in it", async () => {
    const h = harness(amazon({
      'api.amazon.com/auth/o2/token': () => json(400, { error: 'invalid_grant', error_description: `The request has an invalid grant parameter : refresh_token ${CREDS.refreshToken}` }),
    }));
    const err = await h.client.restrictions(PBP004).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpApiError);
    expect(err).toMatchObject({ kind: 'rejected', status: 400 });
    expect((err as Error).message).toContain('make a new one with Authorize app');
    for (const s of Object.values(CREDS)) expect((err as Error).message).not.toContain(s);
    expect((err as Error).message).toContain('[key]');
  });

  it('a wrong client id or secret names those', async () => {
    const h = harness(amazon({ 'api.amazon.com/auth/o2/token': () => json(401, { error: 'invalid_client', error_description: 'Client authentication failed' }) }));
    await expect(h.client.accessToken()).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('client id and client secret') });
  });
});

describe('a secret never appears in an error', () => {
  it('a network failure says only that Amazon could not be reached, whatever the fetch error carried', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      throw new Error(`connect ECONNREFUSED while fetching ${String(input)} with ${CREDS.clientSecret}`);
    }) as unknown as typeof fetch;
    const c = new SpApiClient({ credentials: CREDS, fetchFn, sleep: async () => {} });
    const err = (await c.accessToken().catch((e: unknown) => e)) as SpApiError;
    expect(err.kind).toBe('network');
    expect(err.message).toBe('Could not reach Amazon (api.amazon.com)');
  });

  it("Amazon's error text that echoes the seller id, the access token or a URL-encoded refresh token is scrubbed", async () => {
    const h = harness(amazon({
      'sellingpartnerapi-na.amazon.com/listings/2021-08-01/restrictions': () =>
        json(403, { errors: [{ code: 'Unauthorized', message: `Access denied for seller ${CREDS.sellerId} token ${ACCESS} ${encodeURIComponent(CREDS.refreshToken)}` }] }),
    }));
    const err = (await h.client.restrictions(PBP004).catch((e: unknown) => e)) as SpApiError;
    expect(err).toMatchObject({ kind: 'denied', status: 403 });
    for (const s of [...Object.values(CREDS), ACCESS, encodeURIComponent(CREDS.refreshToken)]) expect(err.message).not.toContain(s);
    expect(err.message).toContain('Product Listing');
  });

  it('scrubSp takes every secret out before it cuts, so a secret across the cut leaves no part', () => {
    const secrets = spSecrets(CREDS, ACCESS);
    const text = `${'x'.repeat(280)} ${CREDS.clientSecret}`;
    const out = scrubSp(text, secrets, 300);
    expect(out).not.toContain(CREDS.clientSecret.slice(0, 10));
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it('a sample keeps the answer but no credential, no token and no seller id, whatever the field is called', async () => {
    const h = harness(amazon({
      'sellingpartnerapi-na.amazon.com/fba/inbound/v1/eligibility/itemPreview': () =>
        json(200, { payload: { asin: PBP004, program: 'INBOUND', isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0008'], note: `seller ${CREDS.sellerId}` } }),
    }));
    await h.client.eligibility(PBP004);
    const all = JSON.stringify(h.samples);
    for (const s of [...Object.values(CREDS), ACCESS]) expect(all).not.toContain(s);
    expect(h.samples.map((s) => s.op)).toEqual(['token', 'eligibility']);
    expect(h.samples[0]!.body).toContain('"access_token":"[removed]"');
    expect(h.samples[1]!.body).toContain('FBA_INB_0008');
  });

  it('keeps at most three samples per operation', async () => {
    const h = harness(amazon());
    for (let i = 0; i < 5; i += 1) await h.client.restrictions(PBP004);
    expect(h.samples.filter((s) => s.op === 'restrictions')).toHaveLength(3);
  });
});

describe('the pace: at or below the documented rates, one wait on a 429, never a loop', () => {
  it('spaces each operation by 1/rate: restrictions 200 ms, eligibility 1 s', async () => {
    const h = harness(amazon());
    for (let i = 0; i < 3; i += 1) await h.client.restrictions(PBP004);
    for (let i = 0; i < 3; i += 1) await h.client.eligibility(PBP004);
    const at = (path: string) => h.calls.filter((c) => c.url.pathname.includes(path)).map((c) => c.at);
    const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
    expect(gaps(at('restrictions')).every((g) => g >= 200)).toBe(true);
    expect(gaps(at('itemPreview')).every((g) => g >= 1000)).toBe(true);
  });

  it('a 429 waits as Retry-After says and tries once more; a second 429 is a limit, not another try', async () => {
    let n = 0;
    const h = harness(amazon({
      'sellingpartnerapi-na.amazon.com/fba/inbound/v1/eligibility/itemPreview': () => {
        n += 1;
        return json(429, { errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota for the requested resource.' }] }, { 'retry-after': '2' });
      },
    }));
    const err = (await h.client.eligibility(PBP004).catch((e: unknown) => e)) as SpApiError;
    expect(n).toBe(2);
    expect(err.kind).toBe('limit');
    expect(h.waits.some((w) => w >= 2000)).toBe(true);
  });

  it('a 503 waits as x-amzn-RateLimit-Limit says, and a success after it is used', async () => {
    let n = 0;
    const h = harness(amazon({
      'sellingpartnerapi-na.amazon.com/listings/2021-08-01/restrictions': () => {
        n += 1;
        return n === 1 ? json(503, {}, { 'x-amzn-ratelimit-limit': '0.5' }) : json(200, { restrictions: [] });
      },
    }));
    expect((await h.client.restrictions(PBP004)).status).toBe('allowed');
    expect(h.waits.some((w) => w >= 2000)).toBe(true);
  });

  it('the day cap: past it, no call is made and the error says so', async () => {
    let now = 0;
    const limiter = new SpLimiter({ now: () => now, sleep: async (ms) => void (now += ms), caps: { restrictions: 2 } });
    const route = amazon();
    const c = new SpApiClient({ credentials: CREDS, fetchFn: (async (i: string | URL | Request, init?: RequestInit) => route(new URL(String(i)), init)) as typeof fetch, limiter, now: () => now, sleep: async () => {} });
    await c.restrictions(PBP004);
    await c.restrictions(PBP004);
    await expect(c.restrictions(PBP004)).rejects.toMatchObject({ kind: 'cap' });
    expect(limiter.usedToday('restrictions')).toBe(2);
    // The next day starts again.
    now += 86_400_000;
    expect(limiter.left('restrictions')).toBe(2);
  });

  it('a restart keeps the day count it is given', () => {
    const limiter = new SpLimiter({ now: () => 0, sleep: async () => {}, usedToday: { fees: 39 } });
    expect(limiter.left('fees')).toBe(1);
  });

  it('records every call in the ledger rows with no address and no key', async () => {
    const h = harness(amazon());
    await h.client.restrictions(PBP004);
    expect(h.rows.map((r) => [r.op, r.status, r.items])).toEqual([['token', 200, 0], ['restrictions', 200, 1]]);
    expect(JSON.stringify(h.rows)).not.toMatch(/amazon\.com|A1B2C3|Atz/);
  });
});

describe('Listings Restrictions (new_new): each reason, unknown codes kept as they came', () => {
  const APPLY = 'https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV&itemcondition=new';
  it('no restriction is allowed', () => {
    expect(parseRestrictions(PBP004, { restrictions: [] })).toEqual({ asin: PBP004, status: 'allowed', reasons: [] });
  });

  it("approval required, with Amazon's message and its Seller Central link", () => {
    const r = parseRestrictions(PBP004, {
      restrictions: [{
        marketplaceId: 'ATVPDKIKX0DER', conditionType: 'new_new',
        reasons: [{ message: 'You need approval to list in this brand.', reasonCode: 'APPROVAL_REQUIRED', links: [{ resource: APPLY, verb: 'GET', title: 'Request approval', type: 'text/html' }] }],
      }],
    });
    expect(r).toEqual({ asin: PBP004, status: 'approval_required', reasons: [{ code: 'APPROVAL_REQUIRED', known: true, message: 'You need approval to list in this brand.', link: APPLY }] });
  });

  it('a link to any other host, or not https, is dropped (the message stays)', () => {
    for (const bad of ['http://sellercentral.amazon.com/x', 'https://sellercentral.amazon.com.evil.example/x', 'https://evil.example/?u=https://sellercentral.amazon.com', 'https://user@sellercentral.amazon.com/x', 'https://sellercentral.amazon.com:8443/x', 'javascript:alert(1)', '/hz/approvalrequest']) {
      expect(sellerCentralLink(bad)).toBeNull();
    }
    const r = parseRestrictions(PBP004, { restrictions: [{ conditionType: 'new_new', reasons: [{ message: 'Apply here', reasonCode: 'APPROVAL_REQUIRED', links: [{ resource: 'https://evil.example/apply' }] }] }] });
    expect(r.reasons[0]).toMatchObject({ link: null, message: 'Apply here' });
  });

  it('not eligible and not found', () => {
    expect(parseRestrictions(PBP004, { restrictions: [{ conditionType: 'new_new', reasons: [{ message: 'Not eligible', reasonCode: 'NOT_ELIGIBLE' }] }] }).status).toBe('not_eligible');
    expect(parseRestrictions(PBP004, { restrictions: [{ conditionType: 'new_new', reasons: [{ message: 'No such ASIN', reasonCode: 'ASIN_NOT_FOUND' }] }] }).status).toBe('not_found');
  });

  it('an unknown reason code is kept by name and is never allowed', () => {
    const r = parseRestrictions(PBP004, { restrictions: [{ conditionType: 'new_new', reasons: [{ message: 'Something new', reasonCode: 'HAZMAT_REVIEW' }] }] });
    expect(r.status).toBe('unknown');
    expect(r.reasons[0]).toMatchObject({ code: 'HAZMAT_REVIEW', known: false });
  });

  it('a restriction for another condition does not count; one with no reason at all is still a restriction', () => {
    expect(parseRestrictions(PBP004, { restrictions: [{ conditionType: 'used_like_new', reasons: [{ reasonCode: 'NOT_ELIGIBLE' }] }] }).status).toBe('allowed');
    expect(parseRestrictions(PBP004, { restrictions: [{ conditionType: 'new_new', reasons: [] }] }).status).toBe('unknown');
  });

  it('an answer without `restrictions` cannot be read (never read as allowed)', () => {
    expect(() => parseRestrictions(PBP004, {})).toThrow(/could not be read/);
  });
});

describe('FBA Inbound Eligibility: reason codes become sentences, unknown codes show as their code', () => {
  it('eligible', () => {
    expect(parseEligibility(PBP004, { payload: { asin: PBP004, program: 'INBOUND', isEligibleForProgram: true } })).toEqual({ asin: PBP004, eligible: true, reasons: [] });
  });

  it('the battery: dangerous goods review, battery details', () => {
    const r = parseEligibility(PBP004, { payload: { asin: PBP004, program: 'INBOUND', isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0014', 'FBA_INB_0008'] } });
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => fbaReasonWords(x.code))).toEqual(['Amazon is reviewing it as dangerous goods: 4 to 7 business days', 'Needs battery details']);
    expect(fbaReasonWords('FBA_INB_0051')).toBe('Cannot be sent to FBA: blocked');
  });

  it('an unknown code is "unknown: <code>"', () => {
    const r = parseEligibility(PBP004, { payload: { isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0999'] } });
    expect(fbaReasonWords(r.reasons[0]!.code)).toBe('unknown: FBA_INB_0999');
  });

  it('"eligible" that still lists a reason is read as not eligible; no boolean cannot be read', () => {
    expect(parseEligibility(PBP004, { payload: { isEligibleForProgram: true, ineligibilityReasonList: ['FBA_INB_0004'] } }).eligible).toBe(false);
    expect(() => parseEligibility(PBP004, { payload: { asin: PBP004 } })).toThrow();
  });
});

describe('Product Fees, batch: the referral line and the rest; unknown fee types kept by name', () => {
  const answer = (asin: string, lines: { type: string; amount: number }[], total?: number) => ({
    Status: 'Success',
    FeesEstimateIdentifier: { MarketplaceId: 'ATVPDKIKX0DER', SellerId: CREDS.sellerId, IdType: 'ASIN', IdValue: asin, IsAmazonFulfilled: true },
    FeesEstimate: {
      TotalFeesEstimate: { CurrencyCode: 'USD', Amount: total ?? lines.reduce((n, l) => n + l.amount, 0) },
      FeeDetailList: lines.map((l) => ({ FeeType: l.type, FeeAmount: { CurrencyCode: 'USD', Amount: l.amount }, FinalFee: { CurrencyCode: 'USD', Amount: l.amount } })),
    },
  });

  it('reads the referral fee and counts every other type (an unknown one too) as the rest', () => {
    const [r] = parseFeesBatch([{ asin: PBP004, price: 50 }], [answer(PBP004, [{ type: 'ReferralFee', amount: 7.5 }, { type: 'FBAFees', amount: 6.21 }, { type: 'LowInventoryLevelFee', amount: 0.89 }])]);
    expect(r).toEqual({
      asin: PBP004, price: 50, problem: null,
      estimate: { total: 14.6, referral: 7.5, other: 7.1, lines: [{ type: 'ReferralFee', amount: 7.5 }, { type: 'FBAFees', amount: 6.21 }, { type: 'LowInventoryLevelFee', amount: 0.89 }] },
    });
  });

  it('no ReferralFee line, lines that do not add up, an error or another item: no estimate, and why', () => {
    const items = [{ asin: 'A1', price: 10 }, { asin: 'A2', price: 10 }, { asin: 'A3', price: 10 }, { asin: 'A4', price: 10 }];
    const out = parseFeesBatch(items, [
      answer('A1', [{ type: 'FBAFees', amount: 5 }]),
      answer('A2', [{ type: 'ReferralFee', amount: 1.5 }], 9),
      { Status: 'ClientError', Error: { Type: 'Sender', Code: 'InvalidParameterValue', Message: 'Invalid ASIN' } },
      answer('B0OTHER', [{ type: 'ReferralFee', amount: 1.5 }]),
    ]);
    expect(out.map((r) => r.estimate)).toEqual([null, null, null, null]);
    expect(out.map((r) => r.problem)).toEqual([
      'no referral fee line to tell it from the other fees',
      'its fee lines add up to $1.50, not its total of $9.00',
      'Amazon said: Invalid ASIN',
      'the answer was for another item',
    ]);
  });

  it('the client sends 20 at most a call, IsAmazonFulfilled true, at the price asked', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ asin: `B0TEST${String(i).padStart(4, '0')}`, price: 10 + i }));
    const h = harness(amazon({
      'sellingpartnerapi-na.amazon.com/products/fees/v0/feesEstimate': (_u, init) => {
        const asked = JSON.parse(String(init!.body)) as { IdValue: string; FeesEstimateRequest: { PriceToEstimateFees: { ListingPrice: { Amount: number } } } }[];
        return json(200, asked.map((a) => answer(a.IdValue, [{ type: 'ReferralFee', amount: 1.5 }, { type: 'FBAFees', amount: 5 }])));
      },
    }));
    const out = await h.client.fees(items);
    expect(out).toHaveLength(21);
    const posts = h.calls.filter((c) => c.url.pathname.endsWith('/feesEstimate'));
    expect(posts.map((p) => (JSON.parse(p.body!) as unknown[]).length)).toEqual([20, 1]);
    const first = (JSON.parse(posts[0]!.body!) as { IdType: string; FeesEstimateRequest: Record<string, unknown> }[])[0]!;
    expect(first.IdType).toBe('ASIN');
    expect(first.FeesEstimateRequest).toMatchObject({ MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 10 } } });
    // 0.5 a second: the two batches are two seconds apart.
    expect(posts[1]!.at - posts[0]!.at).toBeGreaterThanOrEqual(2000);
    // The seller id Amazon echoes in each answer's identifier is not in the sample.
    expect(JSON.stringify(h.samples)).not.toContain(CREDS.sellerId);
  });
});

describe('Sales getOrderMetrics: the method and its parser only (outcomes are not wired yet)', () => {
  it('asks by ASIN and day in the US marketplace and reads each interval', async () => {
    const h = harness(amazon({
      'sellingpartnerapi-na.amazon.com/sales/v1/orderMetrics': () => json(200, {
        payload: [
          { interval: '2026-11-23T00:00-08:00--2026-11-24T00:00-08:00', unitCount: 2, orderItemCount: 2, orderCount: 2, averageUnitPrice: { currencyCode: 'USD', amount: 49.99 }, totalSales: { CurrencyCode: 'USD', Amount: 99.98 } },
          { interval: '2026-11-24T00:00-08:00--2026-11-25T00:00-08:00', unitCount: 0, orderItemCount: 0, orderCount: 0, averageUnitPrice: { CurrencyCode: 'USD', Amount: 0 }, totalSales: { CurrencyCode: 'USD', Amount: 0 } },
        ],
      }),
    }));
    const out = await h.client.orderMetrics({ asin: PBP004, interval: '2026-11-23T00:00:00-08:00--2026-11-25T00:00:00-08:00', timeZone: 'US/Pacific' });
    const q = h.calls.at(-1)!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ marketplaceIds: 'ATVPDKIKX0DER', interval: '2026-11-23T00:00:00-08:00--2026-11-25T00:00:00-08:00', granularity: 'Day', granularityTimeZone: 'US/Pacific', asin: PBP004 });
    // A money object in another casing than the model's is not guessed at: null, not a number.
    expect(out.map((m) => [m.unitCount, m.averageUnitPrice, m.totalSales])).toEqual([[2, null, 99.98], [0, 0, 0]]);
  });

  it('an answer without a payload array cannot be read', () => {
    expect(() => parseOrderMetrics({ payload: {} })).toThrow();
  });
});
