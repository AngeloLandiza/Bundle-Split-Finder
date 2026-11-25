// Nov 25: the owner's Amazon seller account in the agent, read-only. The key is saved like the others and checked on save
// (the token exchange, then one listing read); the checks of a deal's parts are kept by ASIN; every call is in the ledger
// and the costs; no response, log, ledger row or sample holds a credential. A fake fetch built from the model shapes in
// docs/sp-api-notes-2026-11-25.md and the owner's real deals (fixtures/e2e-2026-11-23/after-keepcurrent); no network.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DealDetail, KeyCheck } from '../../core/src/api/contract';
import type { CostsView } from '../../core/src/costs/types';
import { sellerAccountTag } from '../../core/src/amazon/seller';
import type { BundleRow } from '../../core/src/scan/types';
import type { TrackingState } from '../../core/src/tracking/state';
import { retrackReport, seedAnnounced } from '../../core/src/tracking/state';
import { DEFAULT_SETTINGS } from '../../core/src/settings';
import { createAgent, type Agent } from '../app';
import { checkKey, keySecrets } from '../keyChecks';
import { SPAPI_LEDGER_FILE } from '../seller';
import type { StoredKeys } from '../store';

const SELLER = {
  clientId: 'amzn1.application-oa2-client.0123456789abcdef0123456789abcdef',
  clientSecret: 'amzn1.oa2-cs.v1.fedcba9876543210fedcba9876543210fedcba9876543210',
  refreshToken: 'Atzr|IwEBIExampleRefreshToken+with/slashes=and=pluses+0123456789',
  sellerId: 'A1B2C3D4E5F6G7',
};
const ACCESS = 'Atza|IwEBIExampleAccessToken0123456789abcdef';
const SECRETS = [...Object.values(SELLER), ACCESS, encodeURIComponent(SELLER.refreshToken)];

const STORE = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-keepcurrent', 'store');
const DEALS = JSON.parse(readFileSync(join(STORE, 'deals.json'), 'utf8')) as { at: string; bundles: BundleRow[] };
const OWNER_TRACKING = JSON.parse(readFileSync(join(STORE, 'tracking.json'), 'utf8')) as TrackingState;
const PSK_KEYS = ['homedepot:344305163', 'homedepot:341966856', 'homedepot:341965772'];
const only = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).filter(([k]) => PSK_KEYS.includes(k)));
/** The owner's tracking of those three deals only (the store writes it whole on every change). */
const TRACKING: TrackingState = { ...OWNER_TRACKING, watch: only(OWNER_TRACKING.watch), history: only(OWNER_TRACKING.history), signals: only(OWNER_TRACKING.signals) };
const VAC = 'homedepot:344305163'; // PSK1212SB-PCL633B
const PBP004 = 'B09HDZ5MPV';
/** PSK1212SB-PCL633B and the two PSK1212SB deals that share its listings: the store and report of these tests. */
const PSK = DEALS.bundles.filter((b) => ['homedepot:344305163', 'homedepot:341966856', 'homedepot:341965772'].includes(b.key));

