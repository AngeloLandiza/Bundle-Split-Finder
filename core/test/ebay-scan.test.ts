// Step 10, Task 5: eBay's reference values inside a scan and a report, on the ratchet bundle the Home Depot part
// price tests use (replayed SerpApi responses). eBay is a port and the judge's answers are written here; no network.

import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import type { EbayListing } from '../src/ebay/types';
import { ebayLabel } from '../src/ebay/value';
import type { JudgeCall, ListingJudge } from '../src/judge/types';
import { AnswerRefused } from '../src/scan/answers';
import { bundlesCsv, RUN_COLUMNS } from '../src/scan/csv';
import { applyEbayAnswer, ebayLabelsOf } from '../src/scan/ebayAnswers';
import { type EbayPort, valueOf } from '../src/scan/ebayPass';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type EbayJudgedListing, type EbayValueRecord, type PartPriceReading, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

const T0 = Date.UTC(2026, 10, 19, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };
const FOUNDER = bundleKey('328814689');

const listing = (n: number, over: Partial<EbayJudgedListing> = {}): EbayJudgedListing => ({
  itemId: `v1|${n}|0`, title: `RYOBI PBLRC25B 18V ONE+ ratchet (${n})`, price: 40 + n, currency: 'USD', soldQuantity: 10 * n, url: `https://www.ebay.com/itm/${n}`,
  verdict: 'match', reasons: ['The title names the model.'], ...over,
});

const record = (model: string, listings: EbayJudgedListing[], over: Partial<EbayValueRecord> = {}): EbayValueRecord => ({
  key: `RYOBI:${model}`, brand: 'RYOBI', model, value: valueOf(listings), listings, notJudged: 0, complete: true, checkedAt: T0, ...over,
});

type Deps = Parameters<typeof runScan>[0];

async function world(opts: { ebay?: Deps['ebay']; readPartPrices?: Deps['readPartPrices'] } = {}) {
  const w = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), clock: T0 };
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: w.replay.fetchFn, now: () => w.clock });
  const job = await runScan({ client, budget, store: w.store, settings: RATCHET, now: () => w.clock, ...opts });
  return { ...w, job };
}
const founderOf = async (store: MemoryScanStore) => (await buildReport(store, RATCHET)).bundles.find((b) => b.key === FOUNDER)!;

const noJudge: ListingJudge = { id: 'claude', model: 'claude-haiku-5-5', judge: async (): Promise<JudgeCall> => { throw new Error('not asked'); } };
const emptyEbay = (queries: string[] = []): EbayPort => ({
  async search(q) { queries.push(q); return { total: 0, summaries: [] }; },
  async getItem(): Promise<EbayListing> { throw new Error('no item'); },
});

describe('the scan: the eBay step', () => {
  it('runs after Home Depot\'s part prices, once for each part, and counts its searches', async () => {
    const order: string[] = [];
    const ebay: EbayPort = { async search(q) { order.push(`ebay ${q}`); return { total: 0, summaries: [] }; }, getItem: emptyEbay().getItem };
    const { job, store } = await world({
      readPartPrices: async (parts) => { order.push('hd'); return parts.map((p) => ({ brand: p.brand, model: p.model, status: 'not_found', itemId: null, matchedModel: null, price: null, title: null, link: null }) as PartPriceReading); },
      ebay: { kind: 'run', ebay, judge: noJudge, listingsJudgedPerScan: 60 },
    });
    expect(order).toEqual(['hd', 'hd', 'ebay RYOBI PBLRC01B', 'ebay RYOBI PBLRC25B']);
    expect(job.counts.ebaySearches).toBe(2);
    expect((await store.listEbayValues()).map((r) => [r.key, r.value, r.complete])).toEqual([['RYOBI:PBLRC01B', null, true], ['RYOBI:PBLRC25B', null, true]]);
    expect(job.status).toBe('done');
  });

  it('is skipped with a plain notice when asked to be, and the scan is otherwise as ever', async () => {
    const notice = 'eBay reference values were skipped: add your eBay and Anthropic keys in Settings.';
    const { job, store } = await world({ ebay: { kind: 'skip', notice } });
    expect(job.ebayNotice).toBe(notice);
    expect(job.status).toBe('done');
    expect(await store.listEbayValues()).toEqual([]);
    const plain = await world();
    expect(plain.job.ebayNotice ?? null).toBeNull();
  });

  it('a part checked within the freshness window is not checked again; a part left incomplete is', async () => {
    const first = await world();
    await first.store.putEbayValue(record('PBLRC25B', []));
    await first.store.putEbayValue(record('PBLRC01B', [], { complete: false, notJudged: 1 }));
    const queries: string[] = [];
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: first.cache, fetchFn: first.replay.fetchFn, now: () => T0 + 60_000 });
    await runScan({ client, budget, store: first.store, settings: RATCHET, now: () => T0 + 60_000, ebay: { kind: 'run', ebay: emptyEbay(queries), judge: noJudge, listingsJudgedPerScan: 60 } });
    expect(queries).toEqual(['RYOBI PBLRC01B']);
  });
});

