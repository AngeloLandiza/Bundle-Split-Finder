import { describe, expect, it, test } from 'vitest';

import { catalogEntry, decompose, decomposeDewalt, decomposeRyobi, kindsFromTitle, reconcile } from '../src/decompose';
import { componentItemIds, findProductBlock, parseProductJsonLd } from '../src/hdPage';
import { isValidGtin, toUpc12 } from '../src/identifiers';
import { grade, hasModelToken, pick, type Wanted } from '../src/match';
import { amazonNet, bundleProfit, DEFAULT_FEES, route } from '../src/money';
import { allPlans, bestPlan, type Listing } from '../src/optimize';
import { evaluateBundle } from '../src/scanPlan';
import * as fx from './fixtures';

const WANT_3_8: Wanted = { brand: 'RYOBI', model: 'PBLRC25B' };
const WANT_1_4: Wanted = { brand: 'RYOBI', model: 'PBLRC01B', upc: '33287193714' };

describe('barcodes', () => {
  it('validates and normalises the real barcodes', () => {
    expect(isValidGtin(fx.HD_BUNDLE.gtin13)).toBe(true);
    expect(toUpc12(fx.HD_BUNDLE.gtin13)).toBe(fx.HD_BUNDLE.upc); // 13 digits -> 12
    expect(toUpc12('33287193714')).toBe('033287193714'); // leading zero dropped by a price site
    expect(toUpc12('033287193714')).toBe('033287193714');
  });

  it('refuses bad barcodes', () => {
    expect(toUpc12('033287193715')).toBeNull(); // wrong check digit
    expect(toUpc12('4892210138033')).toBeNull(); // a true EAN-13, not a US UPC
    expect(toUpc12('')).toBeNull();
    expect(toUpc12(null)).toBeNull();
  });
});

describe('Home Depot page', () => {
  it('reads price, model, barcode and component ids from the captured page data', () => {
    const block = findProductBlock([{ '@type': 'WebPage' }, fx.HD_JSONLD]);
    const p = parseProductJsonLd(block);
    expect(p).toMatchObject({ model: 'PBLRC2501SB', brand: 'RYOBI', upc: '033287232581', price: 189, regularPrice: 338 });
    expect(componentItemIds(fx.HD_REVIEW_SNIPPET, p.itemId!)).toEqual(['316631066', '316631068']);
  });

  it('survives a page with no product block', () => {
    expect(findProductBlock([{ '@type': 'WebPage' }])).toBeNull();
    expect(parseProductJsonLd(null).model).toBeNull();
  });
});

