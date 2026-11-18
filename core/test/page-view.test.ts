import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { parseBundlePage, parseProductPage, type ProductPage } from '../src/hdPage';
import { applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { notePage, type PageView } from '../src/scan/pageView';
import { buildReport } from '../src/scan/report';
import { NOT_CONFIRMED, runScan } from '../src/scan/runner';
import { type BundleRecord, type BundleRow, DEFAULT_SCAN_SETTINGS, type ScanJob, type ScanSettings } from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

// Step 7, Task 1: a Home Depot product page the owner has open is read, split and matched from
// saved listings exactly as a scan would, and never searched for. Pages are the recorded ones in
// fixtures/homedepot-pages/pages-2026-11-10.json; their prices, which those recordings cut out, are
// the shape captured in fixtures/homedepot-pages/pricing-2026-11-17.json. The scans here run over the
// replay of fixtures/recorded/, through the real SerpApiClient. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 9, 12);
const HOUR = 60 * 60 * 1000;
const VISIT = T0 + 2 * HOUR;
const KEY = 'homedepot:328814689';
const RATCHET: ScanSettings ={ ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

const pages = (JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
  pages: { itemId: string; text: string }[];
}).pages;
const pricing = JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pricing-2026-11-17.json', import.meta.url), 'utf8')) as Record<
  string, { key: string; value: Record<string, unknown> }
>;

/** The recorded page text of `itemId`, as the page's inline script holds it. */
const recordedText = (itemId: string): string => pages.find((p) => p.itemId === itemId)!.text;

/**
 * The recorded page text with a pricing entry put into its product object, in the shape captured on
 * Nov 17 (the recordings of Nov 10 cut pricing out). `value` replaces the captured object's fields.
 */
function pricedText(itemId: string, over: Record<string, unknown> = {}): string {
  const captured = pricing[itemId]!;
  const mark = `"base-catalog-${itemId}":{`;
  const entry = `${JSON.stringify(captured.key)}:${JSON.stringify({ ...captured.value, ...over })},`;
  return recordedText(itemId).replace(mark, mark + entry);
}

/** 328814689 as the owner sees it: the recorded page, priced as captured ($189, was $338). */
const founderPage = (over: Record<string, unknown> = {}): ProductPage => parseProductPage(pricedText('328814689', over), '328814689')!;

/** A recorded page with no pricing in it (the recordings of Nov 10 keep none). */
const unpricedPage = (itemId: string): ProductPage => parseProductPage(recordedText(itemId), itemId)!;

/** Every fetch in a test fails it: a page view never reaches the network. */
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error('A page view must not reach the network.');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** The recorded ratchet scan (test A of scan-runner): 1 listing page, 2 lookups, all from the replay. */
async function ratchetScan(store: MemoryScanStore, policy: BudgetPolicy = { reserve: 0, maxPerRun: 10 }, fetchFn = replayRecorded().fetchFn): Promise<ScanJob> {
  const budget = new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), policy);
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn, now: () => T0 });
  return runScan({ client, budget, store, settings: RATCHET, now: () => T0 });
}

/** Everything the store holds, to show a page view left it as it was. */
async function snapshot(store: MemoryScanStore) {
  const listings = await store.listListings();
  return {
    bundles: await store.listBundles(),
    catalog: await store.listCatalog(),
    listings,
    prices: await Promise.all(listings.map((l) => store.getPrice(l.asin))),
    matches: await store.listMatches(),
    review: await store.listReview(),
    scans: await store.listScans(),
  };
}

const rowOf = async (store: MemoryScanStore, key: string, settings: ScanSettings = RATCHET): Promise<BundleRow> =>
  (await buildReport(store, settings)).bundles.find((b) => b.key === key)!;

const asBundle = (view: PageView) => {
  if (view.kind !== 'bundle') throw new Error(`expected a bundle, got ${view.kind}`);
  return view;
};

