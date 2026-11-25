// What the owner's own Amazon seller account says about a deal's parts, on his real records (Nov 25): the deals after the
// first keep-current re-check (fixtures/e2e-2026-11-23/after-keepcurrent). PSK1212SB-PCL633B (homedepot:344305163) is
// worth buying now at $35.67; it counts four listings: PBP004 (B09HDZ5MPV, the 4 Ah battery Keepa marks UN3480), PBP003
// (B09BL9VXZX), PCG002 (B0B1QRQYK2) and PCL633B (B0D7XWRWG5). The seller answers here are made up from the model shapes in
// docs/sp-api-notes-2026-11-25.md (no account was read); what each does to the deal is the point.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  checksWanted,
  NOT_CONNECTED_LINE,
  sellerAccountTag,
  sellerFails,
  sellerPartLine,
  type SellerLookup,
  type SellerPartCheck,
} from '../src/amazon/seller';
import { heldDeals, type SanityFinding } from '../src/audit/sanity';
import type { PartTrend } from '../src/keepa/trends';
import { amazonNet, DEFAULT_FEES } from '../src/money';
import { estimateBasis, feesOf } from '../src/scan/report';
import type { BundleRow, PartRow } from '../src/scan/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TrendLookup } from '../src/tracking/signals';
import { retrackReport, seedAnnounced, type TrackingState } from '../src/tracking/state';

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-keepcurrent', 'store');
const deals = JSON.parse(readFileSync(join(ROOT, 'deals.json'), 'utf8')) as { at: string; bundles: BundleRow[]; sanity?: SanityFinding[] };
const tracking = JSON.parse(readFileSync(join(ROOT, 'tracking.json'), 'utf8')) as TrackingState;

const VAC = 'homedepot:344305163';
const SAW = 'homedepot:341966856';
const ASIN = { PBP004: 'B09HDZ5MPV', PBP003: 'B09BL9VXZX', PCG002: 'B0B1QRQYK2', PCL633B: 'B0D7XWRWG5' } as const;
const NOW = Date.parse(deals.at) + 60_000;
const ACCOUNT = sellerAccountTag('A1B2C3D4E5F6G7');
const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };

function trendOf(t: TrackingState): TrendLookup {
  const out = new Map<string, PartTrend>();
  for (const s of Object.values(t.signals)) {
    for (const o of s.options) {
      for (const p of o.velocity.parts) {
        if (!p.asin || p.pulledAt === null || out.has(p.asin)) continue;
        out.set(p.asin, { asin: p.asin, amazonPrice: null, salesRank: p.salesRank, offerCount: null, pulledAt: p.pulledAt, monthlySold: p.monthlySold, buyBoxEligibleOffers: p.offers });
      }
    }
  }
  return (asin) => out.get(asin);
}

const allowed = (asin: string, over: Partial<SellerPartCheck> = {}): SellerPartCheck => ({
  asin, account: ACCOUNT, listing: { at: NOW, status: 'allowed', reasons: [] }, fba: { at: NOW, eligible: true, reasons: [] }, fees: null, ...over,
});
const lookupOf = (checks: Record<string, SellerPartCheck>, self: string[] = []): SellerLookup => ({ check: (a) => checks[a], selfShip: (a) => self.includes(a) });
const everyAllowed = (): Record<string, SellerPartCheck> => Object.fromEntries(Object.values(ASIN).map((a) => [a, allowed(a)]));

function judge(seller?: SellerLookup) {
  const held = Object.fromEntries([...heldDeals(deals.sanity ?? [])].map(([k, f]) => [k, f.sentence]));
  return retrackReport({ ...tracking, announced: seedAnnounced(tracking) }, { bundles: deals.bundles, review: [] }, trendOf(tracking), alerts, NOW, { keepa: true, flatFee: 0, held, ...(seller ? { seller } : {}) }).state.signals;
}

