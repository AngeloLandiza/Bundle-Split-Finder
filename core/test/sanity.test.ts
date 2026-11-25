// The sanity checks (core/src/audit/sanity.ts) measured on the recorded data, so every threshold stays tied to what it
// flags. The numbers here are the ones docs/decisions.md gives ("Checking the app's own work"). Free; no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { heldDeals, isKitModel, modelTokens, otherModels, packOf, sanityFindings, SANITY_LIMITS } from '../src/audit/sanity';
import { titleHasModel } from '../src/match';
import { loadScanFolder } from '../../scripts/data-folder';
import { AFTER_SCAN3, AFTER_SCAN5, dealsOf, FIXTURES, storedDeals, storeWithWrongListing, WRONG_SET } from './sanity-world';

const json = <T>(...p: string[]): T => JSON.parse(readFileSync(join(FIXTURES, ...p), 'utf8')) as T;

describe('the real wrong confirmation (B0DGLWKS9S, Nov 24) is held by more than one check', () => {
  it('a $389 backpack confirmed for the $39.99 adaptor plate DWST08017: title, price and estimate each hold the set', async () => {
    const deals = await dealsOf(await storeWithWrongListing());
    const set = deals.find((d) => d.key === WRONG_SET)!;
    // What the owner saw: a confirmed deal reading hundreds of dollars on a $54.87 set (+$259.45 with his fees; the
    // default fee settings here read more).
    expect(set.section).toBe('confirmed');
    expect(set.estimate!.profit).toBeGreaterThan(250);
    const holds = sanityFindings(deals).filter((f) => f.bundleId === WRONG_SET && f.severity === 'hold');
    expect(holds.map((f) => f.kind).sort()).toEqual(['price_vs_home_depot', 'title_other_model', 'too_good']);
    const title = holds.find((f) => f.kind === 'title_other_model')!;
    expect(title).toMatchObject({ part: 'DWST08017', asin: 'B0DGLWKS9S', clearKey: 'listing|DEWALT:DWST08017|B0DGLWKS9S' });
    expect(title.sentence).toBe('The Amazon listing confirmed for DWST08017 is titled "DWST60122-1 Dewalt Pro Backpack x McLaren F1 Team, Limited Edition", which names DWST60122-1 and not DWST08017.');
    expect(holds.find((f) => f.kind === 'price_vs_home_depot')!.numbers).toEqual({ amazon: 389, homeDepot: 39.99, ratio: 9.73 });
    // The links to check it by eye: Home Depot's set and the part sold alone, then the Amazon listing.
    expect(title.links.map((l) => l.url)).toEqual([
      set.link, 'https://www.homedepot.com/p/322961591', 'https://www.amazon.com/dp/B0DGLWKS9S',
    ]);
    expect(heldDeals(holds).get(WRONG_SET)!.kind).toBe('title_other_model');
  });

  it('"This is right" on the listing clears its two listing findings; the estimate stays held until cleared too', async () => {
    const deals = await dealsOf(await storeWithWrongListing());
    const left = sanityFindings(deals, { cleared: ['listing|DEWALT:DWST08017|B0DGLWKS9S'] }).filter((f) => f.bundleId === WRONG_SET);
    expect(left.map((f) => f.kind)).toEqual(['too_good']);
    expect(sanityFindings(deals, { cleared: ['listing|DEWALT:DWST08017|B0DGLWKS9S', `bundle|${WRONG_SET}|too_good`] }).filter((f) => f.bundleId === WRONG_SET)).toEqual([]);
  });
});

