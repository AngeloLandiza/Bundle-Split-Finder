// What a bundle's own Home Depot page states about buying it (Nov 25): kept from the page, shown in words, and used as one more
// condition of "Worth buying now". The page is the recorded one (fixtures/homedepot-pages/availability-344305163-2026-11-25.json:
// buyable, not discontinued, Limit 3 per order, 90-Day returns, the promotion 10/26/2026 to 01/31/2027) and variations of it.
// The replay judges the owner's real deals (fixtures/e2e-2026-11-23/after-keepcurrent) again. No network, a fake clock.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { heldDeals, type SanityFinding } from '../src/audit/sanity';
import { buyingOf, cleanBuying, parseBundlePage, parseProductPage, parsePromoPage, usDateOf } from '../src/hdPage';
import type { PartTrend } from '../src/keepa/trends';
import { sameBuying, withBuying, withoutBuying } from '../src/scan/buying';
import type { BundleBuying, BundleRecord, BundleRow, ReviewItem } from '../src/scan/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { buyingView, cannotBuyWords, endedUnconfirmed, endsWithin, ENDED_RETRY_MS, priceEndsMessages, readWords } from '../src/tracking/buying';
import { endedUnread, failingOf, hdDue, keptDealOf, staleSince, type KeptDeal } from '../src/tracking/keepCurrent';
import type { TrendLookup } from '../src/tracking/signals';
import { retrackReport, seedAnnounced, type TrackingState } from '../src/tracking/state';

const HD = join(import.meta.dirname, '..', '..', 'fixtures', 'homedepot-pages', 'availability-344305163-2026-11-25.json');
interface Recorded { availabilityType: Record<string, unknown>; info: Record<string, unknown>; pricing: Record<string, unknown>; identifiers: { itemId: string; modelNumber: string } }
const recorded = JSON.parse(readFileSync(HD, 'utf8')) as Recorded;

/** The recorded page's state as page text, with the named parts replaced. */
function pageText(over: { availabilityType?: unknown; info?: unknown; pricing?: unknown } = {}): string {
  const product = {
    identifiers: { ...recorded.identifiers, brandName: 'RYOBI', productLabel: 'ONE+ 18V Starter Kit' },
    availabilityType: 'availabilityType' in over ? over.availabilityType : recorded.availabilityType,
    info: 'info' in over ? over.info : recorded.info,
    'pricing({"isBrandPricingPolicyCompliant":false,"storeId":"8119"})': 'pricing' in over ? over.pricing : recorded.pricing,
    details: { descriptiveAttributes: [{ value: 'Includes: a battery' }], description: 'A kit.' },
  };
  return `<script>window.__APOLLO_STATE__=${JSON.stringify({ 'base-catalog-344305163': product })}</script>`;
}
const ID = '344305163';
const withPromotionDates = (dates: unknown): Record<string, unknown> => ({ ...recorded.pricing, promotion: { ...(recorded.pricing.promotion as object), dates } });
const clean = (o: Record<string, unknown>, drop: string): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== drop));

const RECORDED = {
  buyable: true, discontinued: false, availability: 'Online', quantityLimit: 3, returnable: '90-Day', promotionStart: '2026-10-26', promotionEnd: '2027-01-31',
};

