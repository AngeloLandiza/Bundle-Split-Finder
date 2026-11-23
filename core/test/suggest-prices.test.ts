import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { parseProductResponse } from '../src/keepa/parse';
import { partTrendFromProduct, type PartTrend } from '../src/keepa/trends';
import { planConfirmedPrice, SUGGESTION_GONE } from '../src/scan/confirmed';
import { buildReport } from '../src/scan/report';
import { MIN_EBAY_LISTINGS, middleOf, suggestionButton, suggestPrice } from '../src/scan/suggest';
import { DEFAULT_SCAN_SETTINGS, type EbayJudgedListing, type EbayValueRecord, type PartRow } from '../src/scan/types';

// Suggested prices (Nov 23), on real data only: the owner's third real scan (fixtures/e2e-2026-11-23/after-scan3), the eBay
// listings recorded for the validation set on Nov 19 with their labels (fixtures/ebay), and Keepa's recorded stats pull
// (fixtures/keepa/product-…-stats.json). Nothing reaches the network; nothing here counts a suggestion.

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const DIR = join(FIX, 'e2e-2026-11-23', 'after-scan3');

interface RecordedItem { itemId: string; title: string; price: number | null; currency: string; url: string; soldQuantity: number | null }
const recorded = JSON.parse(readFileSync(join(FIX, 'ebay', 'validation-2026-11-19.json'), 'utf8')) as { parts: Record<string, { items: Record<string, RecordedItem> }> };
const labels = (JSON.parse(readFileSync(join(FIX, 'ebay', 'labels.json'), 'utf8')) as { labels: { itemId: string; model: string; verdict: 'match' | 'not_match' | 'unsure' }[] }).labels;

/** A part's eBay record as the eBay pass stores it, from the recorded listings with their labelled verdicts. */
function ebayRecord(brand: string, model: string): EbayValueRecord {
  const listings: EbayJudgedListing[] = labels.filter((l) => l.model === model).map((l) => {
    const it = recorded.parts[model]!.items[l.itemId]!;
    return { itemId: it.itemId, title: it.title, price: it.price, currency: it.currency, soldQuantity: it.soldQuantity, url: it.url, verdict: l.verdict, reasons: [] };
  });
  return { key: `${brand}:${model}`, brand, model, value: null, listings, notJudged: 0, complete: true, checkedAt: Date.UTC(2026, 10, 19) };
}

