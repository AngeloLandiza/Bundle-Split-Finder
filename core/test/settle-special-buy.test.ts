// Step 16 (round 2): a hyphen split whose reading holds a special buy (PCL406424SB-A21701-A25RS51, the owner's real
// question) used to skip rule 2, so it went straight to a question with nothing read. Now it waits for Home Depot's part
// readings like any split, whatever the number of parts; once every part is read, the question is about the parts Home
// Depot did not confirm. Real data: the owner's scan-3 store (fixtures/e2e-2026-11-23/after-scan3) and the readings his
// Chrome made on Nov 23 (fixtures/homedepot-pages/followup-PCL406424SB-2026-11-23.json).

import { describe, expect, it } from 'vitest';

import type { BundleRecord, PartPriceRecord } from '../src/scan/types';
import { partKey } from '../src/scan/types';
import { homeDepotSplit } from '../src/scan/settle';
import { knownModels, readSplit } from '../src/scan/split';
import { kitIndex } from '../src/kitContents';
import { loadScanFolder } from '../../scripts/data-folder';
import { SEARCHES } from './followup-world';

const BUNDLE = 'homedepot:335724135';

/**
 * A part-price reading as the part-price reader would store it from the recorded search: the row whose own model is the
 * part's. The recording is of Home Depot's search and page, which carry no price: `price` is a stand-in (settle reads only
 * that a price was found); its title, item id and link are the recording's.
 */
function readingOf(model: string, query: string): PartPriceRecord {
  const row = SEARCHES.get(query.toLowerCase())!.results.find((r) => r.model === model);
  return row
    ? { key: partKey('RYOBI', model), brand: 'RYOBI', model, itemId: row.itemId, matchedModel: row.model, price: 1, title: row.title, link: row.url, seenAt: 1, checkedAt: 1 }
    : { key: partKey('RYOBI', model), brand: 'RYOBI', model, itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: 1 };
}

describe('rule 2 with a special buy among the parts', () => {
  it('with nothing read it waits for all three parts: no question while a free read could answer', async () => {
    const store = await loadScanFolder('fixtures/e2e-2026-11-23/after-scan3');
    const bundle = (await store.getBundle(BUNDLE))!;
    const split = readSplit(bundle, await knownModels(store));
    expect(split.status).toBe('needs_review');
    expect(split.waitingFor).toEqual(['PCL406424SB', 'A21701', 'A25RS51']);
  });

  it('read: A21701 is confirmed by its own page, A25RS51 (not sold on Home Depot) by the bundle page\'s Includes line (Nov 24, rule B), PCL406424SB is a special buy, so the question is about it alone', async () => {
    const store = await loadScanFolder('fixtures/e2e-2026-11-23/after-scan3');
    for (const [m, q] of [['PCL406424SB', 'ryobi pcl406424sb'], ['A21701', 'ryobi a21701'], ['A25RS51', 'ryobi a25rs51']] as const) await store.putPartPrice(readingOf(m, q));
    const bundle = (await store.getBundle(BUNDLE))!;
    // Nov 25, rule F off: what this question was before it (core/test/questions-round2.test.ts has it on).
    const known = await knownModels(store);
    const split = readSplit(bundle, { ...known, settle: { ...known.settle, off: ['special_buy_twin'] } });
    expect(split.status).toBe('needs_review');
    expect(split.waitingFor).toBeUndefined();
    expect(split.notes).toContain('Home Depot sells PCL406424SB as a special buy, itself a bundle, so the parts it holds are asked');
    expect(split.notes).not.toContain("Home Depot's search found no A25RS51 sold by itself");
    expect(split.settledParts).toEqual([
      { model: 'A21701', what: '7-Piece 5 in. Random Orbit Sand Paper Assortment Set - 80, 120, and 220 Grit', url: 'https://www.homedepot.com/p/316546864' },
      { model: 'A25RS51', what: 'Includes: A25RS51 1/4 in., 3/8 in., 1/2 in., 5/8 in. straight router bits with a bonus 5/16 in. bit', url: bundle.link! },
    ]);
    expect(split.unsettledParts).toEqual([
      { model: 'PCL406424SB', why: 'special_buy', what: 'ONE+ 18V Cordless 2-Tool Combo Kit with Compact Fixed Base Router and 5 in. Random Orbit Sander (Tools Only)', url: 'https://www.homedepot.com/p/328690521' },
    ]);
    // The reading offered stays the model number's three parts.
    expect(split.alternatives).toEqual([['PCL406424SB', 'A21701', 'A25RS51']]);
  });

  it('Nov 25, rule F: Home Depot sells the same set as PCL424B-PCL406B, so it waits for PCL406B\'s reading, then is PCL406B + PCL424B with the accessories', async () => {
    const store = await loadScanFolder('fixtures/e2e-2026-11-23/after-scan3');
    for (const [m, q] of [['PCL406424SB', 'ryobi pcl406424sb'], ['A21701', 'ryobi a21701'], ['A25RS51', 'ryobi a25rs51']] as const) await store.putPartPrice(readingOf(m, q));
    const bundle = (await store.getBundle(BUNDLE))!;
    // PCL424B was read in scan 3; PCL406B was not: a free read, so no question.
    expect(readSplit(bundle, await knownModels(store)).waitingFor).toEqual(['PCL406B']);
    // The same recorded search ("RYOBI PCL406424SB") shows PCL406B sold by itself.
    await store.putPartPrice(readingOf('PCL406B', 'ryobi pcl406424sb'));
    const split = readSplit(bundle, await knownModels(store));
    expect(split).toMatchObject({ status: 'resolved', components: ['PCL406B', 'PCL424B', 'A21701', 'A25RS51'] });
    expect(split.evidence?.[0]).toMatchObject({ kind: 'hd_same_title', url: expect.stringContaining('/324615781') });
  });

  it('a special buy found on Home Depot is never settled as one part (the key splits PCL500525SB and PSK1212SB into their contents)', () => {
    const found = (model: string, title: string): PartPriceRecord => ({ key: partKey('RYOBI', model), brand: 'RYOBI', model, itemId: '100000000', matchedModel: model, price: 1, title, link: null, seenAt: 1, checkedAt: 1 });
    const data = {
      kitsOf: kitIndex([]),
      partPrices: new Map([
        found('PCL500525SB', 'ONE+ 18V Cordless 2-Tool Combo Kit with 5-1/2 in. Circular Saw and Jig Saw (Tools Only)'),
        found('PSK1212SB', 'ONE+ 18V Starter Kit with (2) 2.0 Ah Batteries and Charger'),
        found('PBP003', 'ONE+ 18V 4.0 Ah Lithium-Ion HIGH PERFORMANCE Battery'), found('PCL265B', 'ONE+ 18V Cordless 3/8 in. Impact Wrench (Tool Only)'),
      ].map((r) => [r.key, r] as const)),
    };
    for (const [model, title] of [['PCL500525SB-PBP003', 'ONE+ 18V 2-Tool Combo Kit with Circular Saw, Jig Saw and 4.0 Ah Battery'], ['PSK1212SB-PCL265B', 'ONE+ 18V Starter Kit with Impact Wrench']] as const) {
      const bundle = { brand: 'RYOBI', model, title, link: null, page: null } as unknown as BundleRecord;
      const parts = model.split('-');
      const out = homeDepotSplit(bundle, { components: parts, status: 'needs_review', notes: ['hyphen split, but a part is not in the catalog'], alternatives: [parts] }, new Map(), data)!;
      expect(out.status).toBe('needs_review');
      expect(out.unsettledParts?.[0]).toMatchObject({ model: parts[0], why: 'special_buy' });
    }
  });
});