describe('splitting bundles', () => {
  it('gets the same parts from both RYOBI model-number forms', () => {
    const newForm = decomposeRyobi(fx.HD_BUNDLE.model, fx.RYOBI_CATALOG);
    const oldForm = decomposeRyobi(fx.HD_OLD_BUNDLE_MODEL, fx.RYOBI_CATALOG);
    expect(newForm.status).toBe('resolved');
    expect(oldForm.status).toBe('resolved');
    expect(new Set(newForm.components)).toEqual(new Set(['PBLRC01B', 'PBLRC25B']));
    expect(new Set(oldForm.components)).toEqual(new Set(['PBLRC01B', 'PBLRC25B']));
  });

  it('sends unknown RYOBI parts to review instead of guessing', () => {
    const d = decomposeRyobi('PBLXX9988SB', fx.RYOBI_CATALOG);
    expect(d).toMatchObject({ status: 'needs_review', components: [] });
    // The expansion is offered for the owner to confirm, never taken (Ruling 29).
    expect(d.alternatives).toEqual([['PBLXX99B', 'PBLXX88B']]);
  });

  describe('a RYOBI model number that spells out its parts offers that reading, in review (Ruling 29)', () => {
    const HYPHEN_NOTE = 'hyphen split, but a part is not in the catalog';

    it('hyphen form, a part not in the catalog: today\'s split, plus the reading the model number spells out', () => {
      // PCL1600K2-P553 is item 320243741 of the recorded "ryobi 18v combo kit" search.
      expect(decomposeRyobi('PCL1600K2-P553', new Map())).toEqual({
        components: ['PCL1600K2', 'P553'], status: 'needs_review', notes: [HYPHEN_NOTE], alternatives: [['PCL1600K2', 'P553']],
      });
      // An accessory part is still a part the model number names (345178210 in the same search).
      expect(decomposeRyobi('PCL1600K2-A983002', new Map()).alternatives).toEqual([['PCL1600K2', 'A983002']]);
      // A special buy inside a hyphen bundle is offered as written; it is not expanded (decisions.md, known gaps).
      expect(decomposeRyobi('PBLRC2501SB-A13401', new Map()).alternatives).toEqual([['PBLRC2501SB', 'A13401']]);
    });

    it('hyphen form: a token that is not a model number gives no reading, and the split is as before', () => {
      // Constructed: an empty part, a pack count, a word, and spaces around the hyphen.
      // Also a pack size, a voltage and a short version tag: a part must start with a letter and be four characters or more.
      for (const model of ['PCL1600K2-', '-P553', 'PCL1600K2--P553', 'DCB205-2', 'PCL1600K2-KIT', 'PCL1600K2 - P553', 'PCL1600K2-2PK', 'PCL1600K2-18V', 'PCL1600K2-V2']) {
        const d = decomposeRyobi(model, new Map());
        expect(d, model).toEqual({ components: model.toUpperCase().trim().split('-'), status: 'needs_review', notes: [HYPHEN_NOTE] });
      }
    });

    it('special-buy form, parts not in the catalog: today\'s split, plus the expansion the rule makes', () => {
      expect(decomposeRyobi(fx.HD_BUNDLE.model, new Map())).toEqual({
        components: [], status: 'needs_review', notes: ['special-buy pattern, parts not in catalog'], alternatives: [['PBLRC25B', 'PBLRC01B']],
      });
    });

    it('a resolved split, or a model with no pattern, offers nothing', () => {
      expect(decomposeRyobi(fx.HD_BUNDLE.model, fx.RYOBI_CATALOG).alternatives).toBeUndefined();
      expect(decomposeRyobi(fx.HD_OLD_BUNDLE_MODEL, fx.RYOBI_CATALOG).alternatives).toBeUndefined();
      // 328690510's six-digit special buy has no split rule (decisions.md, known gaps).
      expect(decomposeRyobi('PCL500525SB', new Map())).toEqual({ components: [], status: 'needs_review', notes: ['no known RYOBI bundle pattern'] });
    });
  });

  test.each(fx.HD_DEWALT_BUNDLES)('splits Home Depot DEWALT bundle %s', (model, title, expected) => {
    const d = decomposeDewalt(model, title, fx.DEWALT_CATALOG);
    expect(d.status, d.notes.join('; ')).toBe('resolved');
    expect(d.components).toEqual(expected);
  });

  it('flags a DEWALT short code that fits two tools', () => {
    const d = decomposeDewalt(...fx.HD_DEWALT_AMBIGUOUS, fx.DEWALT_CATALOG);
    expect(d.status).toBe('needs_review');
    expect(d.notes[0]).toContain('DCF891B');
    expect(d.notes[0]).toContain('DCF921B');
  });

  it('lists both whole readings of a short code that fits two tools, for the owner to choose from', () => {
    const d = decomposeDewalt(...fx.HD_DEWALT_AMBIGUOUS, fx.DEWALT_CATALOG);
    expect(d.alternatives).toEqual([['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']]);
  });

  it('lists every way a glued short code can be cut, sorted by their parts', () => {
    // Constructed: no recorded bundle is glued two ways. '205' + '205' is DCB205 twice; '2052' + '05'
    // is DCB205-2 and DCB205 (the title's batteries rule out DCD805B, which also ends in 05B).
    const d = decomposeDewalt('DCK940D2W205205', '20V MAX Cordless 9 Tool Combo Kit with (4) 20V 5.0Ah Batteries', fx.DEWALT_CATALOG);
    expect(d).toMatchObject({ components: ['DCK940D2'], status: 'needs_review', notes: ["'205205' can be split more than one way"] });
    expect(d.alternatives).toEqual([['DCK940D2', 'DCB205', 'DCB205'], ['DCK940D2', 'DCB205-2', 'DCB205']]);
  });

  it('lists no alternatives for a resolved split or a short code that matches nothing', () => {
    for (const [model, title] of fx.HD_DEWALT_BUNDLES) expect(decomposeDewalt(model, title, fx.DEWALT_CATALOG).alternatives).toBeUndefined();
    const nothing = decomposeDewalt('DCK2100W354606', '', new Map());
    expect(nothing.notes).toEqual(["'354606' matches nothing in the catalog"]);
    expect(nothing.alternatives).toBeUndefined();
  });

  it('routes by brand and refuses brands it has no rules for', () => {
    expect(decompose('ryobi', fx.HD_BUNDLE.model, fx.HD_BUNDLE.title, fx.RYOBI_CATALOG).status).toBe('resolved');
    expect(decompose('Milwaukee', '2997-22', 'M18 FUEL 2-Tool Combo Kit', new Map()).status).toBe('needs_review');
  });

  it('reads tool types from titles without double counting', () => {
    expect(kindsFromTitle('20V MAX XR Hammer Drill and ATOMIC Impact Driver Combo Kit')).toEqual(['impact driver', 'hammer drill']);
    expect(kindsFromTitle('20V MAX XR Cordless Brushless Jigsaw')).toEqual(['jigsaw']);
    expect(catalogEntry('DEWALT', 'dcf891b', '20V MAX XR 1/2 in. Mid-Range Impact Wrench (Tool Only)')).toMatchObject({
      model: 'DCF891B',
      kinds: ['impact wrench'],
      isKit: false,
    });
    expect(catalogEntry('DEWALT', 'DCK940D2', '20V MAX Cordless 9 Tool Combo Kit').isKit).toBe(true);
  });

  it('agrees across two signals on the real page, and reports a conflict', () => {
    const fromModel = decomposeRyobi(fx.HD_BUNDLE.model, fx.RYOBI_CATALOG).components;
    const fromPage = fx.HD_BUNDLE.reviewProductIds.filter((i) => i !== fx.HD_BUNDLE.productID).map((i) => fx.HD_ITEM_MODEL[i]!);
    expect(reconcile(fromModel, fromPage).confidence).toBe('high');
    expect(reconcile(['PBLRC01B'], ['PBLRC25B']).confidence).toBe('conflict');
    expect(reconcile(['PBLRC01B'], []).confidence).toBe('medium');
  });
});