describe('measured on the owner\'s stored deals (fixtures/e2e-2026-11-23)', () => {
  it('after-scan5: 46 confirmed listings, every title names its model; the only deal held is PCL702B on a two-tool listing', () => {
    const deals = storedDeals(AFTER_SCAN5);
    const confirmed = new Map<string, { brand: string; model: string; title: string }>();
    for (const b of deals) for (const o of b.options) for (const p of o.parts) {
      if (p.status === 'matched' && p.asin && ['keepa_catalog', 'serpapi_product', 'listing_fields'].includes(p.verifiedBy ?? '')) confirmed.set(`${p.model}|${p.asin}`, { brand: b.brand, model: p.model, title: p.title ?? '' });
    }
    expect(confirmed.size).toBe(46);
    expect([...confirmed.values()].filter((c) => !titleHasModel(c.brand, c.title, c.model))).toEqual([]);
    const found = sanityFindings(deals);
    // B0FD253MKS "PCL700B & PCL702B" is a two-tool listing (docs/decisions.md, the open several-parts-in-a-listing case):
    // wrong for PCL702B alone. It read +$191.41, ROI 107%.
    expect(found.map((f) => [f.kind, f.bundleId, f.part ?? null, f.severity])).toEqual([
      ['title_extra_model', 'homedepot:344284497', 'PCL702B', 'hold'],
      ['price_vs_home_depot', 'homedepot:344284497', 'PCL702B', 'hold'],
      ['too_good', 'homedepot:344284497', null, 'hold'],
    ]);
    expect(found.find((f) => f.kind === 'too_good')!.numbers).toEqual({ roi: 1.0693, profit: 191.41, amazonOverRegular: 1.79 });
  });

  it('after-scan3: nothing flagged', () => {
    expect(sanityFindings(storedDeals(AFTER_SCAN3))).toEqual([]);
  });

  it('after-scan5 rebuilt by today\'s report: only PCL702B\'s two-tool listing is flagged', async () => {
    const found = sanityFindings(await dealsOf(await loadScanFolder(AFTER_SCAN5)));
    expect(found.map((f) => [f.kind, f.part])).toEqual([['title_extra_model', 'PCL702B']]);
  });

  it('the right answers stay under each limit: Amazon at most 2.80 times Home Depot, ROI at most 44%, parts at most 1.27 times the regular price', () => {
    const deals = storedDeals(AFTER_SCAN5).filter((b) => b.key !== 'homedepot:344284497');
    let ratio = 0, roi = -Infinity, over = 0;
    for (const b of deals) for (const o of b.options) {
      for (const p of o.parts) {
        const hd = p.prices.find((x) => x.kind === 'homedepot');
        if (p.status === 'matched' && p.price !== null && hd) ratio = Math.max(ratio, p.price / hd.price);
      }
      if (o.estimate) roi = Math.max(roi, o.estimate.roi);
      if (b.regularPrice && o.parts.length > 0 && o.parts.every((p) => p.price !== null)) over = Math.max(over, o.parts.reduce((n, p) => n + p.price! * p.qty, 0) / b.regularPrice);
    }
    expect(Math.round(ratio * 100) / 100).toBe(2.8);
    expect(Math.round(roi * 100) / 100).toBe(0.44);
    expect(Math.round(over * 100) / 100).toBe(1.27);
    expect(ratio).toBeLessThan(SANITY_LIMITS.priceRatio);
    expect(roi).toBeLessThan(SANITY_LIMITS.roi);
    expect(over).toBeLessThan(SANITY_LIMITS.amazonOverRegular);
  });
});

describe('measured on the labelled listings (validation set of Nov 18, audit corpus)', () => {
  interface Cand { asin: string; title: string; price: number | null }
  const results = json<{ bundles: { brand: string; model: string; parts: { model: string; candidates?: Cand[] }[] }[] }>('validation', 'results-2026-11-18.json');
  const labels = json<{ labels: Record<string, Record<string, { correct: string[] | 'none'; uncertain?: string[] }>> }>('validation', 'labels-2026-11-18.json').labels;
  const hd = json<{ prices: Record<string, { price: number | null }> }>('validation', 'hd-part-prices-2026-11-18.json').prices;
  const rows: { brand: string; model: string; title: string; ok: boolean; ratio: number | null }[] = [];
  const seen = new Set<string>();
  for (const b of results.bundles) for (const p of b.parts) {
    const lab = labels[b.model]?.[p.model];
    if (!lab) continue;
    for (const c of p.candidates ?? []) {
      if (seen.has(`${p.model}|${c.asin}`) || (lab.uncertain ?? []).includes(c.asin)) continue;
      seen.add(`${p.model}|${c.asin}`);
      const h = hd[p.model]?.price ?? null;
      rows.push({ brand: b.brand, model: p.model, title: c.title, ok: Array.isArray(lab.correct) && lab.correct.includes(c.asin), ratio: h && c.price ? c.price / h : null });
    }
  }
  const count = (pred: (r: (typeof rows)[number]) => boolean) => ({ right: rows.filter((r) => r.ok && pred(r)).length, wrong: rows.filter((r) => !r.ok && pred(r)).length });

  // Nov 24 (rule D): PBP2003 is matched from the saved listings now (Home Depot's own pack size), so its lookup's search rows
  // left the committed results: 841 wrong became 804, 137 became 136; no right listing changed.
  it('title names another model and not the part: 0 right listings, 804 wrong', () => {
    expect(count((r) => !titleHasModel(r.brand, r.title, r.model) && otherModels(r.brand, r.title, r.model).length > 0)).toEqual({ right: 0, wrong: 804 });
  });

  it('title names the part and another model (not a kit): 1 right listing (P119, a charger that lists what it charges), 136 wrong', () => {
    expect(count((r) => !isKitModel(r.brand, r.model) && titleHasModel(r.brand, r.title, r.model) && otherModels(r.brand, r.title, r.model).length > 0)).toEqual({ right: 1, wrong: 136 });
  });

  it('Amazon against Home Depot sold alone: right listings 0.39 to 1.00 (24); of the wrong ones that name the part, 2 above 3 and 82 below 0.3', () => {
    const right = rows.filter((r) => r.ok && r.ratio !== null).map((r) => r.ratio!);
    expect(right).toHaveLength(24);
    expect(Math.round(Math.min(...right) * 100) / 100).toBe(0.39);
    expect(Math.max(...right)).toBe(1);
    const named = (r: (typeof rows)[number]) => r.ratio !== null && titleHasModel(r.brand, r.title, r.model);
    expect(count((r) => named(r) && r.ratio! > SANITY_LIMITS.priceRatio)).toEqual({ right: 0, wrong: 2 });
    expect(count((r) => named(r) && r.ratio! < SANITY_LIMITS.priceRatioLow)).toEqual({ right: 0, wrong: 82 });
  });

  it('the audit corpus: a pack title on a part not sold as a pack is 42 not-part listings and 1 part (PBP2003, itself a 2-pack)', () => {
    const corpus = json<{ pairs: { part: { brand: string; model: string }; listing: { title: string }; label: string }[] }>('audit', 'corpus.json').pairs;
    const flagged = corpus.filter((c) => packOf(c.listing.title) !== null && !/-[0-9]{1,2}$/.test(c.part.model));
    expect(flagged.filter((c) => c.label === 'not-part')).toHaveLength(42);
    expect(flagged.filter((c) => c.label === 'part').map((c) => c.part.model)).toEqual(['PBP2003']);
    const extra = corpus.filter((c) => !isKitModel(c.part.brand, c.part.model) && titleHasModel(c.part.brand, c.listing.title, c.part.model) && otherModels(c.part.brand, c.listing.title, c.part.model).length > 0);
    expect({ part: extra.filter((c) => c.label === 'part').length, notPart: extra.filter((c) => c.label === 'not-part').length }).toEqual({ part: 1, notPart: 192 });
  });
});