describe('what the page states, from the recorded page (hdPage.ts buyingOf)', () => {
  it('every reader of a product page gives the same facts', () => {
    const text = pageText();
    expect(parseBundlePage(text, ID)?.buying).toEqual(RECORDED);
    expect(parseProductPage(text, ID)?.buying).toEqual(RECORDED);
    expect(parsePromoPage(text, ID)?.buying).toEqual(RECORDED);
    // The price and was-price read as before.
    expect(parseProductPage(text, ID)).toMatchObject({ price: 99, wasPrice: 183 });
  });

  it('a page that is not buyable, and one that is discontinued, say so', () => {
    expect(parseBundlePage(pageText({ availabilityType: { ...recorded.availabilityType, buyable: false } }), ID)?.buying).toMatchObject({ buyable: false, discontinued: false });
    expect(parseBundlePage(pageText({ availabilityType: { ...recorded.availabilityType, discontinued: true } }), ID)?.buying).toMatchObject({ buyable: true, discontinued: true });
  });

  it('no limit, no return window, no promotion: null, never worked out', () => {
    expect(parseBundlePage(pageText({ info: { returnable: '90-Day' } }), ID)?.buying).toMatchObject({ quantityLimit: null, returnable: '90-Day' });
    expect(parseBundlePage(pageText({ info: {} }), ID)?.buying).toMatchObject({ quantityLimit: null, returnable: null });
    expect(parseBundlePage(pageText({ pricing: { ...recorded.pricing, promotion: null } }), ID)?.buying).toMatchObject({ promotionStart: null, promotionEnd: null, buyable: true });
    expect(parseBundlePage(pageText({ pricing: clean(recorded.pricing, 'promotion') }), ID)?.buying).toMatchObject({ promotionStart: null, promotionEnd: null });
  });

  it('a limit that is not a whole number of 1 or more is no limit', () => {
    for (const bad of [0, -2, 2.5, '3', null, 100000]) {
      expect(parseBundlePage(pageText({ info: { quantityLimit: bad } }), ID)?.buying?.quantityLimit).toBeNull();
    }
  });

  it('a bad date is kept as null, the rest is kept', () => {
    for (const bad of ['13/45/2026', '02/30/2027', '2027-01-31', '1/31/2027', 'soon', '', 20270131, null]) {
      const got = parseBundlePage(pageText({ pricing: withPromotionDates({ start: '10/26/2026', end: bad }) }), ID)?.buying;
      expect(got, String(bad)).toMatchObject({ promotionStart: '2026-10-26', promotionEnd: null, buyable: true, quantityLimit: 3 });
    }
    expect(usDateOf('02/29/2028')).toBe('2028-02-29');
    expect(usDateOf('02/29/2027')).toBeNull();
  });

  it('pricing entries that disagree on the dates give none', () => {
    const product = JSON.parse(pageText().replace(/^.*__APOLLO_STATE__=/, '').replace('</script>', ''))['base-catalog-344305163'] as Record<string, unknown>;
    product['pricing({"storeId":"1"})'] = withPromotionDates({ start: '10/26/2026', end: '02/28/2027' });
    expect(buyingOf(product)).toMatchObject({ promotionStart: null, promotionEnd: null, buyable: true });
  });

  it('a page that states none of it has no facts at all (so a page read before this changes nothing)', () => {
    expect(parseBundlePage(pageText({ availabilityType: undefined, info: undefined, pricing: { value: 99, original: 183 } }), ID)).not.toHaveProperty('buying');
    expect(buyingOf({})).toBeUndefined();
  });

  it('a set, whose page names no model, still gives its facts through the bundle page reader', () => {
    const text = pageText().replace('"modelNumber":"PSK1212SB-PCL633B"', '"modelNumber":null');
    expect(parseBundlePage(text, ID)?.buying).toEqual(RECORDED);
    expect(parseProductPage(text, ID)).toBeNull();
  });

  it('what a message carries is cleaned again: wrong kinds are null, a fake date is dropped, an empty one is nothing', () => {
    expect(cleanBuying(RECORDED)).toEqual(RECORDED);
    expect(cleanBuying({ ...RECORDED, buyable: 'yes', quantityLimit: 3.5, promotionEnd: '2027-02-31', returnable: 'x'.repeat(41) })).toEqual({
      ...RECORDED, buyable: null, quantityLimit: null, promotionEnd: null, returnable: null,
    });
    expect(cleanBuying({})).toBeUndefined();
    expect(cleanBuying('buyable')).toBeUndefined();
    expect(cleanBuying(null)).toBeUndefined();
  });
});