const stats = parseProductResponse(JSON.parse(readFileSync(join(FIX, 'keepa', 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json'), 'utf8')) as Record<string, unknown>).products;
const dcf921bTrend: PartTrend = partTrendFromProduct(stats.find((p) => p.asin === 'B09M3TL9BB')!, Date.UTC(2026, 10, 23));

const part = (over: Partial<PartRow>): Pick<PartRow, 'status' | 'availability' | 'asin' | 'prices'> => ({ status: 'none', availability: 'missing', asin: null, prices: [], ...over });

describe('suggestPrice', () => {
  it('no Amazon listing: the middle of the eBay listings marked the same product, with the count and the range (DCK200D1P1)', () => {
    // DCK200D1P1, the DEWALT starter kit with no Amazon listing in 10 of the owner's bundles: 6 of its 6 recorded listings match.
    const s = suggestPrice(part({}), { amazonDomain: 'amazon.com', ebay: ebayRecord('DEWALT', 'DCK200D1P1') })!;
    expect(s).toMatchObject({ kind: 'ebay_median', price: 274.48, fulfillment: 'none', label: '6 eBay listings, $220–$390.15, middle $274.48' });
    // 220, 229.99, 249 | 299.95, 299.99, 390.15: the mean of the two middle ones, to the cent.
    expect(middleOf([220, 229.99, 249, 299.95, 299.99, 390.15])).toBe(274.48);
    expect(s.evidence[0]!.url).toMatch(/^https:\/\/www\.ebay\.com\/itm\//);
    expect(s.evidence.slice(1).every((e) => e.url?.startsWith('https://www.ebay.com/itm/'))).toBe(true);
    expect(suggestionButton(s)).toBe('Confirm $274.48 (eBay middle of 6)');
  });

  it(`fewer than ${MIN_EBAY_LISTINGS} listings marked the same product make no suggestion (P553: 2 of 5)`, () => {
    expect(suggestPrice(part({}), { amazonDomain: 'amazon.com', ebay: ebayRecord('RYOBI', 'P553') })).toBeNull();
  });

  it('only listings marked the same product count: unsure and not-a-match listings, and an owner\'s No, are left out', () => {
    const rec = ebayRecord('DEWALT', 'DCF921B'); // 3 of 8 match
    expect(suggestPrice(part({}), { amazonDomain: 'amazon.com', ebay: rec })?.label).toBe('3 eBay listings, $119.99–$137.99, middle $129.99');
    const said = { ...rec, listings: rec.listings.map((l, i) => (l.verdict === 'match' && i === rec.listings.findIndex((x) => x.verdict === 'match') ? { ...l, owner: 'not_match' as const } : l)) };
    expect(suggestPrice(part({}), { amazonDomain: 'amazon.com', ebay: said })).toBeNull();
  });

  it('an inactive Amazon listing: Keepa\'s 90-day average New price, from the recorded stats pull (DCF921B)', () => {
    const s = suggestPrice(part({ status: 'matched', availability: 'inactive', asin: 'B09M3TL9BB' }), { amazonDomain: 'amazon.com', trend: dcf921bTrend })!;
    expect(s).toMatchObject({ kind: 'amazon_average', price: 146.37, fulfillment: 'fba', label: 'Amazon listing not for sale now; its 90-day average was $146.37 (Keepa)' });
    expect(s.evidence[0]).toEqual({ text: 'Keepa: the average New price of Amazon listing B09M3TL9BB over the last 90 days was $146.37, read Nov 23.', url: 'https://www.amazon.com/dp/B09M3TL9BB' });
    expect(suggestionButton(s)).toBe('Confirm $146.37 (Keepa 90-day average)');
    // No 90-day figure: the 30-day one. No stored average at all: no suggestion (the drip asks Keepa, 1 token).
    expect(suggestPrice(part({ status: 'matched', availability: 'inactive', asin: 'B09M3TL9BB' }), { amazonDomain: 'amazon.com', trend: { ...dcf921bTrend, newAvg90: null } })?.label)
      .toBe('Amazon listing not for sale now; its 30-day average was $156.43 (Keepa)');
    expect(suggestPrice(part({ status: 'matched', availability: 'inactive', asin: 'B09M3TL9BB' }), { amazonDomain: 'amazon.com', trend: { fbaFee: null, referralPercent: null } as PartTrend })).toBeNull();
    // An inactive listing never takes the eBay figure: at most one suggestion, from its own source.
    expect(suggestPrice(part({ status: 'matched', availability: 'inactive', asin: 'B09M3TL9BB' }), { amazonDomain: 'amazon.com', ebay: ebayRecord('DEWALT', 'DCF921B') })).toBeNull();
  });

  it('none for a part in Review, not looked up, or with a counted price; Home Depot\'s own price is context, never the figure', () => {
    const ebay = ebayRecord('DEWALT', 'DCK200D1P1');
    for (const status of ['review', 'waiting', 'unmatched'] as const) expect(suggestPrice(part({ status }), { amazonDomain: 'amazon.com', ebay })).toBeNull();
    const confirmed = { kind: 'confirmed' as const, price: 250, condition: 'new' as const, seller: null, shipsFrom: null, offers: null, asin: null, link: 'https://x.test/', seenAt: 1, reference: false };
    expect(suggestPrice(part({ prices: [confirmed] }), { amazonDomain: 'amazon.com', ebay })).toBeNull();
    const hd = { key: 'DEWALT:DCK200D1P1', brand: 'DEWALT', model: 'DCK200D1P1', itemId: '334337675', matchedModel: 'DCK200D1P1', price: 299, title: 'kit', link: 'https://www.homedepot.com/p/334337675', seenAt: 1, checkedAt: 1 };
    expect(suggestPrice(part({}), { amazonDomain: 'amazon.com', hd })).toBeNull();
    const s = suggestPrice(part({}), { amazonDomain: 'amazon.com', ebay, hd })!;
    expect(s.price).toBe(274.48);
    expect(s.evidence.at(-1)).toEqual({ text: 'Context: Home Depot sells it alone for $299.00. That is your cost side, not a sell price.', url: 'https://www.homedepot.com/p/334337675' });
  });
});

describe('suggestions in the report, on the owner\'s third real scan', () => {
  const withEbay = async () => {
    const store = await loadScanFolder(DIR);
    await store.putEbayValue(ebayRecord('DEWALT', 'DCK200D1P1'));
    return store;
  };

  it('DCK200D1P1W921B: the kit gets the eBay suggestion, the box a second line if accepted, and still no estimate', async () => {
    const rows = (await buildReport(await withEbay(), DEFAULT_SCAN_SETTINGS)).bundles;
    const row = rows.find((b) => b.model === 'DCK200D1P1W921B')!;
    expect(row.estimate).toBeNull();
    const kit = row.parts.find((p) => p.model === 'DCK200D1P1')!;
    expect(kit.priceSuggestion?.label).toBe('6 eBay listings, $220–$390.15, middle $274.48');
    expect(kit.price).toBeNull();
    // Break-even 158.75 after fees; at $274.48 the kit nets 274.48 - 15% = 233.31, so the bundle would make 233.31 - 158.75.
    expect(row.incomplete!.ifAccepted).toEqual({ profit: 74.56, roi: expect.closeTo(74.56 / 299, 4), suggested: 1 });
    // The other part is priced on Amazon: it gets no suggestion.
    expect(row.parts.find((p) => p.model === 'DCF921B')!.priceSuggestion).toBeUndefined();
    // The 9 DCK200D1P1 bundles whose other part is priced get the line; the 4 with another part waiting for a lookup or in Review do not.
    const dck = rows.filter((b) => b.model.startsWith('DCK200D1P1') && b.incomplete);
    expect(dck.filter((b) => b.incomplete!.ifAccepted).length).toBe(9);
    expect(rows.find((b) => b.model === 'DCK200D1P1W722B')!.incomplete!.ifAccepted).toBeUndefined();
  });

  it('confirming the suggestion stores an ordinary confirmed price with its source; a stale figure is refused', async () => {
    const store = await withEbay();
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'DCK200D1P1W921B')!;
    const live = row.parts.find((p) => p.model === 'DCK200D1P1')!.priceSuggestion!;
    const now = Date.UTC(2026, 10, 23, 18);
    expect(planConfirmedPrice(row, 'DCK200D1P1', { kind: 'suggested', suggestion: { ...live, price: 280 } }, now)).toEqual({ ok: false, code: 'conflict', message: SUGGESTION_GONE });
    expect(planConfirmedPrice(row, 'DCF921B', { kind: 'suggested', suggestion: live }, now)).toMatchObject({ ok: false, code: 'conflict' });
    const plan = planConfirmedPrice(row, 'DCK200D1P1', { kind: 'suggested', suggestion: { kind: live.kind, price: live.price } }, now);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.record).toMatchObject({ key: 'DEWALT:DCK200D1P1', price: 274.48, confirmedAt: now, source: { kind: 'ebay_median', label: live.label } });
    expect(plan.record.link).toBe(live.evidence[0]!.url);
    // Stored, it counts as any confirmed price: the bundle now has an estimate, the same figure the second line showed.
    await store.putConfirmedPrice(plan.record);
    const after = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'DCK200D1P1W921B')!;
    expect(after.estimate?.profit).toBe(74.56);
    const opt = after.parts.find((p) => p.model === 'DCK200D1P1')!;
    expect(opt.priceSuggestion).toBeUndefined();
    expect(opt.prices.find((o) => o.kind === 'confirmed')?.source?.kind).toBe('ebay_median');
  });
});