describe('the pieces', () => {
  it('model tokens: models, not units', () => {
    expect(modelTokens('DWST60122-1 Dewalt Pro Backpack x McLaren F1 Team')).toEqual(['DWST60122-1']);
    expect(modelTokens('20V MAX 2-KIT DCK225D2: 20V Lithium-Ion Battery, 2.0Ah, DCD794 Drill, DCF809 Impact Driver')).toEqual(['DCK225D2', 'DCD794', 'DCF809']);
    expect(modelTokens('ONE+ 18V 1.5ah M18 450-CFM Leaf Blower, 125-MPH')).toEqual([]);
    expect(otherModels('RYOBI', 'ONE+ 18V Drill/Driver (Tool Only) PCL206B', 'PCL206')).toEqual([]);
    expect(otherModels('DEWALT', '20V MAX Battery, Compact 2.0Ah Double Pack (DCB203-2)', 'DCB203-2')).toEqual([]);
  });

  it('pack sizes', () => {
    expect(packOf('ONE+ 18V 2.0 AH Compact Battery 2-Pack PBP2003')).toBe(2);
    expect(packOf('Battery, Compact 2.0Ah Double Pack (DCB203-2)')).toBe(2);
    expect(packOf('Pack of 3 blades')).toBe(3);
    expect(packOf('ONE+ 18V 2.0 Ah Lithium-Ion Battery (PBP006)')).toBeNull();
    expect(packOf('ONE+ 18V Backpack Blower')).toBeNull();
  });

  it('one listing counted for two models holds both; RYOBI twins (PCL515, PCL515B) are one model', () => {
    const deals = storedDeals(AFTER_SCAN5);
    // PCL515 and PCL515B share B0B88R7HWB in the recorded data: no finding.
    expect(sanityFindings(deals).filter((f) => f.kind === 'listing_two_models')).toEqual([]);
    // Corrupted: DCS380B's row (B007NVSTCK) counted for DCS369B too.
    const corrupt = deals.map((b) => ({
      ...b, options: b.options.map((o) => ({ ...o, parts: o.parts.map((p) => (p.model === 'DCS369B' ? { ...p, asin: 'B007NVSTCK' } : p)) })),
    }));
    const two = sanityFindings(corrupt).filter((f) => f.kind === 'listing_two_models');
    expect(new Set(two.map((f) => f.part))).toEqual(new Set(['DCS369B', 'DCS380B']));
    expect(two.every((f) => f.severity === 'hold' && f.asin === 'B007NVSTCK')).toBe(true);
  });
});