describe('kept on the bundle record (scan/buying.ts)', () => {
  const rec = { key: 'homedepot:1' } as BundleRecord;
  it('the newest reading wins, a page that states none leaves it, and the page keeps no copy', () => {
    const first = withBuying(rec, RECORDED, 1000);
    expect(first.buying).toEqual({ ...RECORDED, readAt: 1000 });
    expect(withBuying(first, undefined, 2000)).toBe(first);
    expect(withBuying(first, { ...RECORDED, buyable: false }, 500).buying).toMatchObject({ buyable: true, readAt: 1000 });
    expect(withBuying(first, { ...RECORDED, buyable: false }, 3000).buying).toMatchObject({ buyable: false, readAt: 3000 });
    expect(withoutBuying({ bullets: [], buying: RECORDED })).toEqual({ bullets: [] });
    expect(sameBuying(first.buying, RECORDED)).toBe(true);
    expect(sameBuying(first.buying, { ...RECORDED, quantityLimit: 2 })).toBe(false);
    expect(sameBuying(undefined, undefined)).toBe(true);
  });
});

// A fake clock: Nov 25 2026, 10:55 AM on the owner's clock.
const NOW = new Date(2026, 10, 25, 10, 55).getTime();
const buying = (over: Partial<BundleBuying> = {}): BundleBuying => ({ ...RECORDED, readAt: NOW, ...over });

describe('in the owner\'s words (tracking/buying.ts)', () => {
  it('can be bought: said as the page says it, online only when the page says Online, never "in stock"', () => {
    const v = buyingView(buying(), { profit: 35.67, priceSeenAt: NOW, now: NOW });
    expect(v).toMatchObject({
      state: 'can', line: "Home Depot's page says it can be bought online (read 10:55 AM)", limit: 3, limitLine: 'Limit 3 per order',
      priceEnds: '2027-01-31', priceEndsLine: "Home Depot's price ends Jan 31", priceEnded: false, returnsLine: "90-Day returns, per Home Depot's page",
    });
    expect(v.limitProfitLine).toBe('Up to 3 per order: about +$107 at this estimate (an estimate from your fee settings, not your real fees)');
    expect(buyingView(buying({ availability: 'Shared' }), { profit: 1, priceSeenAt: NOW, now: NOW }).line).toBe("Home Depot's page says it can be bought (read 10:55 AM)");
    for (const word of ['in stock', 'delivery', 'at your store']) expect(JSON.stringify(v)).not.toContain(word);
  });

  it('cannot be bought, discontinued, not stated, and not checked yet', () => {
    expect(cannotBuyWords(buying({ buyable: false }), NOW)).toBe("Home Depot's page says it cannot be bought right now (read 10:55 AM)");
    expect(cannotBuyWords(buying({ discontinued: true }), NOW)).toBe("Home Depot's page says it is discontinued (read 10:55 AM)");
    expect(cannotBuyWords(buying(), NOW)).toBeNull();
    expect(cannotBuyWords(buying({ buyable: null, discontinued: null }), NOW)).toBeNull();
    expect(cannotBuyWords(undefined, NOW)).toBeNull();
    expect(buyingView(buying({ buyable: null, discontinued: null }), { profit: null, priceSeenAt: NOW, now: NOW })).toMatchObject({ state: 'unstated', line: "Home Depot's page does not say whether it can be bought (read 10:55 AM)" });
    expect(buyingView(undefined, { profit: 20, priceSeenAt: NOW, now: NOW })).toMatchObject({ state: 'unchecked', line: "Home Depot's page: not checked yet", readAt: null, limit: null, limitProfitLine: null, priceEndsLine: null });
  });

  it('a reading of another day says the day; the limit allowance needs a limit above 1 and a profit above 0', () => {
    expect(readWords(new Date(2026, 10, 24, 17, 5).getTime(), NOW)).toBe('Nov 24, 5:05 PM');
    expect(buyingView(buying({ quantityLimit: 1 }), { profit: 30, priceSeenAt: NOW, now: NOW }).limitProfitLine).toBeNull();
    expect(buyingView(buying(), { profit: -2, priceSeenAt: NOW, now: NOW }).limitProfitLine).toBeNull();
    expect(buyingView(buying(), { profit: null, priceSeenAt: NOW, now: NOW }).limitProfitLine).toBeNull();
    expect(buyingView(buying({ quantityLimit: null }), { profit: 30, priceSeenAt: NOW, now: NOW })).toMatchObject({ limit: null, limitLine: null, limitProfitLine: null });
  });

  it('the promotion\'s end: shown while it holds, said when it passed with the price unread, and nothing once the price was read after it', () => {
    const END = new Date(2027, 0, 31, 12).getTime();
    const AFTER = new Date(2027, 1, 1, 9).getTime();
    expect(buyingView(buying(), { profit: 1, priceSeenAt: NOW, now: END }).priceEndsLine).toBe("Home Depot's price ends Jan 31");
    expect(endedUnconfirmed(buying(), NOW, END)).toBe(false);
    expect(endedUnconfirmed(buying(), NOW, AFTER)).toBe(true);
    expect(buyingView(buying(), { profit: 1, priceSeenAt: NOW, now: AFTER })).toMatchObject({ priceEnded: true, priceEndsLine: "Home Depot's price ended Jan 31; it has not been read since" });
    expect(endedUnconfirmed(buying(), AFTER - 1000, AFTER)).toBe(false);
    expect(buyingView(buying(), { profit: 1, priceSeenAt: AFTER - 1000, now: AFTER })).toMatchObject({ priceEnded: false, priceEndsLine: null });
    expect(endedUnconfirmed(buying({ promotionEnd: null }), 0, AFTER)).toBe(false);
  });

  it('the window of the ending-soon message is the stated number of days', () => {
    const at = (d: number, h = 12) => new Date(2027, 0, d, h).getTime();
    expect(endsWithin(buying(), at(28, 23))).toBe(false);
    expect(endsWithin(buying(), at(29, 0))).toBe(true);
    expect(endsWithin(buying(), at(31, 12))).toBe(true);
    expect(endsWithin(buying(), new Date(2027, 1, 1, 0, 0, 1).getTime())).toBe(false);
    expect(endsWithin(buying({ promotionEnd: null }), at(30))).toBe(false);
  });
});