const vac = deals.bundles.find((b) => b.key === VAC)!;
const parts = (): PartRow[] => vac.options[0]!.parts;
const part = (model: keyof typeof ASIN): PartRow => parts().find((p) => p.model === model)!;

describe('Buy now with a seller account connected: every part allowed to list, every part taken by FBA', () => {
  it('every part allowed and eligible: the deal stays worth buying, word for word as without an account', () => {
    const s = judge(lookupOf(everyAllowed()))[VAC]!;
    expect(s.buyNow).toMatchObject({ kind: 'buyNow', numbers: { profit: 35.67 } });
    expect(s.verdict).toBe(judge()[VAC]!.verdict);
  });

  it("PBP004 needs Amazon's approval: not worth buying now, and the sentence names the part", () => {
    const checks = everyAllowed();
    checks[ASIN.PBP004] = allowed(ASIN.PBP004, {
      listing: { at: NOW, status: 'approval_required', reasons: [{ code: 'APPROVAL_REQUIRED', known: true, message: 'You need approval to list in this brand.', link: 'https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV' }] },
    });
    const s = judge(lookupOf(checks))[VAC]!;
    expect(s.buyNow).toBeNull();
    expect(s.verdict).toBe("Not worth buying now: you need Amazon's approval to list PBP004.");
    expect(s.options[0]!.notBuyNow).toBe("You need Amazon's approval to list PBP004.");
  });

  it('the battery FBA will not take yet: the reason in words; his "I ship it myself" lifts it', () => {
    const checks = everyAllowed();
    checks[ASIN.PBP004] = allowed(ASIN.PBP004, { fba: { at: NOW, eligible: false, reasons: [{ code: 'FBA_INB_0014', known: true }, { code: 'FBA_INB_0008', known: true }] } });
    const held = judge(lookupOf(checks))[VAC]!;
    expect(held.buyNow).toBeNull();
    expect(held.verdict).toBe('Not worth buying now: FBA does not take PBP004 yet: Amazon is reviewing it as dangerous goods: 4 to 7 business days; Needs battery details.');
    expect(judge(lookupOf(checks, [ASIN.PBP004]))[VAC]!.buyNow).not.toBeNull();
  });

  it('a part not checked yet is never allowed: it holds the deal and says so', () => {
    const checks = everyAllowed();
    delete checks[ASIN.PCG002];
    const s = judge(lookupOf(checks))[VAC]!;
    expect(s.buyNow).toBeNull();
    expect(s.verdict).toBe('Not worth buying now: not checked yet whether you may list PCG002; not checked yet whether FBA takes PCG002.');
  });

  it('an unknown reason code is shown as its code and holds the deal', () => {
    const checks = everyAllowed();
    checks[ASIN.PCL633B] = allowed(ASIN.PCL633B, { listing: { at: NOW, status: 'unknown', reasons: [{ code: 'BRAND_GATED_2027', known: false, message: '', link: null }] } });
    checks[ASIN.PBP003] = allowed(ASIN.PBP003, { fba: { at: NOW, eligible: false, reasons: [{ code: 'FBA_INB_0999', known: true }] } });
    expect(sellerFails(parts(), lookupOf(checks))).toEqual(['FBA does not take PBP003 yet: unknown: FBA_INB_0999', 'Amazon restricts listing PCL633B (unknown: BRAND_GATED_2027)']);
  });

  it('a deal already below his numbers says that first; the seller conditions follow', () => {
    const checks = Object.fromEntries(deals.bundles.find((b) => b.key === SAW)!.options[0]!.parts.flatMap((p) => (p.asin ? [[p.asin, allowed(p.asin, { listing: { at: NOW, status: 'not_eligible', reasons: [] } })]] : [])));
    const s = judge(lookupOf(checks))[SAW]!;
    expect(s.verdict).toMatch(/^Not worth buying now: est\. \$16\.73 is below your \$20 and 17% ROI below your 20%; you may not list /);
  });
});