describe('the report: eBay is a reference line, never counted', () => {
  it('a part with a value has an ebay_sold_new price, reference only, carrying its value; a part with none has no eBay price', async () => {
    const w = await world();
    await w.store.putEbayValue(record('PBLRC25B', [listing(1), listing(2), listing(3)]));
    const founder = await founderOf(w.store);
    const part = founder.parts.find((p) => p.model === 'PBLRC25B')!;
    const ebay = part.prices.filter((o) => o.kind === 'ebay_sold_new');
    expect(ebay).toHaveLength(1);
    expect(ebay[0]).toMatchObject({ reference: true, condition: 'new', offers: 3, price: 42, link: 'https://www.ebay.com/itm/3', asin: null });
    expect(ebayLabel(ebay[0]!.ebay!)).toBe('eBay · New · $41.00–$43.00 · 3 listings, 60 sold');
    expect(founder.parts.find((p) => p.model === 'PBLRC01B')!.prices.some((o) => o.kind === 'ebay_sold_new')).toBe(false);
  });

  it('a record with no value gives no eBay price: never $0', async () => {
    const w = await world();
    await w.store.putEbayValue(record('PBLRC25B', [listing(1, { verdict: 'unsure' }), listing(2, { verdict: 'not_match' })]));
    const founder = await founderOf(w.store);
    for (const p of founder.parts) expect(p.prices.some((o) => o.kind === 'ebay_sold_new')).toBe(false);
  });

  it('enters no estimate and no range: every figure is as with no eBay value', async () => {
    const w = await world();
    const without = await founderOf(w.store);
    await w.store.putEbayValue(record('PBLRC25B', [listing(1), listing(2)]));
    await w.store.putEbayValue(record('PBLRC01B', [listing(3)]));
    const withEbay = await founderOf(w.store);
    expect(withEbay.estimate).toEqual(without.estimate);
    expect(withEbay.range).toEqual(without.range);
    expect(withEbay.options.map((o) => [o.estimate, o.range])).toEqual(without.options.map((o) => [o.estimate, o.range]));
    expect(withEbay.parts.map((p) => [p.price, p.availability])).toEqual(without.parts.map((p) => [p.price, p.availability]));
  });

  it('a value found for a RYOBI part\'s twin shows on the part', async () => {
    const w = await world();
    // Written without the tool-only B, as Home Depot's kit pages write it.
    await w.store.putEbayValue(record('PBLRC25', [listing(1)]));
    const part = (await founderOf(w.store)).parts.find((p) => p.model === 'PBLRC25B')!;
    expect(part.prices.some((o) => o.kind === 'ebay_sold_new')).toBe(true);
  });

  it('eBay values are not splitting facts: the catalog and the splits are as before', async () => {
    const w = await world();
    const catalog = await w.store.listCatalog();
    const bundles = (await w.store.listBundles()).map((b) => [b.key, b.split]);
    await w.store.putEbayValue(record('PBLRC25B', [listing(1)]));
    await buildReport(w.store, RATCHET);
    expect(await w.store.listCatalog()).toEqual(catalog);
    expect((await w.store.listBundles()).map((b) => [b.key, b.split])).toEqual(bundles);
  });
});