describe('one message when a Buy now deal\'s price is about to end', () => {
  const deal = { key: 'homedepot:344305163', model: 'PSK1212SB-PCL633B', link: 'https://www.homedepot.com/p/344305163', price: 99, profit: 35.67, buying: buying() };
  const SOON = new Date(2027, 0, 29, 9).getTime();

  it('says the date and the days left, labels the estimate and links the page; once per deal and end date', () => {
    const [m, ...rest] = priceEndsMessages([deal], SOON, []);
    expect(rest).toEqual([]);
    expect(m!.sentence).toBe(
      "PSK1212SB-PCL633B is worth buying now, and Home Depot's price of $99.00 ends Jan 31 (in 2 days): buy before then. Est. profit $35.67 (an estimate from your fee settings, not your real fees). https://www.homedepot.com/p/344305163",
    );
    expect(m!.notifiedKey).toBe('homedepot:344305163|priceEnds|2027-01-31');
    expect(priceEndsMessages([deal], SOON + 3_600_000, [m!.notifiedKey])).toEqual([]);
    // Another end date (the promotion was extended) is news again.
    expect(priceEndsMessages([{ ...deal, buying: buying({ promotionEnd: '2027-02-28' }) }], new Date(2027, 1, 26).getTime(), [m!.notifiedKey])).toHaveLength(1);
  });

  it('not before the window, not after the end, not without a date', () => {
    expect(priceEndsMessages([deal], NOW, [])).toEqual([]);
    expect(priceEndsMessages([deal], new Date(2027, 1, 1, 9).getTime(), [])).toEqual([]);
    expect(priceEndsMessages([{ ...deal, buying: buying({ promotionEnd: null }) }], SOON, [])).toEqual([]);
    expect(priceEndsMessages([{ ...deal, buying: undefined }], SOON, [])).toEqual([]);
    expect(priceEndsMessages([deal], new Date(2027, 0, 31, 8).getTime(), [])[0]!.sentence).toContain('(today)');
    expect(priceEndsMessages([deal], new Date(2027, 0, 30, 8).getTime(), [])[0]!.sentence).toContain('(tomorrow)');
  });
});