describe('matching Amazon listings', () => {
  it('matches model numbers on whole tokens only', () => {
    expect(hasModelToken('RYOBI ratchet PBLRC25B tool only', 'PBLRC25B')).toBe(true);
    expect(hasModelToken('RYOBI PBLRC2501SB two ratchets', 'PBLRC25B')).toBe(false);
    expect(hasModelToken('RYOBI PBLRC25BK kit', 'PBLRC25B')).toBe(false);
  });

  it('accepts his two real listings from detail-page data', () => {
    expect(grade(WANT_3_8, fx.ASIN_3_8)).toMatchObject({ grade: 'strong', packaging: 'retail' });
    expect(grade(WANT_1_4, fx.ASIN_1_4)).toMatchObject({ grade: 'exact', packaging: 'retail' });
  });

  it('grades a bare search result as probable, because it shows no barcode', () => {
    expect(grade(WANT_3_8, fx.ASIN_3_8_SEARCH_RESULT).grade).toBe('probable');
  });

  test.each([
    ['renewed listing', fx.DECOY_RENEWED, 'reject'],
    ['other model', fx.DECOY_OTHER_MODEL, 'reject'],
    ['kit variant', fx.DECOY_KIT, 'reject'],
    ['2-pack', fx.DECOY_2PACK, 'reject'],
    ['other brand', fx.DECOY_BRAND, 'reject'],
    ['aftermarket part', fx.DECOY_AFTERMARKET, 'reject'],
    ['brand not confirmed', fx.DECOY_NO_BRAND_IN_TITLE, 'review'],
    ['the 1/4 in. listing for the 3/8 in. tool', fx.ASIN_1_4, 'reject'],
  ] as const)('handles decoy: %s', (_name, cand, expected) => {
    expect(grade(WANT_3_8, cand).grade).toBe(expected);
  });

  it('labels a bulk-packaged listing, which may be chosen when it is the only one (PO, Nov 18: New is enough)', () => {
    expect(grade(WANT_3_8, fx.DECOY_BULK)).toMatchObject({ grade: 'strong', packaging: 'bulk' });
    expect(pick(WANT_3_8, [fx.DECOY_BULK]).chosen).toMatchObject({ asin: 'DECOY-BULK', grade: 'strong', packaging: 'bulk' });
  });

  it('matches a 2-pack component to a 2-pack listing only', () => {
    const two = { asin: 'X', title: 'DEWALT 20V MAX 5.0Ah Battery (2-Pack) DCB205-2', brand: 'DEWALT', partNumber: 'DCB205-2' };
    expect(grade({ brand: 'DEWALT', model: 'DCB205-2', packQty: 2 }, two).grade).toBe('strong');
    expect(grade({ brand: 'DEWALT', model: 'DCB205' }, two).grade).toBe('reject');
  });

  it('picks the best grade, then organic, then most reviews', () => {
    const a = { asin: 'A', title: 'RYOBI Ratchet PBLRC25B', reviews: 10 };
    const b = { asin: 'B', title: 'RYOBI Extended Reach Ratchet PBLRC25B', reviews: 181 };
    const ad = { asin: 'AD', title: 'RYOBI Ratchet PBLRC25B Tool Only', reviews: 900, sponsored: true };
    const picked = pick(WANT_3_8, [a, ad, b, fx.DECOY_RENEWED, fx.DECOY_NO_BRAND_IN_TITLE]);
    expect(picked.chosen?.asin).toBe('B');
    expect(picked.alternatives.map((g) => g.asin)).toEqual(['A', 'AD']);
    expect(picked.review.map((g) => g.asin)).toEqual(['DECOY-NOBRAND']);
    // A verified listing beats a more popular unverified one.
    expect(pick(WANT_3_8, [b, fx.ASIN_3_8]).chosen?.grade).toBe('strong');
  });
});