describe('the questions: an unsure eBay listing that could count', () => {
  it('asks for an unsure listing with a USD price and units sold, for a part a bundle holds, and says why it was unsure', async () => {
    const w = await world();
    await w.store.putEbayValue(record('PBLRC25B', [
      listing(1),
      listing(2, { verdict: 'unsure', reasons: ['The title says "kit".', 'No contents quote shows what the listing includes.'] }),
      listing(3, { verdict: 'unsure', soldQuantity: 0 }),
      listing(4, { verdict: 'unsure', soldQuantity: null }),
      listing(5, { verdict: 'unsure', currency: 'CAD' }),
      listing(6, { verdict: 'not_match' }),
    ]));
    const q = (await buildReport(w.store, RATCHET)).ebayQuestions!;
    expect(q.map((x) => [x.id, x.model, x.title, x.reasons, x.price, x.soldQuantity, x.url])).toEqual([
      ['RYOBI:PBLRC25B|v1|2|0', 'PBLRC25B', 'RYOBI PBLRC25B 18V ONE+ ratchet (2)', ['The title says "kit".', 'No contents quote shows what the listing includes.'], 42, 20, 'https://www.ebay.com/itm/2'],
    ]);
  });

  it('is not asked for a part no bundle holds now, nor once answered', async () => {
    const w = await world();
    await w.store.putEbayValue(record('PCL999B', [listing(7, { verdict: 'unsure' })]));
    expect((await buildReport(w.store, RATCHET)).ebayQuestions).toEqual([]);
    await w.store.putEbayValue(record('PBLRC25B', [listing(2, { verdict: 'unsure', owner: 'not_match', ownerAt: 3 })]));
    expect((await buildReport(w.store, RATCHET)).ebayQuestions).toEqual([]);
  });
});