describe('parseProductPage', () => {
  it('reads the recorded 328814689 page: brand, model, title, bullets and description; no price, as the recording kept none', () => {
    const text = recordedText('328814689');
    const page = parseProductPage(text, '328814689');
    const content = parseBundlePage(text, '328814689')!;
    expect(page).toEqual({
      itemId: '328814689', brand: 'RYOBI', model: 'PBLRC2501SB',
      title: 'ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
      price: null, wasPrice: null, bullets: content.bullets, description: content.description,
    });
    expect(page!.bullets.length).toBeGreaterThan(0);
  });

  it('reads the price and was-price from the captured pricing shape: 328814689 at $189, was $338; 320243741 at $388, was $488', () => {
    expect(founderPage()).toMatchObject({ price: 189, wasPrice: 338 });
    expect(parseProductPage(pricedText('320243741'), '320243741')).toMatchObject({ model: 'PCL1600K2-P553', price: 388, wasPrice: 488 });
  });

  it('a was-price the pricing does not give, or one that is not a number, is null; so is a price', () => {
    expect(founderPage({ original: null })).toMatchObject({ price: 189, wasPrice: null });
    expect(founderPage({ value: 'n/a', original: '338' })).toMatchObject({ price: null, wasPrice: null });
  });

  it('two pricing entries that disagree give no price (hand-made: the captured key with a second store id)', () => {
    const captured = pricing['328814689']!;
    const mark = '"base-catalog-328814689":{';
    const other = captured.key.replace('8119', '9999');
    const text = recordedText('328814689').replace(
      mark,
      `${mark}${JSON.stringify(captured.key)}:${JSON.stringify(captured.value)},${JSON.stringify(other)}:${JSON.stringify({ ...captured.value, value: 199 })},`,
    );
    expect(parseProductPage(text, '328814689')).toMatchObject({ price: null, wasPrice: null });
  });

  it('null without the page state, for another item id, or without a brand or model', () => {
    expect(parseProductPage('<html></html>', '328814689')).toBeNull();
    expect(parseProductPage(recordedText('328814689'), '320243741')).toBeNull();
    expect(parseProductPage(recordedText('328814689').replace('"modelNumber":"PBLRC2501SB",', ''), '328814689')).toBeNull();
    expect(parseProductPage(recordedText('328814689').replace('"brandName":"RYOBI",', ''), '328814689')).toBeNull();
  });
});

