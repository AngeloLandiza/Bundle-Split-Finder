// BOGO pairs from the Nov 23 recording (fixtures/homedepot-pages/bogo-2026-11-23.json, read in the owner's Chrome): each
// brand's first Featured BOGO listing page, and each item's price, was-price and conditionalPromotions. The product
// pages are rebuilt in the recorded Apollo shape (base-catalog-<id>, identifiers, the pricing(...) key recorded in
// pricing-2026-11-17.json) from the recorded values; the only invented values are labelled where they appear.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { bogoPromotionsOf, parsePromoPage, parseSearchText, type PromoPage } from '../src/hdPage';
import { MemoryCache } from '../src/serpapi/client';
import { DEFAULT_SETTINGS, BRAND_QUERIES } from '../src/settings';
import {
  bogoDigestLines, bogoGroups, bogoListingPath, findBogoPairs, isBogoListingPath, mergeBogoPairs, pairBundleRecord, pairsBehindBest, readBogoPass,
  type BogoItem, type BogoPair, type ListedItem, type PromoPageOutcome,
} from '../src/tracking/bogoPairs';

interface RecordedItem {
  itemId: string;
  model: string;
  brand: string;
  title: string;
  price: number;
  original: number | null;
  conditionalPromotions: unknown[] | null;
}
const recording = JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/bogo-2026-11-23.json', import.meta.url), 'utf8')) as {
  lists: Record<'ryobi' | 'dewalt', { url: string; listedTotal: number; items: RecordedItem[] }>;
};
const PRICING_KEY = (JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pricing-2026-11-17.json', import.meta.url), 'utf8')) as Record<string, { key: string }>)['328814689']!.key;

const pageText = (it: RecordedItem): string =>
  `window.__APOLLO_STATE__=${JSON.stringify({
    [`base-catalog-${it.itemId}`]: {
      identifiers: { brandName: it.brand, modelNumber: it.model, productLabel: it.title },
      details: { descriptiveAttributes: [], description: null },
      [PRICING_KEY]: { __typename: 'Pricing', value: it.price, original: it.original, conditionalPromotions: it.conditionalPromotions },
    },
  })}`;
const pageOf = (it: RecordedItem): PromoPage => parsePromoPage(pageText(it), it.itemId)!;
const itemOf = (it: RecordedItem): BogoItem => {
  const p = pageOf(it);
  return { ...p, link: `https://www.homedepot.com/p/${it.itemId}`, readAt: 0 };
};
const ryobi = recording.lists.ryobi.items;
const dewalt = recording.lists.dewalt.items;

describe('a BOGO promotion on a product page', () => {
  it('reads the starter kit’s promotion: id, dates, short description; the pair pages carry none', () => {
    const starter = pageOf(ryobi.find((i) => i.model === 'PCL1201K2')!);
    expect(starter).toMatchObject({ brand: 'RYOBI', model: 'PCL1201K2', price: 179, wasPrice: null });
    expect(starter.promotions).toEqual([
      { promotionId: '945815', startsAt: '2026-10-26', endsAt: '2027-01-31', description: 'Purchase Select Ryobi Starter Kit and receive a select FREE Tool' },
    ]);
    const pair = pageOf(ryobi.find((i) => i.model === 'PCL1201K2-PCL515B')!);
    expect(pair).toMatchObject({ price: 179, wasPrice: 268, promotions: [] });
    expect(pageOf(dewalt.find((i) => i.model === 'DCBL722B')!).promotions[0]).toMatchObject({ promotionId: '945972', description: 'BUY A DEWALT CORDLESS KIT GET A FREE BARE TOOL' });
  });

  it('only a BOGO, buyOneGetOne, 100% reward counts (the altered copies are invented)', () => {
    const recorded = ryobi[0]!.conditionalPromotions![0] as Record<string, unknown>;
    expect(bogoPromotionsOf([recorded])).toHaveLength(1);
    const half = { ...recorded, reward: { tiers: [{ rewardPercent: 50 }] } };
    const other = { ...recorded, experienceTag: 'PERCENT_OFF' };
    const sub = { ...recorded, subExperienceTag: 'buyTwoSave' };
    expect(bogoPromotionsOf([half, other, sub])).toEqual([]);
    expect(bogoPromotionsOf(null)).toEqual([]);
  });

  it('two pricing entries that disagree on the promotion give none', () => {
    const it0 = ryobi[0]!;
    const state = JSON.parse(pageText(it0).slice('window.__APOLLO_STATE__='.length)) as Record<string, Record<string, unknown>>;
    state[`base-catalog-${it0.itemId}`]!['pricing({"storeId":"121"})'] = { value: 179, original: null, conditionalPromotions: null };
    expect(parsePromoPage(`window.__APOLLO_STATE__=${JSON.stringify(state)}`, it0.itemId)!.promotions).toEqual([]);
  });
});

describe('the listing address', () => {
  it('is the recorded one for the scan’s queries, with Nao for a later page', () => {
    expect(`https://www.homedepot.com${bogoListingPath(BRAND_QUERIES.RYOBI, 0)}`).toBe(recording.lists.ryobi.url);
    expect(`https://www.homedepot.com${bogoListingPath(BRAND_QUERIES.DEWALT, 0)}`).toBe(recording.lists.dewalt.url);
    expect(bogoListingPath(BRAND_QUERIES.RYOBI, 24)).toMatch(/\?NCNI-5&Nao=24$/);
    expect(isBogoListingPath(bogoListingPath(BRAND_QUERIES.DEWALT, 12))).toBe(true);
    expect(isBogoListingPath('/p/317987584')).toBe(false);
    expect(isBogoListingPath('/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-ryobi?NCNI-5&x=https://evil')).toBe(false);
  });
});

describe('the pair rule', () => {
  it('RYOBI: every PCL1201K2-<tool> at $179 is a pair of the starter kit', () => {
    const pairs = findBogoPairs(ryobi.map(itemOf));
    expect(pairs).toHaveLength(11);
    expect(new Set(pairs.map((p) => p.starterModel))).toEqual(new Set(['PCL1201K2']));
    expect(pairs.map((p) => p.freeModel)).toEqual(['PCL515B', 'PCL430B', 'PCL265B', 'PCL445B', 'P20015BTL', 'PCL525B', 'P755', 'PCL811B', 'PCL615B', 'PCL031B', 'FVD50K']);
    expect(pairs[0]).toMatchObject({ key: 'homedepot:324903619', model: 'PCL1201K2-PCL515B', price: 179, wasPrice: 268, promotionId: '945815', starterItemId: '317987584', endsAt: '2027-01-31' });
  });

  it('DEWALT: DCK200D1P1 + W921B and + WB606 at $299; DCK540D1 and DCK316ST2M1 pairs have no starter on the page, so no claim', () => {
    const pairs = findBogoPairs(dewalt.map(itemOf));
    expect(pairs.map((p) => [p.model, p.starterModel, p.freeModel])).toEqual([
      ['DCK200D1P1W921B', 'DCK200D1P1', '921B'],
      ['DCK200D1P1WB606', 'DCK200D1P1', 'B606'],
    ]);
    // DCBL722B (a bare tool) is a starter too, with no pair on this page.
    expect(pairs.some((p) => p.model.startsWith('DCK540D1') || p.model === 'DCK316ST2M1W60B')).toBe(false);
  });

  it('with a DCK540D1 starter in the listing (invented page: $499, the recorded DEWALT promotion), DCK540D1WDCB606 is a pair; its free item is a battery', () => {
    const promo = dewalt.find((i) => i.model === 'DCK200D1P1')!.conditionalPromotions;
    const starter: RecordedItem = { itemId: '999000001', model: 'DCK540D1', brand: 'DEWALT', title: 'invented', price: 499, original: null, conditionalPromotions: promo };
    const pairs = findBogoPairs([...dewalt, starter].map(itemOf));
    const kit540 = pairs.filter((p) => p.starterModel === 'DCK540D1');
    expect(kit540.map((p) => p.freeModel).sort()).toEqual(['CG407B', 'CH172B', 'CS334B', 'CS382B', 'CS565B', 'CW600B', 'DCB606']);
    // A price one cent off the starter's is no pair.
    expect(findBogoPairs([...dewalt, { ...starter, price: 499.01 }].map(itemOf)).filter((p) => p.starterModel === 'DCK540D1')).toEqual([]);
  });

  it('a model two starters could both explain is no pair, and a starter is never a pair (invented items at $299)', () => {
    const promo = dewalt.find((i) => i.model === 'DCK200D1P1')!.conditionalPromotions;
    const other: RecordedItem = { itemId: '999000002', model: 'DCK200D1', brand: 'DEWALT', title: 'invented', price: 299, original: null, conditionalPromotions: promo };
    // DCK200D1 + W cannot explain DCK200D1P1W921B ("P1W921B" does not follow a W), so the recorded pairs still stand.
    expect(findBogoPairs([...dewalt, other].map(itemOf))).toHaveLength(2);
    // A starter DCK200D1P1W9 is shaped like a DCK200D1P1 pair, but it carries the promotion itself: it is not a pair.
    const twin: RecordedItem = { ...other, itemId: '999000003', model: 'DCK200D1P1W9' };
    // DCK200D1P1W9W21B could be DCK200D1P1 + 9W21B or DCK200D1P1W9 + 21B: no claim.
    const both: RecordedItem = { ...other, itemId: '999000004', model: 'DCK200D1P1W9W21B', conditionalPromotions: null };
    expect(findBogoPairs([...dewalt, twin, both].map(itemOf)).map((p) => p.model)).toEqual(['DCK200D1P1W921B', 'DCK200D1P1WB606']);
  });
});

/** Recorded listing products, as parseSearchText would give them. */
const listedOf = (it: RecordedItem): ListedItem => ({ itemId: it.itemId, brand: it.brand, model: it.model, title: it.title, url: `https://www.homedepot.com/p/${it.itemId}` });

function fakeReaders(pages: Record<string, RecordedItem[]>, opts: { refuse?: string } = {}) {
  const asked = { listing: [] as string[], pages: [] as string[] };
  const byId = new Map(Object.values(pages).flat().map((i) => [i.itemId, i]));
  return {
    asked,
    readListing: async (path: string): Promise<ListedItem[]> => {
      asked.listing.push(path);
      const offset = Number(/Nao=(\d+)/.exec(path)?.[1] ?? 0);
      const brand = path.includes('ryobi') ? 'ryobi' : 'dewalt';
      // The recording holds the first page; a later offset is answered with the same twelve (no new item: the listing ends).
      return (offset === 0 ? pages[brand] ?? [] : (pages[brand] ?? []).slice(0, 12)).map(listedOf);
    },
    readPages: async (ids: string[]): Promise<PromoPageOutcome[]> => {
      asked.pages.push(...ids);
      return ids.map((id) => (id === opts.refuse ? { itemId: id, kind: 'refused', status: 403 } : { itemId: id, kind: 'read', page: pageOf(byId.get(id)!) }));
    },
  };
}

describe('the pass: each brand’s listing, then each item’s page, once a day', () => {
  const day = Date.parse('2026-11-23T15:00:00');

  it('reads the listing until no new item, then the twelve pages, and finds the pairs', async () => {
    const r = fakeReaders({ ryobi, dewalt });
    const cache = new MemoryCache();
    const out = await readBogoPass({ brands: ['DEWALT', 'RYOBI'], queries: BRAND_QUERIES, readListing: r.readListing, readPages: r.readPages, cache, now: () => day });
    expect(out.map((b) => [b.brand, b.complete, b.listingPages, b.listed, b.pagesRead, b.pairs.length])).toEqual([
      ['DEWALT', true, 2, 12, 12, 2],
      ['RYOBI', true, 2, 12, 12, 11],
    ]);
    expect(r.asked.listing[1]).toMatch(/Nao=12$/);
    // The same day: no item page is read again.
    const again = fakeReaders({ ryobi, dewalt });
    const second = await readBogoPass({ brands: ['RYOBI'], queries: BRAND_QUERIES, readListing: again.readListing, readPages: again.readPages, cache, now: () => day + 3_600_000 });
    expect(again.asked.pages).toEqual([]);
    expect(second[0]!.pairs).toHaveLength(11);
    // The next day they are.
    const next = fakeReaders({ ryobi });
    await readBogoPass({ brands: ['RYOBI'], queries: BRAND_QUERIES, readListing: next.readListing, readPages: next.readPages, cache, now: () => day + 86_400_000 });
    expect(next.asked.pages).toHaveLength(12);
  });

  it('a refused page leaves the brand incomplete and reads no later brand', async () => {
    const r = fakeReaders({ ryobi, dewalt }, { refuse: dewalt[3]!.itemId });
    const out = await readBogoPass({ brands: ['DEWALT', 'RYOBI'], queries: BRAND_QUERIES, readListing: r.readListing, readPages: r.readPages, cache: new MemoryCache(), now: () => day });
    expect(out[0]).toMatchObject({ brand: 'DEWALT', complete: false, problem: 'Home Depot refused a BOGO item page.' });
    expect(out[1]).toMatchObject({ brand: 'RYOBI', complete: false, listingPages: 0 });
    expect(r.asked.listing.some((p) => p.includes('ryobi'))).toBe(false);
  });

  it('a listing Chrome could not read is a problem, never an empty promotion', async () => {
    const out = await readBogoPass({
      brands: ['RYOBI'], queries: BRAND_QUERIES, cache: new MemoryCache(), now: () => day,
      readListing: async () => { throw new Error('Chrome did not answer in time.'); },
      readPages: async () => [],
    });
    expect(out[0]).toMatchObject({ complete: false, problem: 'Chrome did not answer in time.', pairs: [] });
  });

  it('the recorded listing shape: a search page state’s base-searchNav entries are the listed items', () => {
    const state = Object.fromEntries(ryobi.map((i) => [`base-searchNav-${i.itemId}`, { itemId: i.itemId, identifiers: { brandName: i.brand, modelNumber: i.model, productLabel: i.title, canonicalUrl: `/p/x/${i.itemId}` } }]));
    expect(parseSearchText(`window.__APOLLO_STATE__=${JSON.stringify(state)}`)!.map((p) => p.model)).toEqual(ryobi.map((i) => i.model));
  });
});

describe('keeping pairs between scans', () => {
  const pairs = findBogoPairs(ryobi.map(itemOf));
  const prior = Object.fromEntries(pairs.map((p) => [p.key, p]));
  it('a complete read replaces the brand; an incomplete one keeps what was found before; an ended promotion goes', () => {
    const fewer = { brand: 'RYOBI', complete: true, listingPages: 1, listed: 2, pagesRead: 2, items: [], pairs: pairs.slice(0, 2), problem: null };
    expect(Object.keys(mergeBogoPairs(prior, [fewer], '2026-11-23'))).toHaveLength(2);
    expect(Object.keys(mergeBogoPairs(prior, [{ ...fewer, complete: false }], '2026-11-23'))).toHaveLength(11);
    expect(mergeBogoPairs(prior, [], '2027-02-01')).toEqual({});
  });

  it('a pair is a bundle record at its price, with its was-price, percent off and the page the pass read', () => {
    const item = itemOf(ryobi[1]!);
    const rec = pairBundleRecord(pairs[0]!, { ...item, bullets: ['Includes: (1) PCL515B'], readAt: 5 }, undefined, 9);
    expect(rec).toMatchObject({ key: 'homedepot:324903619', itemId: '324903619', brand: 'RYOBI', model: 'PCL1201K2-PCL515B', price: 179, regularPrice: 268, percentOff: 33, seenAt: 9, split: null });
    expect(rec.page).toEqual({ bullets: ['Includes: (1) PCL515B'], description: null, readAt: 5 });
  });
});

describe('grouping, ranking and the digest', () => {
  const pairs: BogoPair[] = [...findBogoPairs(ryobi.map(itemOf)), ...findBogoPairs(dewalt.map(itemOf))];
  // Invented estimates: the scan's report for these pairs is not recorded.
  const est = (key: string, profit: number, roi: number, section: 'confirmed' | 'waiting' = 'confirmed') => ({ key, section, estimate: { cost: 190, netRevenue: 190 + profit, profit, roi } });
  const rows = [
    est('homedepot:324903619', 42.1, 0.22), // PCL1201K2-PCL515B
    est('homedepot:337486151', 61.5, 0.32), // PCL1201K2-PCL265B
    est('homedepot:324904496', -3, -0.02), // PCL1201K2-PCL430B
    est('homedepot:337440459', 41.2, 0.13), // DCK200D1P1W921B
    est('homedepot:337440461', 80, 0.25, 'waiting'), // DCK200D1P1WB606, a part still waiting
  ];

  it('groups by starter and ranks by estimate, choices with none last', () => {
    const groups = bogoGroups(pairs, rows);
    const r = groups.find((g) => g.starterModel === 'PCL1201K2')!;
    expect(r.choices).toHaveLength(11);
    expect(r.choices.slice(0, 3).map((c) => c.freeModel)).toEqual(['PCL265B', 'PCL515B', 'PCL430B']);
    expect(r.choices[3]!.profit).toBeNull();
    expect(r.label).toBe('BOGO: 11 free-tool choices — best: PCL265B +$61.50 est.');
    const d = groups.find((g) => g.starterModel === 'DCK200D1P1')!;
    expect(d.label).toBe('BOGO: 2 free-tool choices — best: B606 +$80.00 est.');
    expect(bogoGroups(pairs, []).find((g) => g.starterModel === 'PCL1201K2')!.label).toBe('BOGO: 11 free-tool choices — none has an estimate yet');
    expect(pairsBehindBest([r]).has('homedepot:337486151')).toBe(false);
    expect(pairsBehindBest([r]).has('homedepot:324903619')).toBe(true);
  });

  it('names the best confirmed choice per promotion once a day', () => {
    const now = Date.parse('2026-11-23T15:00:00');
    const groups = bogoGroups(pairs, rows);
    const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 10 };
    const first = bogoDigestLines(groups, alerts, [], now);
    expect(first.lines).toEqual([
      'BOGO: buy PCL1201K2 and choose PCL265B (PCL1201K2-PCL265B) — +$61.50 est., ends Jan 31.',
      // B606 is waiting on a part, so the confirmed 921B is the one named.
      'BOGO: buy DCK200D1P1 and choose 921B (DCK200D1P1W921B) — +$41.20 est., ends Jan 31.',
    ]);
    expect(bogoDigestLines(groups, alerts, first.keys, now + 3_600_000).lines).toEqual([]);
    expect(bogoDigestLines(groups, alerts, first.keys, now + 86_400_000).lines).toHaveLength(2);
    expect(bogoDigestLines(groups, { ...alerts, minProfit: 50 }, [], now).lines).toHaveLength(1);
  });
});