describe('after the end, the deal\'s Home Depot price is read first', () => {
  const kept = (over: Partial<KeptDeal> & { key: string }): KeptDeal => ({ model: over.key, tier: 'watched', itemId: '1', link: null, hdCheckedAt: NOW, parts: [], ...over });
  const END = new Date(2027, 0, 31, 23, 59, 59, 999).getTime();
  const AFTER = END + 3_600_000;

  it('is due at once, before a Buy now deal that is only due by its cadence, and every ENDED_RETRY_MS while a read gives no price', () => {
    const ended = kept({ key: 'a', priceEndsAt: END, hdCheckedAt: END - 1000 });
    const buyNowDue = kept({ key: 'b', tier: 'buyNow', hdCheckedAt: AFTER - 5 * 3_600_000 });
    expect(endedUnread(ended, AFTER)).toBe(true);
    expect(hdDue([buyNowDue, ended], AFTER).map((d) => d.key)).toEqual(['a', 'b']);
    // Read since the end: no longer ended, and (read a minute ago) not due by its 12-hour cadence.
    expect(hdDue([{ ...ended, hdCheckedAt: AFTER - 60_000 }], AFTER)).toEqual([]);
    // A read that gave no price is a try; it is asked again after ENDED_RETRY_MS, not before.
    expect(hdDue([ended], AFTER, { 'hd:a': AFTER - 60_000 })).toEqual([]);
    expect(hdDue([ended], AFTER, { 'hd:a': AFTER - ENDED_RETRY_MS })).toHaveLength(1);
    // Before the end nothing changes.
    expect(hdDue([ended], END - 3_600_000)).toEqual([]);
  });

  it('a deal held out of Buy now only by the page is read as often as a Buy now deal, so it comes back at the first read that says it can be bought', () => {
    const row = { key: 'k', model: 'M', itemId: '1', link: null, seenAt: NOW, parts: [], options: [], buying: buying({ buyable: false }) } as unknown as BundleRow;
    const tier = (notBuyNow: string | null, buyNow: unknown = null) => keptDealOf(row, { watch: { k: { watched: true } }, signals: { k: { buyNow, options: [{ notBuyNow }] } } })!.tier;
    const sentence = "Home Depot's page says it cannot be bought right now (read 10:55 AM).";
    expect(tier(sentence)).toBe('buyNow');
    expect(tier("Home Depot's page says it is discontinued (read Nov 24, 10:55 AM).")).toBe('buyNow');
    // Another condition fails too, or the deal is not held by the page: an ordinary watched deal.
    expect(tier("Home Depot's page says it cannot be bought right now (read 10:55 AM); est. $5.00 is below your $20.")).toBe('watched');
    expect(tier('Est. $5.00 is below your $20.')).toBe('watched');
    expect(tier(null, { kind: 'buyNow' })).toBe('buyNow');
  });

  it('a deal built from a row with the page\'s dates carries the end', () => {
    const row = { key: 'k', model: 'M', itemId: '1', link: null, seenAt: NOW, parts: [], options: [], buying: buying() } as unknown as BundleRow;
    const d = keptDealOf(row, { watch: { k: { watched: true } }, signals: {} })!;
    expect(d.priceEndsAt).toBe(END);
    expect(staleSince(d, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------- the replay on the owner's real deals

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23');
const read = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(ROOT, dir, 'store', file), 'utf8')) as T;
interface Stored { deals: { at: string; bundles: BundleRow[]; sanity?: SanityFinding[] }; tracking: TrackingState; review: ReviewItem[] }
const stored = (): Stored => ({ deals: read('after-keepcurrent', 'deals.json'), tracking: read('after-keepcurrent', 'tracking.json'), review: [] });

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
const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };
function rejudge(s: Stored, now: number, bundles: BundleRow[] = s.deals.bundles) {
  const held = Object.fromEntries([...heldDeals(s.deals.sanity ?? [])].map(([k, f]) => [k, f.sentence]));
  const tracking = { ...s.tracking, announced: seedAnnounced(s.tracking) };
  return retrackReport(tracking, { bundles, review: s.review }, trendOf(s.tracking), alerts, now, { keepa: true, flatFee: 0, held });
}

const VAC = 'homedepot:344305163'; // PSK1212SB-PCL633B, the recorded page's item
const LIGHT = 'homedepot:341965772';
const SAW = 'homedepot:341966856';

describe('replay on the owner\'s deals after the keep-current re-check (no page read since this was kept)', () => {
  const s = stored();
  const at = Date.parse(s.deals.at) + 60_000;
  const before = rejudge(s, at).state;

  it('no deal has a reading: each says "not checked yet" and nothing else about buying changes', () => {
    expect(s.deals.bundles.filter((b) => b.buying !== undefined)).toEqual([]);
    const watched = s.deals.bundles.filter((b) => s.tracking.watch[b.key]?.watched === true);
    expect(watched.length).toBeGreaterThan(30);
    for (const b of watched) expect(buyingView(b.buying, { profit: b.estimate?.profit ?? null, priceSeenAt: b.seenAt, now: at })).toMatchObject({ state: 'unchecked', line: "Home Depot's page: not checked yet" });
    // The verdicts are the state rule's, unchanged: two in Buy now.
    const inState = (t: TrackingState) => Object.values(t.signals).filter((x) => t.watch[x.bundleKey]?.watched === true && x.buyNow !== null).map((x) => x.model).sort();
    expect(inState(before)).toEqual(['PSK1212SB-PCL031B', 'PSK1212SB-PCL633B']);
    expect(before.signals[VAC]!.verdict).toBe('Worth buying now: +$35.67 (36% ROI), sells about 100 a month. Down from $38.79 at the last check.');
  });

  /** The same deals with the recorded page's statements on PSK1212SB-PCL633B, read at `readAt`. */
  const withPage = (over: Partial<BundleBuying>, readAt: number): BundleRow[] =>
    s.deals.bundles.map((b) => (b.key === VAC ? { ...b, buying: { ...RECORDED, ...over, readAt } } : b));

  it('the recorded page (can be bought) leaves the verdict exactly as it was', () => {
    const got = rejudge(s, at, withPage({}, at - 60_000)).state;
    expect(got.signals[VAC]!.verdict).toBe(before.signals[VAC]!.verdict);
    expect(got.signals[VAC]!.buyNow).not.toBeNull();
    expect(got.signals[LIGHT]!.verdict).toBe(before.signals[LIGHT]!.verdict);
  });

  it('a page that says it cannot be bought takes it out of the state with the true sentence, and a later page that says it can brings it back by itself', () => {
    const readAt = new Date(2026, 10, 25, 10, 55).getTime();
    const out = rejudge(s, readAt + 60_000, withPage({ buyable: false }, readAt));
    expect(out.state.signals[VAC]!.buyNow).toBeNull();
    expect(out.state.signals[VAC]!.verdict).toBe("Not worth buying now: Home Depot's page says it cannot be bought right now (read 10:55 AM).");
    expect(failingOf(out.state.signals[VAC])).toBe("Home Depot's page says it cannot be bought right now (read 10:55 AM)");
    // The other deals are untouched.
    expect(out.state.signals[LIGHT]!.verdict).toBe(before.signals[LIGHT]!.verdict);
    expect(out.state.signals[SAW]!.verdict).toBe(before.signals[SAW]!.verdict);
    // Discontinued says so.
    const gone = rejudge(s, readAt + 60_000, withPage({ discontinued: true }, readAt));
    expect(gone.state.signals[VAC]!.verdict).toBe("Not worth buying now: Home Depot's page says it is discontinued (read 10:55 AM).");
    // A later read says it can be bought: back in the state, not announced again (it was announced on Nov 23).
    const back = rejudge({ ...s, tracking: out.state }, readAt + 4 * 3_600_000, withPage({}, readAt + 4 * 3_600_000));
    expect(back.state.signals[VAC]!.buyNow).not.toBeNull();
    expect(back.state.signals[VAC]!.verdict).toMatch(/^Worth buying now: \+\$35\.67/);
  });

  it('a page that does not state buyable is not a reason to leave the state', () => {
    const got = rejudge(s, at, withPage({ buyable: null, discontinued: null }, at - 1000)).state;
    expect(got.signals[VAC]!.buyNow).not.toBeNull();
  });
});