describe('notePage: the founder\'s bundle, 328814689 (acceptance 4)', () => {
  it('on an empty store: a bundle, model PBLRC2501SB, parts PBLRC25B and PBLRC01B, read from the page, with no search', async () => {
    const store = new MemoryScanStore();
    const view = asBundle(await notePage(store, RATCHET, founderPage(), VISIT));
    expect(view).toMatchObject({ kind: 'bundle', key: KEY, itemId: '328814689', model: 'PBLRC2501SB', parts: 2, lookupParts: 2 });
    expect(view.row.parts.map((p) => p.model)).toEqual(['PBLRC25B', 'PBLRC01B']);
    // No listing is saved yet: both parts wait for a lookup, and there is no estimate until they are looked up.
    expect(view.row).toMatchObject({ section: 'waiting', estimate: null, price: 189, regularPrice: 338, percentOff: 44, seenAt: VISIT });
    expect(await store.getBundle(KEY)).toEqual({
      key: KEY, retailer: 'homedepot', itemId: '328814689', title: founderPage().title, brand: 'RYOBI', model: 'PBLRC2501SB', upc: null,
      price: 189, regularPrice: 338, percentOff: 44, link: 'https://www.homedepot.com/p/328814689', seenAt: VISIT,
      split: expect.objectContaining({ status: 'resolved', components: ['PBLRC25B', 'PBLRC01B'] }),
      page: { bullets: founderPage().bullets, description: founderPage().description, readAt: VISIT },
    });
    // Nothing is decided for the parts: no match record, no question, no scan job.
    expect(await store.listMatches()).toEqual([]);
    expect(await store.listReview()).toEqual([]);
    expect(await store.listScans()).toEqual([]);
  });

  it('after the recorded scan: the row the report gives, with no search; nothing left to look up', async () => {
    const store = new MemoryScanStore();
    await ratchetScan(store);
    const before = await rowOf(store, KEY);
    const matches = await store.listMatches();
    const view = asBundle(await notePage(store, RATCHET, founderPage(), VISIT));
    // The page's price is the listing's ($189, $338): only the time it was seen moves, to the visit.
    expect(view.row).toEqual({ ...before, seenAt: VISIT });
    // PBLRC25B's listing at $169 and PBLRC01B's at $146.94, as their lookups priced them.
    expect(view.row).toMatchObject({ section: 'confirmed', estimate: { cost: 189, profit: 79.55 } });
    expect(view.lookupParts).toBe(0);
    expect(await rowOf(store, KEY)).toEqual(view.row);
    expect(await store.listMatches()).toEqual(matches);
  });

  it('with only the saved listings of that scan: parts matched from them, and the estimate a scan gives for nothing', async () => {
    const scanned = new MemoryScanStore();
    await ratchetScan(scanned);
    const listings = await scanned.listListings();
    const seeded = async () => {
      const s = new MemoryScanStore();
      for (const l of listings) await s.putListing(l);
      return s;
    };

    const visited = await seeded();
    const view = asBundle(await notePage(visited, RATCHET, founderPage(), VISIT));

    // The same store, the same bundle record, then a scan that may spend nothing: it splits and matches
    // from the saved listings for free (2c rule 5), and the report gives its row.
    const scanOnly = await seeded();
    const record = (await visited.getBundle(KEY))!;
    await scanOnly.putBundle({ ...record, split: null });
    const refuse = (() => {
      throw new Error('no search');
    }) as unknown as typeof fetch;
    await ratchetScan(scanOnly, { reserve: 0, maxPerRun: 0 }, refuse);
    const scanRow = await rowOf(scanOnly, KEY);

    expect(view.row.parts.map((p) => [p.model, p.status, p.asin, p.grade])).toEqual([
      ['PBLRC25B', 'matched', 'B0B3JWF5ZV', 'probable'],
      ['PBLRC01B', 'matched', 'B0B6Z2ZGVK', 'probable'],
    ]);
    // From saved listings PBLRC01B's listing is $160, the price its row in the PBLRC25B search showed;
    // the lookup's own $146.94 is a price record, which this store does not hold.
    expect(view.row.parts.map((p) => p.price)).toEqual([169, 160]);
    expect(view.row).toMatchObject({ section: 'confirmed', estimate: { cost: 189, profit: 90.65 } });
    expect(view.row.estimate).toEqual(scanRow.estimate);
    expect(view.row.parts).toEqual(scanRow.parts);
    expect(view.row.section).toBe(scanRow.section);
    expect(view.lookupParts).toBe(0);
    expect(await visited.listMatches()).toEqual((await scanOnly.listMatches()).map((m) => ({ ...m, updatedAt: VISIT })));
  });
});

describe('notePage: not a bundle, or not a brand scanned (Review Focus 1)', () => {
  it('a plain kit page (317987591, PCL1600K2) is none, and the store is left as it was', async () => {
    const store = new MemoryScanStore();
    await ratchetScan(store);
    const before = await snapshot(store);
    expect(await notePage(store, RATCHET, unpricedPage('317987591'), VISIT)).toEqual({ kind: 'none' });
    expect(await snapshot(store)).toEqual(before);
  });

  it('a RYOBI bundle with RYOBI turned off in settings is none, and the store is left as it was', async () => {
    const store = new MemoryScanStore();
    await ratchetScan(store);
    const before = await snapshot(store);
    expect(await notePage(store, { ...RATCHET, brands: ['DEWALT'] }, founderPage(), VISIT)).toEqual({ kind: 'none' });
    expect(await snapshot(store)).toEqual(before);
  });

  it('a page whose item id is not digits is none (the page is sent by a content script)', async () => {
    const store = new MemoryScanStore();
    expect(await notePage(store, RATCHET, { ...founderPage(), itemId: '../328814689' }, VISIT)).toEqual({ kind: 'none' });
    expect(await snapshot(store)).toEqual(await snapshot(new MemoryScanStore()));
  });
});