describe('no seller account connected: nothing changes but one quiet line on a Buy now deal', () => {
  it('every signal is exactly as without the feature', () => {
    expect(judge(undefined)).toEqual(judge());
  });

  it('the quiet line is the stated sentence, never "allowed"', () => {
    expect(NOT_CONNECTED_LINE).toBe('Not checked against your Amazon account: connect it in Settings to see whether you may list these.');
  });

  it('feesOf without an Amazon estimate is what it was', () => {
    const trend = { fbaFee: 6.21, referralPercent: 15 };
    expect(feesOf(DEFAULT_FEES, trend, undefined)).toEqual(feesOf(DEFAULT_FEES, trend));
  });
});

describe("Amazon's fee estimate in place of Keepa's, with the basis line saying so", () => {
  const at = Date.parse('2026-11-25T17:00:00Z');
  const amazon = { price: 50, fees: { at, total: 14.34, referral: 7.5, other: 6.84 } };

  it("replaces Keepa's FBA fee and the flat referral for PBP004 at $50, keeping Keepa's figure beside it", () => {
    const keepa = feesOf(DEFAULT_FEES, { fbaFee: 6.21, referralPercent: 15 });
    expect(keepa).toEqual(part('PBP004').fees);
    const f = feesOf(DEFAULT_FEES, { fbaFee: 6.21, referralPercent: 15 }, amazon);
    expect(f).toEqual({ fulfillment: 6.84, fulfillmentFrom: 'amazon', referralRate: 0.15, referralFrom: 'amazon', amazon: { total: 14.34, referral: 7.5, other: 6.84, at, keepaFulfillment: 6.21 } });
    // The net the estimate takes is the price less Amazon's total; with Keepa's it was $0.63 more.
    expect(amazonNet(50, DEFAULT_FEES, { fulfillmentFee: f.fulfillment, referralRate: f.referralRate })).toBe(35.66);
    expect(amazonNet(50, DEFAULT_FEES, { fulfillmentFee: keepa.fulfillment })).toBe(36.29);
  });

  it('a flat fulfillment choice stays his: no Amazon figure replaces it', () => {
    const flat = { ...DEFAULT_FEES, fulfillmentSource: 'flat' as const, fulfillmentFee: 5 };
    expect(feesOf(flat, { fbaFee: 6.21 }, amazon)).toEqual(feesOf(flat, { fbaFee: 6.21 }));
  });

  it('the basis line: "Amazon\'s fee estimate for your account, read <date>", for every part or for those it has', () => {
    const withAmazon = (p: PartRow, fees: PartRow['fees']): PartRow => ({ ...p, fees });
    const all = parts().map((p) => withAmazon(p, feesOf(DEFAULT_FEES, { fbaFee: p.fees!.fulfillment }, { price: p.price!, fees: { at, total: 9.99, referral: 5, other: 4.99 } })));
    expect(estimateBasis(DEFAULT_FEES, all)).toBe("Amazon's fee estimate for your account, read Nov 25, for all 4 parts (referral and FBA: $9.99, $9.99, $9.99, $9.99); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.");
    const one = parts().map((p) => (p.model === 'PBP004' ? withAmazon(p, feesOf(DEFAULT_FEES, { fbaFee: 6.21 }, amazon)) : p));
    expect(estimateBasis(DEFAULT_FEES, one)).toBe(
      "Amazon's fee estimate for your account, read Nov 25, for PBP004 (referral and FBA: $14.34); for the others: 15% referral (at least $0.30); Amazon's FBA fee from Keepa for all 3 parts ($5.64, $7.33, $8.29); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.",
    );
    // Without any: the line is what it was.
    expect(estimateBasis(DEFAULT_FEES, parts())).toBe("15% referral (at least $0.30); Amazon's FBA fee from Keepa for all 4 parts ($6.21, $5.64, $7.33, $8.29); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.");
  });
});