describe('the owner\'s answer', () => {
  const unsure = [listing(1), listing(2, { verdict: 'unsure' })];

  it('Yes makes the listing a match and counts it; No keeps it out; the answer is the listing\'s verdict and is exported as an owner label', async () => {
    const store = new MemoryScanStore();
    await store.putEbayValue(record('PBLRC25B', unsure));
    expect((await store.getEbayValue('RYOBI:PBLRC25B'))!.value).toMatchObject({ listings: 1, unitsSold: 10 });
    await applyEbayAnswer(store, { key: 'RYOBI:PBLRC25B', itemId: 'v1|2|0', answer: 'yes' }, 77);
    const after = (await store.getEbayValue('RYOBI:PBLRC25B'))!;
    expect(after.value).toMatchObject({ listings: 2, unitsSold: 30, low: 41, high: 42 });
    expect(after.listings[1]).toMatchObject({ verdict: 'unsure', owner: 'match', ownerAt: 77 });
    expect(ebayLabelsOf(await store.listEbayAnswers())).toEqual([
      { itemId: 'v1|2|0', model: 'PBLRC25B', verdict: 'match', labelledBy: 'owner', judged: 'unsure', reasons: ['The title names the model.'], title: 'RYOBI PBLRC25B 18V ONE+ ratchet (2)', url: 'https://www.ebay.com/itm/2', answeredAt: 77 },
    ]);

    const no = new MemoryScanStore();
    await no.putEbayValue(record('PBLRC25B', unsure));
    await applyEbayAnswer(no, { key: 'RYOBI:PBLRC25B', itemId: 'v1|2|0', answer: 'no' }, 78);
    expect((await no.getEbayValue('RYOBI:PBLRC25B'))!.value).toMatchObject({ listings: 1, unitsSold: 10 });
    expect(ebayLabelsOf(await no.listEbayAnswers())[0]).toMatchObject({ verdict: 'not_match', labelledBy: 'owner' });
  });

  it('an answer that gives a value to a part that had none shows the eBay line', async () => {
    const w = await world();
    await w.store.putEbayValue(record('PBLRC25B', [listing(2, { verdict: 'unsure' })]));
    expect((await founderOf(w.store)).parts[0]!.prices.some((o) => o.kind === 'ebay_sold_new')).toBe(false);
    await applyEbayAnswer(w.store, { key: 'RYOBI:PBLRC25B', itemId: 'v1|2|0', answer: 'yes' }, 1);
    expect((await founderOf(w.store)).parts[0]!.prices.some((o) => o.kind === 'ebay_sold_new')).toBe(true);
    expect((await buildReport(w.store, RATCHET)).ebayQuestions).toEqual([]);
  });

  it('refuses what is not an answer, a listing not found, a listing already answered, and one that is not unsure now', async () => {
    const store = new MemoryScanStore();
    await store.putEbayValue(record('PBLRC25B', unsure));
    const refused = async (req: unknown) => applyEbayAnswer(store, req, 1).then(() => null, (e: unknown) => (e instanceof AnswerRefused ? e.message : 'other'));
    expect(await refused(null)).toBe('Choose Yes or No.');
    expect(await refused({ key: 'RYOBI:PBLRC25B', itemId: 'v1|2|0', answer: 'maybe' })).toBe('Choose Yes or No.');
    expect(await refused({ key: 'RYOBI:PBLRC25B', itemId: 'v1|9|0', answer: 'yes' })).toBe('That question was not found.');
    expect(await refused({ key: 'RYOBI:NOPE', itemId: 'v1|2|0', answer: 'yes' })).toBe('That question was not found.');
    expect(await refused({ key: 'RYOBI:PBLRC25B', itemId: 'v1|1|0', answer: 'no' })).toBe('That question changed. Choose again.');
    expect(await refused({ key: 'RYOBI:PBLRC25B', itemId: 'v1|2|0', answer: 'yes' })).toBeNull();
    expect(await refused({ key: 'RYOBI:PBLRC25B', itemId: 'v1|2|0', answer: 'no' })).toBe('That question was already answered.');
    expect((await store.getEbayValue('RYOBI:PBLRC25B'))!.listings[1]!.owner).toBe('match');
  });
});

describe('CSV: ebay_ref_low, ebay_ref_high, ebay_units_sold', () => {
  const last3 = (csv: string): string[] => csv.trimEnd().split('\n')[1]!.split(',').slice(-5, -2);

  it('are the three columns before the confirmed price and its link', () => {
    expect(RUN_COLUMNS.slice(-5, -2)).toEqual(['ebay_ref_low', 'ebay_ref_high', 'ebay_units_sold']);
    expect(RUN_COLUMNS.slice(-2)).toEqual(['confirmed_price', 'confirmed_link']);
    expect(RUN_COLUMNS.slice(-9, -5)).toEqual(['roi_lowest', 'roi_amazon_new', 'roi_highest', 'hd_price_total']);
  });

  it('are blank when no part has an eBay value, and say each part\'s figure in part order, with ? for a part with none', async () => {
    const w = await world();
    expect(last3(bundlesCsv([await founderOf(w.store)]))).toEqual(['', '', '']);
    await w.store.putEbayValue(record('PBLRC25B', [listing(1), listing(2)]));
    const founder = await founderOf(w.store);
    // PBLRC25B is first, PBLRC01B has none.
    expect(last3(bundlesCsv([founder]))).toEqual(['41 | ?', '42 | ?', '30 | ?']);
    await w.store.putEbayValue(record('PBLRC01B', [listing(3)]));
    expect(last3(bundlesCsv([await founderOf(w.store)]))).toEqual(['41 | 43', '42 | 43', '30 | 30']);
  });

  it('are blank for a bundle whose contents are not known', async () => {
    const w = await world();
    const unknown = (await buildReport(w.store, RATCHET)).bundles.find((b) => b.section === 'split');
    if (unknown) expect(last3(bundlesCsv([unknown]))).toEqual(['', '', '']);
  });
});