describe('notePage never disturbs a scan job, an owner\'s answer, a Verify result or a newer price (Review Focus 2)', () => {
  it('a running and a stopped scan job are left exactly as they were', async () => {
    const store = new MemoryScanStore();
    await ratchetScan(store, { reserve: 0, maxPerRun: 1 });
    const stopped = (await store.listScans())[0]!;
    expect(stopped.status).toBe('stopped');
    const running: ScanJob = { ...structuredClone(stopped), id: String(T0 + HOUR), startedAt: T0 + HOUR, finishedAt: null, status: 'running', phase: 'parts' };
    await store.putScan(running);
    const before = await store.listScans();
    await notePage(store, RATCHET, founderPage(), VISIT);
    expect(await store.listScans()).toEqual(before);
  });

  it('the owner\'s split answer stands: a second visit neither reopens nor rewrites the question', async () => {
    const store = new MemoryScanStore();
    // PCL500525SB (328690510), a six-digit special buy with no split rule, needs an answer.
    const page = unpricedPage('328690510');
    const first = asBundle(await notePage(store, RATCHET, page, VISIT));
    expect(first.row.status).toBe('needs_review');
    const id = 'split:homedepot:328690510';
    const asked = (await store.getReview(id))!;
    await applyReviewAnswer(store, id, { parts: ['PCL500B', 'PBP005'], seen: reviewSignature(asked) }, VISIT + 1);
    const answered = await store.getReview(id);
    const view = asBundle(await notePage(store, RATCHET, page, VISIT + HOUR));
    expect(await store.getReview(id)).toEqual(answered);
    expect(view.row.parts.map((p) => p.model)).toEqual(['PCL500B', 'PBP005']);
    expect(view.row.answer).not.toBeNull();
  });

  it('a match the owner decided and a Verify result are never judged again from saved listings', async () => {
    const scanned = new MemoryScanStore();
    await ratchetScan(scanned);
    const store = new MemoryScanStore();
    for (const l of await scanned.listListings()) await store.putListing(l);
    // The owner said PBLRC25B has no listing; a Verify sent PBLRC01B's listing to review from its page.
    const owner = {
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'none' as const, asin: null, grade: null, alternatives: [],
      decidedBy: 'user' as const, updatedAt: T0, waitingSince: null,
    };
    const verified = {
      key: 'RYOBI:PBLRC01B', brand: 'RYOBI', model: 'PBLRC01B', status: 'review' as const, asin: null, grade: null, alternatives: [],
      decidedBy: 'auto' as const, updatedAt: T0, waitingSince: null, source: 'page' as const, rejectedAsins: ['B0B6Z2ZGVK'],
    };
    await store.putMatch(owner);
    await store.putMatch(verified);
    await store.putReview({
      id: 'match:RYOBI:PBLRC01B', kind: 'match', subject: 'RYOBI:PBLRC01B', brand: 'RYOBI', model: 'PBLRC01B', title: null, reason: NOT_CONFIRMED,
      candidates: [], choices: [], openedAt: T0, answer: null, answeredAt: null,
    });
    const review = await store.listReview();
    const view = asBundle(await notePage(store, RATCHET, founderPage(), VISIT));
    expect(await store.getMatch('RYOBI:PBLRC25B')).toEqual(owner);
    expect(await store.getMatch('RYOBI:PBLRC01B')).toEqual(verified);
    expect(await store.listReview()).toEqual(review);
    expect(view.lookupParts).toBe(0);
  });

  it('a listing price seen after the visit stays the record\'s; the view still shows the page\'s price', async () => {
    const store = new MemoryScanStore();
    await ratchetScan(store);
    const later = VISIT + HOUR;
    const stored = { ...(await store.getBundle(KEY))!, price: 199, regularPrice: 338, percentOff: 41, seenAt: later };
    await store.putBundle(stored);
    const view = asBundle(await notePage(store, RATCHET, founderPage(), VISIT));
    expect(await store.getBundle(KEY)).toMatchObject({ price: 199, regularPrice: 338, percentOff: 41, seenAt: later });
    expect(view.row).toMatchObject({ price: 189, regularPrice: 338, percentOff: 44, seenAt: VISIT });
    // The view's estimate is the one at the page's price: the report's for a record at $189.
    await store.putBundle({ ...(await store.getBundle(KEY))!, price: 189, percentOff: 44, seenAt: VISIT });
    expect(view.row.estimate).toEqual((await rowOf(store, KEY)).estimate);
  });
});