describe('which listings are checked, and the line under each part', () => {
  it('a candidate deal with no records asks for all four listings, each once, with its price', () => {
    const wanted = checksWanted([{ parts: parts(), firstAnnounce: false }, { parts: parts(), firstAnnounce: false }], () => undefined, ACCOUNT, NOW);
    expect(wanted).toEqual([
      { asin: ASIN.PBP004, model: 'PBP004', price: 50, full: true, fees: true },
      { asin: ASIN.PBP003, model: 'PBP003', price: 36.89, full: true, fees: true },
      { asin: ASIN.PCG002, model: 'PCG002', price: 34.97, full: true, fees: true },
      { asin: ASIN.PCL633B, model: 'PCL633B', price: 68.89, full: true, fees: true },
    ]);
  });

  it('a week-old check is used; before a first announcement it is read again after an hour; a moved price asks only its fees', () => {
    const fresh = (age: number, price: number) => ({ ...allowed('x', { listing: { at: NOW - age, status: 'allowed', reasons: [] }, fba: { at: NOW - age, eligible: true, reasons: [] } }), feesAskedAt: price });
    const rec = (asin: string) => (asin === ASIN.PBP004 ? fresh(3 * 86_400_000, 53.99) : fresh(2 * 3_600_000, parts().find((p) => p.asin === asin)!.price!));
    expect(checksWanted([{ parts: parts(), firstAnnounce: false }], rec, ACCOUNT, NOW)).toEqual([{ asin: ASIN.PBP004, model: 'PBP004', price: 50, full: false, fees: true }]);
    expect(checksWanted([{ parts: parts(), firstAnnounce: true }], rec, ACCOUNT, NOW).map((w) => [w.model, w.full])).toEqual([['PBP004', true], ['PBP003', true], ['PCG002', true], ['PCL633B', true]]);
    // A record of another account is never used.
    expect(checksWanted([{ parts: parts(), firstAnnounce: false }], (a) => ({ ...rec(a), account: 'other' }), ACCOUNT, NOW)).toHaveLength(4);
  });

  it('the compact line: allowed, FBA, fees; approval with its link; not checked', () => {
    const ok = sellerPartLine(part('PCL633B'), allowed(ASIN.PCL633B, { fees: { at: NOW, price: 68.89, total: 12.41, referral: 10.33, other: 2.08, lines: [] } }), false);
    expect(ok).toMatchObject({ text: "You may list it. FBA accepts it. Amazon's fees: $12.41.", tone: 'ok', link: null, canSelfShip: false });
    const link = 'https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV';
    const gated = sellerPartLine(part('PBP004'), allowed(ASIN.PBP004, {
      listing: { at: NOW, status: 'approval_required', reasons: [{ code: 'APPROVAL_REQUIRED', known: true, message: 'You need approval to list in this brand.', link }] },
      fba: { at: NOW, eligible: false, reasons: [{ code: 'FBA_INB_0008', known: true }] },
    }), false);
    expect(gated).toMatchObject({ text: 'You need Amazon\'s approval to list it. Amazon: "You need approval to list in this brand." FBA not yet: Needs battery details.', tone: 'attention', link, canSelfShip: true });
    expect(sellerPartLine(part('PCG002'), undefined, false)).toMatchObject({ text: 'Not checked yet whether you may list it.', tone: 'attention' });
    expect(sellerPartLine(part('PBP004'), allowed(ASIN.PBP004, { fba: { at: NOW, eligible: false, reasons: [{ code: 'FBA_INB_0051', known: true }] } }), true))
      .toMatchObject({ text: 'You may list it. You ship it yourself.', tone: 'ok', selfShip: true, canSelfShip: false });
  });

  it("the account tag is not the seller id, and differs between accounts", () => {
    expect(ACCOUNT).toMatch(/^[0-9a-f]{8}$/);
    expect(ACCOUNT).not.toContain('A1B2');
    expect(sellerAccountTag('A9Z8Y7X6W5V4U3')).not.toBe(ACCOUNT);
  });
});