describe('listing combinations', () => {
  const parts = { TOOL: 1, BATT: 2, CHARGER: 1 };
  const liq = { CHARGER: 12, BATT: 25 };
  const base: Listing[] = [
    { id: 'A-TOOL', covers: { TOOL: 1 }, net: 90 },
    { id: 'A-BATT', covers: { BATT: 1 }, net: 40 },
    { id: 'A-BATT2', covers: { BATT: 2 }, net: 95 },
    { id: 'A-STARTER', covers: { BATT: 1, CHARGER: 1 }, net: 70 },
  ];

  it('prefers the mix that pays most, and switches when a price changes', () => {
    // tool 90 + starter kit 70 + single battery 40 = 200 beats 2-pack 95 + charger 12 + tool 90 = 197
    expect(bestPlan(parts, base, liq)).toEqual({ totalNet: 200, listings: ['A-BATT', 'A-STARTER', 'A-TOOL'], liquidated: [] });
    const dearer = base.map((l) => (l.id === 'A-BATT2' ? { ...l, net: 110 } : l));
    expect(bestPlan(parts, dearer, liq)).toMatchObject({ totalNet: 212, liquidated: ['CHARGER'] });
  });

  it('liquidates unlisted parts instead of dropping them', () => {
    expect(bestPlan({ TOOL: 1, BAG: 1 }, [{ id: 'A', covers: { TOOL: 1 }, net: 50 }], { BAG: 8 })).toMatchObject({
      totalNet: 58,
      liquidated: ['BAG'],
    });
  });

  it('lists every distinct combination', () => {
    const plans = allPlans(
      { BATT: 2 },
      [
        { id: 'ONE', covers: { BATT: 1 }, net: 40 },
        { id: 'TWO', covers: { BATT: 2 }, net: 95 },
      ],
      { BATT: 25 },
    );
    const seen = new Set(plans.map((p) => `${p.listings.join('+')}/${p.liquidated.join('+')}`));
    expect(seen).toEqual(new Set(['TWO/', 'ONE+ONE/', 'ONE/BATT', '/BATT+BATT']));
    expect(plans[0]!.listings).toEqual(['TWO']);
  });

  it('equals a brute-force search on 500 random bundles', () => {
    // Small seeded generator so the run is repeatable.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

    for (let round = 0; round < 500; round++) {
      const names = Array.from({ length: int(1, 5) }, (_, i) => `C${i}`);
      const comps = Object.fromEntries(names.map((n) => [n, int(1, 3)]));
      const listings: Listing[] = Array.from({ length: int(0, 7) }, (_, k) => {
        const cover = names.filter(() => rnd() < 0.5).slice(0, 3);
        const picked = cover.length ? cover : [names[0]!];
        return { id: `L${k}`, covers: Object.fromEntries(picked.map((m) => [m, int(1, 2)])), net: Math.round(rnd() * 19500 + 500) / 100 };
      });
      const liqd = Object.fromEntries(names.map((n) => [n, Math.round(rnd() * 4000) / 100]));

      // Brute force: try every count of every listing.
      const caps = listings.map((l) => Math.min(...Object.entries(l.covers).map(([m, q]) => Math.floor(comps[m]! / q))));
      let best = -1;
      const counts = caps.map(() => 0);
      for (;;) {
        const left = { ...comps };
        let ok = true;
        let net = 0;
        listings.forEach((l, i) => {
          for (const [m, q] of Object.entries(l.covers)) {
            left[m]! -= q * counts[i]!;
            if (left[m]! < 0) ok = false;
          }
          net += l.net * counts[i]!;
        });
        if (ok) best = Math.max(best, net + names.reduce((s, n) => s + liqd[n]! * left[n]!, 0));
        let pos = 0;
        while (pos < counts.length && counts[pos] === caps[pos]) counts[pos++] = 0;
        if (pos === counts.length) break;
        counts[pos]! += 1;
      }

      expect(bestPlan(comps, listings, liqd).totalNet).toBeCloseTo(best, 2);
      expect(allPlans(comps, listings, liqd, 100000)[0]!.totalNet).toBeCloseTo(best, 2);
    }
  });
});