describe('notePage: the page\'s price and the stored listing\'s (Review Focus 3)', () => {
  const listed = async (): Promise<{ store: MemoryScanStore; stored: BundleRecord }> => {
    const store = new MemoryScanStore();
    await ratchetScan(store);
    const stored = { ...(await store.getBundle(KEY))!, price: 199, percentOff: 41, upc: '033287232581' };
    await store.putBundle(stored);
    return { store, stored };
  };

  it('a visit after the listing was seen: the page\'s price and was-price become the record\'s, seen at the visit; the rest is kept', async () => {
    const { store, stored } = await listed();
    const view = asBundle(await notePage(store, RATCHET, founderPage(), VISIT));
    expect(await store.getBundle(KEY)).toEqual({
      ...stored, title: founderPage().title, price: 189, regularPrice: 338, percentOff: 44, seenAt: VISIT,
      split: expect.objectContaining({ status: 'resolved', components: ['PBLRC25B', 'PBLRC01B'] }),
      page: { bullets: founderPage().bullets, description: founderPage().description, readAt: VISIT },
    });
    // Kept: the barcode and the listing's own link, which the page does not give.
    expect(await store.getBundle(KEY)).toMatchObject({ upc: '033287232581', link: stored.link });
    expect(view.row).toMatchObject({ price: 189, regularPrice: 338, percentOff: 44, seenAt: VISIT });
  });

  it('a page that shows no price changes neither the record\'s price nor its time, and the view shows the stored price', async () => {
    const { store, stored } = await listed();
    const view = asBundle(await notePage(store, RATCHET, unpricedPage('328814689'), VISIT));
    expect(await store.getBundle(KEY)).toMatchObject({ price: 199, regularPrice: 338, percentOff: 41, seenAt: stored.seenAt });
    expect(view.row).toMatchObject({ price: 199, regularPrice: 338, percentOff: 41, seenAt: stored.seenAt });
  });
});

describe('notePage: the open split question (fix round 1)', () => {
  it('328814689 on an empty store: the page names both parts, so the split is read from the page and there is no question', async () => {
    const store = new MemoryScanStore();
    const view = asBundle(await notePage(store, RATCHET, founderPage(), VISIT));
    expect(view.question).toBeNull();
    // With no catalog the model number alone cannot resolve PBLRC2501SB; its Includes list (PBLRC01, PBLRC25) does.
    expect((await store.getBundle(KEY))!.split).toEqual({ status: 'resolved', components: ['PBLRC25B', 'PBLRC01B'], notes: ['split read from the page'] });
    expect(await store.getReview(`split:${KEY}`)).toBeUndefined();
  });

  it('328814689 with its bullets taken out (hand-made from the recording) on an empty store: one question, offering one reading', async () => {
    const store = new MemoryScanStore();
    const view = asBundle(await notePage(store, RATCHET, { ...founderPage(), bullets: [] }, VISIT));
    expect(view.row.status).toBe('needs_review');
    expect(view.question).toEqual(await store.getReview(`split:${KEY}`));
    expect(view.question).toMatchObject({ kind: 'split', subject: KEY, answer: null, openedAt: VISIT, choices: [['PBLRC25B', 'PBLRC01B']] });
  });

  it('328690510 (PCL500525SB, no split rule): the view carries the stored open question, which offers no reading', async () => {
    const store = new MemoryScanStore();
    const view = asBundle(await notePage(store, RATCHET, unpricedPage('328690510'), VISIT));
    expect(view.question).toEqual(await store.getReview('split:homedepot:328690510'));
    expect(view.question).toMatchObject({ kind: 'split', subject: 'homedepot:328690510', answer: null, openedAt: VISIT, choices: [] });
  });

  it('once the owner answers, the split is resolved and the view has no question', async () => {
    const store = new MemoryScanStore();
    const page = unpricedPage('328690510');
    const first = asBundle(await notePage(store, RATCHET, page, VISIT));
    await applyReviewAnswer(store, first.question!.id, { parts: ['PCL500B', 'PBP005'], seen: reviewSignature(first.question!) }, VISIT + 1);
    expect(asBundle(await notePage(store, RATCHET, page, VISIT + HOUR)).question).toBeNull();
  });
});