const APPLY = 'https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Amazon as the models describe it: PBP004 needs approval and battery details; every other listing is fine. */
function amazon(over: { token?: () => Response; restrictions?: () => Response } = {}) {
  const calls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.host === 'api.amazon.com') return over.token?.() ?? json(200, { access_token: ACCESS, token_type: 'bearer', expires_in: 3600, refresh_token: SELLER.refreshToken });
    if (url.host !== 'sellingpartnerapi-na.amazon.com') throw new Error(`no handler for ${url.host}`);
    const asin = url.searchParams.get('asin');
    if (url.pathname === '/listings/2021-08-01/restrictions') {
      if (over.restrictions) return over.restrictions();
      return json(200, asin === PBP004
        ? { restrictions: [{ marketplaceId: 'ATVPDKIKX0DER', conditionType: 'new_new', reasons: [{ message: 'You need approval to list in this brand.', reasonCode: 'APPROVAL_REQUIRED', links: [{ resource: APPLY, verb: 'GET', title: 'Request approval', type: 'text/html' }] }] }] }
        : { restrictions: [] });
    }
    if (url.pathname === '/fba/inbound/v1/eligibility/itemPreview') {
      return json(200, { payload: { asin, program: 'INBOUND', isEligibleForProgram: asin !== PBP004, ...(asin === PBP004 ? { ineligibilityReasonList: ['FBA_INB_0008'] } : {}) } });
    }
    if (url.pathname === '/products/fees/v0/feesEstimate') {
      const asked = JSON.parse(String(init!.body)) as { IdValue: string; FeesEstimateRequest: { PriceToEstimateFees: { ListingPrice: { Amount: number } } } }[];
      return json(200, asked.map((a) => {
        const price = a.FeesEstimateRequest.PriceToEstimateFees.ListingPrice.Amount;
        const referral = Math.round(price * 15) / 100;
        return {
          Status: 'Success',
          FeesEstimateIdentifier: { MarketplaceId: 'ATVPDKIKX0DER', SellerId: SELLER.sellerId, IdType: 'ASIN', IdValue: a.IdValue, IsAmazonFulfilled: true },
          FeesEstimate: {
            TotalFeesEstimate: { CurrencyCode: 'USD', Amount: Math.round((referral + 7) * 100) / 100 },
            FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { CurrencyCode: 'USD', Amount: referral } }, { FeeType: 'FBAFees', FinalFee: { CurrencyCode: 'USD', Amount: 7 } }],
          },
        };
      }));
    }
    throw new Error(`no route ${url.pathname}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const KEYS: StoredKeys = { amazonSeller: SELLER };

describe('the key check: the token exchange, then one listing read', () => {
  it('works: signed in, and what Amazon said about the one listing, US marketplace', async () => {
    const a = amazon();
    const c = await checkKey('amazonSeller', KEYS, { fetchFn: a.fetchFn, timeoutMs: 2000, knownAsin: PBP004 });
    expect(c).toEqual({ ok: true, detail: 'signed in; listing check works (B09HDZ5MPV: it needs approval); US marketplace' });
    expect(a.calls.map((u) => u.host)).toEqual(['api.amazon.com', 'sellingpartnerapi-na.amazon.com']);
  });

  it('a refused refresh token is rejected in the owner\'s words, with no credential in it', async () => {
    const a = amazon({ token: () => json(400, { error: 'invalid_grant', error_description: `bad grant ${SELLER.refreshToken} ${SELLER.clientSecret}` }) });
    const c = (await checkKey('amazonSeller', KEYS, { fetchFn: a.fetchFn, timeoutMs: 2000 })) as Extract<KeyCheck, { ok: false }>;
    expect(c).toMatchObject({ ok: false, kind: 'rejected' });
    expect(c.problem).toContain('Authorize app');
    for (const s of SECRETS) expect(c.problem).not.toContain(s);
  });

  it('a wrong seller id is caught by the listing read (403), not passed as working', async () => {
    const a = amazon({ restrictions: () => json(403, { errors: [{ code: 'Unauthorized', message: `Access to requested resource is denied for ${SELLER.sellerId}.` }] }) });
    const c = (await checkKey('amazonSeller', KEYS, { fetchFn: a.fetchFn, timeoutMs: 2000 })) as Extract<KeyCheck, { ok: false }>;
    expect(c).toMatchObject({ ok: false, kind: 'rejected' });
    expect(c.problem).toMatch(/^Signed in, but the listing check failed\. Amazon refused this call: Unauthorized/);
    expect(c.problem).toContain('the seller id is yours');
    for (const s of SECRETS) expect(c.problem).not.toContain(s);
  });

  it('every credential is among the secrets every sentence is scrubbed of', () => {
    const s = keySecrets(KEYS);
    for (const v of Object.values(SELLER)) expect(s).toContain(v);
    expect(s).toContain(encodeURIComponent(SELLER.refreshToken));
  });
});

// ---------------------------------------------------------------- through the agent

let server: Server | null = null;
let agent: Agent | null = null;
let base = '';
let dataDir = '';
const NOW = Date.parse(DEALS.at) + 60_000;

async function start(fetchFn: typeof fetch): Promise<Agent> {
  server = createServer();
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'sf-seller-'));
  agent = createAgent({ dataDir, port, timers: false, fetchFn, now: () => NOW, shippedHelperVersion: null, work: { spSleep: async () => {} } });
  server.on('request', agent.handle);
  return agent;
}
afterEach(async () => {
  agent?.close();
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  agent = null;
  server = null;
});
const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent!.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });

describe('the key through the agent: saved owner-only, never returned, counted', () => {
  it('PUT saves and checks; no answer, no state, no ledger row and no sample carries a credential', async () => {
    const a = amazon();
    await start(a.fetchFn);
    const saved = (await (await ui('/api/keys/amazonSeller', { method: 'PUT', body: JSON.stringify(SELLER) })).json()) as { saved: true; check: KeyCheck };
    expect(saved).toEqual({ saved: true, check: { ok: true, detail: 'signed in; listing check works (B09HDZ5MPV: it needs approval); US marketplace' } });
    const settings = await (await ui('/api/settings')).text();
    expect(JSON.parse(settings).keys.amazonSeller).toBe(true);
    const state = await (await ui('/api/state')).text();
    const ledger = readFileSync(join(dataDir, SPAPI_LEDGER_FILE), 'utf8');
    expect(ledger.trim().split('\n').map((l) => JSON.parse(l) as { op: string }).map((r) => r.op)).toEqual(['token', 'restrictions']);
    const runtime = JSON.stringify(agent!.store.get('runtime'));
    for (const text of [settings, state, ledger, runtime]) for (const s of SECRETS) expect(text).not.toContain(s);
    // The samples are there for the notes, and say what Amazon answered.
    expect(agent!.store.get('runtime').spapiSamples?.map((s) => s.op)).toEqual(['token', 'restrictions']);
    expect(agent!.store.get('runtime').spapiUsage?.used).toEqual({ restrictions: 1 });
    const costs = (await (await ui('/api/costs')).json()) as CostsView;
    expect(costs.services.find((s) => s.service === 'amazon')).toMatchObject({ label: 'Amazon seller API', unit: 'calls', used: 2, monthlyPriceUsd: 0 });
  });

  it('an incomplete set is refused before it is saved', async () => {
    await start(amazon().fetchFn);
    const res = await ui('/api/keys/amazonSeller', { method: 'PUT', body: JSON.stringify({ ...SELLER, sellerId: '' }) });
    expect(res.status).toBe(400);
    expect(agent!.store.get('keys').amazonSeller).toBeUndefined();
  });
});

describe("a deal's parts checked against the account (PSK1212SB-PCL633B, four listings)", () => {
  it('reads each listing once, keeps it by ASIN, and the deal is held for PBP004 with the reason and the link', async () => {
    const a = amazon();
    const ag = await start(a.fetchFn);
    ag.store.update('keys', (k) => ({ ...k, amazonSeller: SELLER }));
    const bundles = PSK;
    ag.store.update('deals', (d) => ({ ...d, at: DEALS.at, bundles }));
    ag.store.update('tracking', (t) => ({ ...t, ...TRACKING }));
    const report = { bundles, review: [] };
    const out = await ag.work.seller.refresh(report, () => undefined, { keepa: true, flatFee: 0 });
    expect(out).toMatchObject({ stopped: null });
    expect(out.checked).toBeGreaterThanOrEqual(4);
    const checks = ag.store.get('tracking').sellerChecks!;
    const vacAsins = DEALS.bundles.find((b) => b.key === VAC)!.options[0]!.parts.map((p) => p.asin!);
    for (const asin of vacAsins) expect(checks[asin]).toMatchObject({ asin, account: sellerAccountTag(SELLER.sellerId) });
    expect(checks[PBP004]!.listing).toMatchObject({ status: 'approval_required', reasons: [{ code: 'APPROVAL_REQUIRED', link: APPLY }] });
    expect(checks[PBP004]!.fba).toMatchObject({ eligible: false, reasons: [{ code: 'FBA_INB_0008' }] });
    expect(checks[PBP004]!.fees).toMatchObject({ price: 50, referral: 7.5, other: 7, total: 14.5 });
    // Each listing read once, however many deals hold it.
    const reads = a.calls.filter((u) => u.pathname.endsWith('/restrictions')).map((u) => u.searchParams.get('asin'));
    expect(new Set(reads).size).toBe(reads.length);
    // A second pass reads nothing: the records are fresh.
    const before = a.calls.length;
    await ag.work.seller.refresh(report, () => undefined, { keepa: true, flatFee: 0 });
    expect(a.calls.length).toBe(before);

    // The signals with the account: not worth buying now, naming the part.
    const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };
    const judged = retrackReport(ag.store.get('tracking'), report, () => undefined, alerts, NOW, { keepa: true, flatFee: 0, seller: ag.work.seller.lookup()! });
    expect(judged.state.signals[VAC]!.options[0]!.notBuyNow).toContain("you need Amazon's approval to list PBP004");
    expect(judged.state.signals[VAC]!.options[0]!.notBuyNow).toContain('FBA does not take PBP004 yet: Needs battery details');

    // The inspector: one line per part, the link only to Seller Central.
    const detail = (await (await ui(`/api/deals/${encodeURIComponent(VAC)}`)).json()) as DealDetail;
    expect(detail.seller?.connected).toBe(true);
    expect(detail.seller?.parts.find((p) => p.asin === PBP004)).toMatchObject({ tone: 'attention', link: APPLY, canSelfShip: true });
    expect(detail.seller?.parts.find((p) => p.model === 'PCL633B')!.text).toBe("You may list it. FBA accepts it. Amazon's fees: $17.33.");

    // Amazon's fee estimate for the estimate: at exactly the price used, and not for a part he ships himself.
    const fees = ag.work.seller.amazonFees()!;
    expect(fees(PBP004, 50)).toMatchObject({ total: 14.5 });
    expect(fees(PBP004, 53.99)).toBeUndefined();
    ag.work.seller.setSelfShip(PBP004, true);
    expect(ag.work.seller.amazonFees()!(PBP004, 50)).toBeUndefined();
    expect(ag.work.seller.lookup()!.selfShip(PBP004)).toBe(true);
  });

  it('with no account: no call, no record, and a Buy now deal carries only the quiet line', async () => {
    const a = amazon();
    const ag = await start(a.fetchFn);
    ag.store.update('deals', (d) => ({ ...d, at: DEALS.at, bundles: PSK }));
    // The deal judged under the state rule as the agent does at start (core/test/buy-state.test.ts): it is worth buying now.
    const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };
    const sales = new Map(Object.values(TRACKING.signals).flatMap((s) => s.options.flatMap((o) => o.velocity.parts.flatMap((p) => (p.asin && p.pulledAt !== null ? [[p.asin, { asin: p.asin, amazonPrice: null, salesRank: p.salesRank, offerCount: null, pulledAt: p.pulledAt, monthlySold: p.monthlySold, buyBoxEligibleOffers: p.offers }] as const] : [])))));
    const judged = retrackReport({ ...TRACKING, announced: seedAnnounced(TRACKING) }, { bundles: PSK, review: [] }, (a) => sales.get(a), alerts, NOW, { keepa: true, flatFee: 0 }).state;
    expect(judged.signals[VAC]!.buyNow).not.toBeNull();
    ag.store.update('tracking', (t) => ({ ...t, ...judged }));
    expect(await ag.work.seller.refresh({ bundles: PSK, review: [] }, () => undefined, {})).toEqual({ checked: 0, feesRead: 0, stopped: null });
    expect(a.calls).toHaveLength(0);
    expect(ag.work.seller.lookup()).toBeUndefined();
    expect(ag.work.seller.amazonFees()).toBeUndefined();
    const detail = (await (await ui(`/api/deals/${encodeURIComponent(VAC)}`)).json()) as DealDetail;
    expect(detail.seller).toEqual({ connected: false, note: 'Not checked against your Amazon account: connect it in Settings to see whether you may list these.', parts: [] });
    expect(existsSync(join(dataDir, SPAPI_LEDGER_FILE))).toBe(false);
  });

  it("the day's cap stops a pass: the listing it stopped on and every one after say why and when, and wait until then", async () => {
    const a = amazon();
    const ag = await start(a.fetchFn);
    ag.store.update('keys', (k) => ({ ...k, amazonSeller: SELLER }));
    ag.store.update('deals', (d) => ({ ...d, at: DEALS.at, bundles: PSK }));
    ag.store.update('tracking', (t) => ({ ...t, ...TRACKING }));
    // The day's use as the ledger left it: one listing read short of the cap.
    ag.store.update('runtime', (r) => ({ ...r, spapiUsage: { day: new Date(NOW).toISOString().slice(0, 10), used: { restrictions: 399 } } }));
    const report = { bundles: PSK, review: [] };
    const out = await ag.work.seller.refresh(report, () => undefined, { keepa: true, flatFee: 0 });
    expect(out.checked).toBe(1);
    expect(out.stopped).toMatch(/limit of 400 Amazon restrictions calls today/);
    const checks = Object.values(ag.store.get('tracking').sellerChecks!);
    const held = checks.filter((c) => c.listing === null);
    expect(held.length).toBeGreaterThan(0);
    for (const c of held) expect(c.problem).toMatchObject({ text: out.stopped, retryAt: Date.UTC(2026, 10, 26) });
    // The next pass the same day asks Amazon nothing for them (the one listing read before the cap may have its fees read).
    const reads = () => a.calls.filter((u) => u.pathname.endsWith('/restrictions') || u.pathname.endsWith('/itemPreview')).length;
    const before = reads();
    await ag.work.seller.refresh(report, () => undefined, { keepa: true, flatFee: 0 });
    expect(reads()).toBe(before);
  });

  it('self-ship takes an ASIN a deal holds, and nothing else', async () => {
    const ag = await start(amazon().fetchFn);
    ag.store.update('deals', (d) => ({ ...d, at: DEALS.at, bundles: PSK }));
    expect((await ui('/api/seller/self-ship/not-an-asin', { method: 'POST', body: JSON.stringify({ selfShip: true }) })).status).toBe(400);
    expect((await ui('/api/seller/self-ship/B000000000', { method: 'POST', body: JSON.stringify({ selfShip: true }) })).status).toBe(404);
  });
});