describe('money and packaging', () => {
  it('does the fee math', () => {
    expect(amazonNet(169)).toBe(143.65);
    expect(amazonNet(1)).toBe(0.7); // $0.30 minimum referral fee
    expect(amazonNet(169, { ...DEFAULT_FEES, referralRate: 0.12, fulfillmentFee: 8 })).toBe(140.72);
    expect(bundleProfit(189, 287.3)).toEqual({ cost: 189, netRevenue: 287.3, profit: 98.3, roi: 0.5201 });
    expect(bundleProfit(100, 150, { ...DEFAULT_FEES, salesTaxRate: 0.1, inboundCost: 5 }).cost).toBe(115);
  });

  it('never sends unconfirmed packaging to Amazon as New', () => {
    expect(route('retail_boxed')).toMatchObject({ channel: 'amazon', condition: 'new' });
    expect(route('loose')).toMatchObject({ channel: 'ebay', condition: 'new_other' });
    expect(route('unknown').channel).toBe('ebay');
  });
});

describe("the founder's example, end to end", () => {
  it('turns PBLRC2501SB at $189 into his two ASINs and a profit estimate', () => {
    const b = fx.HD_BUNDLE;
    expect(toUpc12(b.gtin13)).not.toBeNull();

    const parts = decomposeRyobi(b.model, fx.RYOBI_CATALOG).components;
    const pool = [fx.ASIN_3_8, fx.ASIN_1_4, fx.DECOY_RENEWED, fx.DECOY_OTHER_MODEL, fx.DECOY_KIT, fx.DECOY_2PACK, fx.DECOY_BRAND];
    const upcs: Record<string, string | null> = { PBLRC01B: '033287193714', PBLRC25B: null };

    const priced = parts.map((model) => {
      const picked = pick({ brand: 'RYOBI', model, upc: upcs[model] }, pool);
      expect(picked.chosen, model).not.toBeNull();
      expect(picked.review).toEqual([]);
      // Illustrative price: half of Home Depot's $338 regular price for the pair.
      return { asin: picked.chosen!.asin, covers: { [model]: 1 }, price: b.strikethroughPrice / 2 };
    });

    const evaluation = evaluateBundle(b.price, Object.fromEntries(parts.map((m) => [m, 1])), priced);
    // The two ASINs the founder gave by hand.
    expect(evaluation.plan.listings).toEqual(['B0B3JWF5ZV', 'B0B6Z2ZGVK']);
    expect(evaluation.result.profit).toBe(98.3);
    expect(evaluation.uncovered).toEqual([]);
  });

  it('shows a part with no listing as uncovered, valued at the liquidation rate', () => {
    const e = evaluateBundle(189, { PBLRC25B: 1, PBLRC01B: 1 }, [{ asin: 'B0B3JWF5ZV', covers: { PBLRC25B: 1 }, price: 169 }], DEFAULT_FEES, 0.5);
    expect(e.uncovered).toEqual(['PBLRC01B']);
    expect(e.plan.totalNet).toBe(143.65 + 47.25);
  });
});