describe('notePage with write: false (fix round 1)', () => {
  const listingsOnly = async (): Promise<MemoryScanStore> => {
    const scanned = new MemoryScanStore();
    await ratchetScan(scanned);
    const s = new MemoryScanStore();
    for (const l of await scanned.listListings()) await s.putListing(l);
    return s;
  };

  const cases: [string, () => Promise<MemoryScanStore>, () => ProductPage][] = [
    ['parts matched from saved listings', listingsOnly, () => founderPage()],
    ['a new bundle and its split question', async () => new MemoryScanStore(), () => unpricedPage('328690510')],
    ['after the recorded scan, with a running job', async () => {
      const s = new MemoryScanStore();
      await ratchetScan(s, { reserve: 0, maxPerRun: 1 });
      const stopped = (await s.listScans())[0]!;
      await s.putScan({ ...stopped, id: String(T0 + HOUR), startedAt: T0 + HOUR, finishedAt: null, status: 'running' });
      return s;
    }, () => founderPage()],
  ];

  for (const [name, make, page] of cases) {
    it(`${name}: writes nothing, and gives the view a write would`, async () => {
      const store = await make();
      const before = JSON.stringify(await snapshot(store));
      const view = await notePage(store, RATCHET, page(), VISIT, { write: false });
      expect(JSON.stringify(await snapshot(store))).toBe(before);
      const written = await notePage(await make(), RATCHET, page(), VISIT, { write: true });
      expect(view).toEqual(written);
      expect(view.kind).toBe('bundle');
    });
  }

  it('the default writes', async () => {
    const store = new MemoryScanStore();
    await notePage(store, RATCHET, founderPage(), VISIT);
    expect(await store.listBundles()).toHaveLength(1);
  });
});

describe('notePage: a page seen twice', () => {
  it('opens its split question once, keeps when it was opened, and spends nothing', async () => {
    const store = new MemoryScanStore();
    const page = unpricedPage('328690510');
    await notePage(store, RATCHET, page, VISIT);
    const once = await store.listReview();
    expect(once.map((r) => [r.id, r.kind, r.openedAt, r.answer])).toEqual([['split:homedepot:328690510', 'split', VISIT, null]]);
    const view = asBundle(await notePage(store, RATCHET, page, VISIT + HOUR));
    expect(await store.listReview()).toEqual(once);
    expect(view).toMatchObject({ parts: 0, lookupParts: 0, row: { status: 'needs_review', section: 'split' } });
  });

  it('the founder\'s bundle seen twice writes no question and no match', async () => {
    const store = new MemoryScanStore();
    await notePage(store, RATCHET, founderPage(), VISIT);
    await notePage(store, RATCHET, founderPage(), VISIT + HOUR);
    expect(await store.listReview()).toEqual([]);
    expect(await store.listMatches()).toEqual([]);
    expect(await store.listBundles()).toHaveLength(1);
  });
});
