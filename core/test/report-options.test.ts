import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { type PageContent, parseBundlePage } from '../src/hdPage';
import { evaluateBundle } from '../src/scanPlan';
import { applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { runPaid } from '../src/scan/paid';
import { buildReport } from '../src/scan/report';
import { applyLookup, matchFromListings, type PartContext, runScan, sendLookup } from '../src/scan/runner';
import { knownModels } from '../src/scan/split';
import {
  bundleKey, type BundleRecord, type BundleRow, DEFAULT_SCAN_SETTINGS, type PageOutcome, partKey, type ReadPages, type ReviewAnswer, type ScanCounts,
  type ScanSettings,
} from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

// Ways to sell a bundle that holds a kit (step 6). The replayed tests run the real pipeline over the
// recorded Home Depot searches, the recorded Home Depot pages and the recorded Amazon searches; nothing
// reaches the network. Hand-made matches appear only in the primary-rule tests, as the plan allows.

const T0 = Date.UTC(2026, 10, 11, 12);
const P553 = 'homedepot:320243741';
const KIT = 'homedepot:317987591';
const QUESTION = `split:${P553}`;

/** The recorded "ryobi 18v combo kit" page as a catalog (PCL1600K2 is a kit there), then filtered to Home Depot's bundles (every row a bundle). */
const KITS: ScanSettings = {
  ...DEFAULT_SCAN_SETTINGS, brands: ['RYOBI'], catalogPagesPerScan: 0,
  queries: [{ q: 'ryobi 18v combo kit' }, { q: 'ryobi 18v combo kit', filterTokens: 'bwo64,m5d', bundlesOnly: true }],
};
/** The recorded RYOBI brand page alone: one search, at a run limit of 5 (a fifth of the allowance). */
const BRAND_PAGE: ScanSettings = { ...KITS, queries: [], catalogPagesPerScan: 1 };

/** PCL1600K2's items as 317987591's page lists them. */
const KIT_MODELS = ['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL430', 'PCL660', 'PBP005', 'PBP002'];
const UNNAMED = [
  '18T Carbide Blade', 'Hex Wrench', 'Reciprocating Saw Blade', 'Hex Key', 'Flush Cut Blade', 'Plunge Cut Blade', '6 in. Wood Blade', 'Sanding Pad',
  '5-Pieces Sandpaper', '18V. Charger', 'Tool Bag',
];

const PAGES = (
  JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: { itemId: string; text: string }[];
  }
).pages;

function page(itemId: string): PageContent {
  const rec = PAGES.find((p) => p.itemId === itemId);
  const content = rec ? parseBundlePage(rec.text, itemId) : null;
  if (!content) throw new Error(`no readable recorded page ${itemId}`);
  return content;
}

/** Reads the recorded page of each bundle that has one; the others are unreadable. */
const recordedPages: ReadPages = async (ids) => ids.map((itemId): PageOutcome => {
  const rec = PAGES.find((p) => p.itemId === itemId);
  const content = rec ? parseBundlePage(rec.text, itemId) : null;
  return content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' };
});

interface World {
  store: MemoryScanStore;
  cache: MemoryCache;
  replay: Replay;
  ledger: string[];
}

function paid(w: World, policy: BudgetPolicy) {
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), policy);
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: w.replay.fetchFn, now: () => T0, onSpend: (e) => void w.ledger.push(e.label) });
  return { budget, client };
}

/**
 * The brand page, then both listing pages with the bundles' recorded pages; every lookup waits. Then the
 * owner answers PCL1600K2-P553's split question, by default with its one choice: PCL1600K2 + P553.
 */
async function answered(opts: { pages?: boolean; answer?: 'choice' | 'none' | string[]; settings?: ScanSettings } = {}): Promise<World> {
  const w: World = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), ledger: [] };
  const settings = opts.settings ?? KITS;
  await runScan({ ...paid(w, { reserve: 0, maxPerRun: 5 }), store: w.store, settings: BRAND_PAGE, now: () => T0 });
  await runScan({ ...paid(w, { reserve: 0, maxPerRun: settings.queries.length }), store: w.store, settings, now: () => T0, readPages: opts.pages === false ? undefined : recordedPages });
  expect(w.ledger).toEqual(['scan:catalog:RYOBI:p1', ...settings.queries.map(() => 'scan:listing:ryobi 18v combo kit:p1')]);
  const question = (await w.store.getReview(QUESTION))!;
  expect(question.choices).toEqual([['PCL1600K2', 'P553']]);
  const seen = reviewSignature(question);
  const a = opts.answer ?? 'choice';
  const answer: ReviewAnswer = a === 'choice' ? { choice: 0, seen } : a === 'none' ? { none: true, seen } : { parts: a, seen };
  await applyReviewAnswer(w.store, QUESTION, answer, T0);
  return w;
}

/** The owner's Look up in the panel, as the worker runs it. */
async function lookUp(w: World, models: string[]): Promise<void> {
  await runPaid({ ...paid(w, { reserve: 0, maxPerRun: 20 }), store: w.store, now: () => T0, settings: KITS }, {
    kind: 'lookUp', parts: models.map((model) => ({ brand: 'RYOBI', model })),
  });
}

const NO_COUNTS: ScanCounts = {
  pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
  catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0,
};

/**
 * The kit's items looked up by the scan's own steps, as the panel's Look up runs them: a saved listing
 * first (free), else one replayed search. Until Task 3 the Look up itself asks only for a split's parts.
 */
async function lookUpItems(w: World, models: string[]): Promise<void> {
  const known = await knownModels(w.store);
  const ctx: PartContext = {
    ...paid(w, { reserve: 0, maxPerRun: 20 }), store: w.store, settings: KITS, now: () => T0, prefix: 'panel', catalog: known.catalog, job: { counts: { ...NO_COUNTS } },
  };
  for (const model of models) {
    if (await matchFromListings(ctx, known.listings, { key: partKey('RYOBI', model), brand: 'RYOBI', model })) continue;
    const step = { kind: 'lookup', brand: 'RYOBI', model } as const;
    const result = await sendLookup(ctx, step);
    await applyLookup(ctx, step, result.data, result.at);
  }
}

const rowOf = async (w: World, key = P553): Promise<BundleRow> => (await buildReport(w.store, KITS)).bundles.find((b) => b.key === key)!;
const models = (row: { parts: { model: string }[] }) => row.parts.map((p) => p.model);

describe('ways to sell PCL1600K2-P553, on the replay', () => {
  it('the owner\'s answer gives two options, with the exact labels, the kit whole and the kit split into its items', async () => {
    const w = await answered();
    const row = await rowOf(w);
    expect(row.options.map((o) => [o.id, o.label, o.splitKits, o.loose])).toEqual([
      ['whole', 'PCL1600K2 sold whole', [], false],
      ['split:PCL1600K2', 'PCL1600K2 split into its items', ['PCL1600K2'], true],
    ]);
    const [whole, split] = row.options;
    expect(models(whole!)).toEqual(['PCL1600K2', 'P553']);
    expect(models(split!)).toEqual([...KIT_MODELS, 'P553']);
    expect(split!.parts.map((p) => p.qty)).toEqual(KIT_MODELS.map(() => 1).concat(1));
    expect(row.kitsNotRead).toEqual([]);
  });

  it('nothing is looked up yet: no estimate anywhere, the primary is whole, and the row is the primary', async () => {
    const w = await answered();
    const row = await rowOf(w);
    const [whole, split] = row.options;
    // PCL1600K2 waits, since the kit is also a bundle the scan resolved; nothing asked for P553 or the items.
    expect(whole!.parts.map((p) => p.status)).toEqual(['waiting', 'unmatched']);
    expect(split!.parts.every((p) => p.status === 'unmatched')).toBe(true);
    expect(whole!.estimate).toBeNull();
    expect(split!.estimate).toBeNull();
    // Leftovers name only what a lookup has shown to have no listing: none of these models yet.
    expect(whole!.leftovers).toEqual([]);
    expect(split!.leftovers).toEqual(UNNAMED);
    expect(row).toMatchObject({ section: 'waiting', status: 'partial', estimate: null, parts: whole!.parts, uncovered: ['P553', 'PCL1600K2'] });
  });

  it('a part has a looked-up match only after the owner\'s Look up; the whole option then has its estimate, the split still waits', async () => {
    const w = await answered();
    expect(await w.store.getMatch(partKey('RYOBI', 'P553'))).toBeUndefined();
    await lookUp(w, ['PCL1600K2', 'P553']);
    expect(w.ledger.slice(3)).toEqual(['panel:lookup:PCL1600K2', 'panel:lookup:P553']);
    const row = await rowOf(w);
    const [whole, split] = row.options;
    expect(whole!.id).toBe('whole');
    // The PCL1600K2 search has no row with PCL1600K2 in its title: the kit has no listing.
    expect(whole!.parts.map((p) => [p.model, p.status, p.availability])).toEqual([['PCL1600K2', 'none', 'missing'], ['P553', 'matched', 'active']]);
    expect(whole!.leftovers).toEqual(['PCL1600K2']);
    expect(whole!.estimate).toEqual(evaluateBundle(388, { PCL1600K2: 1, P553: 1 }, [{ asin: whole!.parts[1]!.asin!, covers: { P553: 1 }, price: whole!.parts[1]!.price! }]).result);
    // P553 is matched now in the split option too; the kit's items are not looked up.
    expect(split!.parts.find((p) => p.model === 'P553')!.status).toBe('matched');
    expect(split!.estimate).toBeNull();
    expect(row).toMatchObject({ section: 'missing_listing', estimate: whole!.estimate, parts: whole!.parts, uncovered: ['PCL1600K2'] });
  });

  it('with the items looked up as well, the split option has an estimate, and its leftovers are the models with no listing, then the unnamed items', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'P553']);
    await lookUpItems(w, KIT_MODELS);
    // PBP005 comes from the saved brand page, free; the other seven are one replayed search each.
    expect(w.ledger.slice(5)).toEqual(KIT_MODELS.filter((m) => m !== 'PBP005').map((m) => `panel:lookup:${m}`));
    const row = await rowOf(w);
    const split = row.options.find((o) => o.id === 'split:PCL1600K2')!;
    const whole = row.options.find((o) => o.id === 'whole')!;
    expect(split.parts.map((p) => [p.model, p.status])).toEqual([
      ['PCL206', 'none'], ['PCL235', 'review'], ['PCL500', 'none'], ['PCL515', 'review'], ['PCL430', 'matched'], ['PCL660', 'none'],
      ['PBP005', 'matched'], ['PBP002', 'matched'], ['P553', 'matched'],
    ]);
    expect(split.leftovers).toEqual(['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL660', ...UNNAMED]);
    const active = split.parts.filter((p) => p.availability === 'active');
    const components = { ...Object.fromEntries(split.parts.map((p) => [p.model, 1])), ...Object.fromEntries(UNNAMED.map((n) => [`~${n}`, 1])) };
    expect(split.estimate).toEqual(evaluateBundle(388, components, active.map((p) => ({ asin: p.asin!, covers: { [p.model]: 1 }, price: p.price! }))).result);
    // Both leave something; the split makes more, so it is the primary, and a split primary with leftovers is a missing listing.
    expect(split.estimate!.profit).toBeGreaterThan(whole.estimate!.profit);
    expect(row.options.map((o) => o.id)).toEqual(['split:PCL1600K2', 'whole']);
    expect(row).toMatchObject({
      section: 'missing_listing', status: 'partial', estimate: split.estimate, parts: split.parts,
      uncovered: ['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL660', ...UNNAMED],
    });
  });

  it('the plain kit PCL1600K2 (317987591) is itself a bundle of one kit: sold whole or split into its items', async () => {
    const w = await answered();
    const row = await rowOf(w, KIT);
    expect(row.options.map((o) => [o.label, models(o)])).toEqual([
      ['PCL1600K2 sold whole', ['PCL1600K2']],
      ['PCL1600K2 split into its items', KIT_MODELS],
    ]);
  });

  it('a bundle whose split is not resolved has no options', async () => {
    const w = await answered();
    // 341645081 (PCL1600K2-PBP004) is in review in this world.
    const row = await rowOf(w, 'homedepot:341645081');
    expect(row).toMatchObject({ status: 'needs_review', options: [], kitsNotRead: [] });
  });
});

describe('ways to sell: edge cases', () => {
  it('no stored kit page: one option, as before, and PCL1600K2 is named as a kit whose page is not read', async () => {
    const w = await answered({ pages: false });
    expect((await w.store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2')))!.isKit).toBe(true);
    const row = await rowOf(w);
    expect(row.options.map((o) => [o.id, o.label, models(o), o.loose])).toEqual([['whole', '', ['PCL1600K2', 'P553'], false]]);
    expect(row.kitsNotRead).toEqual(['PCL1600K2']);
    expect(row.parts).toBe(row.options[0]!.parts);
  });

  it('a stored kit record whose page is not read names the kit as unread, even when the catalog does not hold the kit (Ruling 66)', async () => {
    // Only the bundles-filtered page: PCL1600K2 (317987591) is stored as a bundle record, never as a catalog entry.
    const BUNDLES_ONLY: ScanSettings = { ...KITS, queries: [KITS.queries[1]!] };
    for (const unread of [null, undefined]) {
      const w = await answered({ settings: BUNDLES_ONLY });
      expect(await w.store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2'))).toBeUndefined();
      const { page: _read, ...kit } = (await w.store.getBundle(KIT))!;
      expect(_read).toBeTruthy();
      await w.store.putBundle(unread === null ? { ...kit, page: null } : kit);
      const row = await rowOf(w);
      expect(row.options.map((o) => [o.id, models(o)])).toEqual([['whole', ['PCL1600K2', 'P553']]]);
      expect(row.kitsNotRead).toEqual(['PCL1600K2']);
    }
  });

  it('a kit page that is read but lists no model: one option, and the kit is not named as unread', async () => {
    const w = await answered();
    const kit = (await w.store.getBundle(KIT))!;
    // 320243741's own page has no Includes line, stored here as the kit's page.
    await w.store.putBundle({ ...kit, page: { ...page('320243741'), readAt: T0 } });
    const row = await rowOf(w);
    expect(row.options.map((o) => o.id)).toEqual(['whole']);
    expect(row.kitsNotRead).toEqual([]);
  });

  it('"None of these" gives no options', async () => {
    const w = await answered({ answer: 'none' });
    const row = await rowOf(w);
    expect(row).toMatchObject({ section: 'split', options: [], kitsNotRead: [] });
  });

  it('a kit item with the same model as another part adds to its quantity (the owner typed PCL1600K2 and PBP002)', async () => {
    const w = await answered({ answer: ['PCL1600K2', 'PBP002'] });
    expect((await w.store.getBundle(P553))!.split!.components).toEqual(['PCL1600K2', 'PBP002']);
    const [whole, split] = (await rowOf(w)).options;
    expect(whole!.parts.map((p) => [p.model, p.qty])).toEqual([['PCL1600K2', 1], ['PBP002', 1]]);
    expect(split!.parts.map((p) => [p.model, p.qty])).toEqual(KIT_MODELS.map((m) => [m, m === 'PBP002' ? 2 : 1]));
  });

  it('a kit counted twice splits into twice its items, and a leftover above 1 reads "×N"', async () => {
    const w = await answered({ answer: ['PCL1600K2', 'PCL1600K2', 'P553'] });
    const [whole, split] = (await rowOf(w)).options;
    expect(whole!.parts.map((p) => [p.model, p.qty])).toEqual([['PCL1600K2', 2], ['P553', 1]]);
    expect(split!.parts.map((p) => [p.model, p.qty])).toEqual([...KIT_MODELS.map((m) => [m, 2]), ['P553', 1]]);
    expect(split!.leftovers).toEqual(UNNAMED.map((n) => `${n} ×2`));
  });

  /** A stored record with a recorded page, as a scan leaves one. */
  const stored = (itemId: string, model: string, over: Partial<BundleRecord> = {}): BundleRecord => ({
    key: bundleKey(itemId), retailer: 'homedepot', itemId, title: `${model} (stored for this test)`, brand: 'RYOBI', model, upc: null,
    price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0, split: null, page: { ...page(itemId), readAt: T0 }, ...over,
  });
  const holding = (components: string[]): BundleRecord => ({
    ...stored('320243741', 'PCL1600K2-P553'), split: { components, status: 'resolved', notes: ['parts chosen by you'] },
  });

  it('two kits give four options, with the labels of the plan', async () => {
    const store = new MemoryScanStore();
    await store.putBundle(stored('317987591', 'PCL1600K2'));
    await store.putBundle(stored('328814689', 'PBLRC2501SB'));
    await store.putBundle(holding(['PCL1600K2', 'PBLRC2501SB']));
    const row = (await buildReport(store, KITS)).bundles.find((b) => b.key === P553)!;
    expect(row.options.map((o) => [o.id, o.label])).toEqual([
      ['whole', 'PCL1600K2 and PBLRC2501SB sold whole'],
      ['split:PCL1600K2', 'PCL1600K2 split into its items, PBLRC2501SB sold whole'],
      ['split:PBLRC2501SB', 'PBLRC2501SB split into its items, PCL1600K2 sold whole'],
      ['split:PBLRC2501SB+PCL1600K2', 'PCL1600K2 and PBLRC2501SB split into their items'],
    ]);
    expect(models(row.options[3]!)).toEqual([...KIT_MODELS, 'PBLRC01', 'PBLRC25']);
  });

  it('three kits give two options: all whole and all split', async () => {
    const store = new MemoryScanStore();
    await store.putBundle(stored('317987591', 'PCL1600K2'));
    await store.putBundle(stored('328814689', 'PBLRC2501SB'));
    await store.putBundle(stored('327939252', 'PCL280B-PSK005'));
    await store.putBundle(holding(['PCL1600K2', 'PBLRC2501SB', 'PCL280B-PSK005']));
    const row = (await buildReport(store, KITS)).bundles.find((b) => b.key === P553)!;
    expect(row.options.map((o) => [o.id, o.label, o.splitKits])).toEqual([
      ['whole', 'PCL1600K2, PBLRC2501SB and PCL280B-PSK005 sold whole', []],
      ['split:PBLRC2501SB+PCL1600K2+PCL280B-PSK005', 'PCL1600K2, PBLRC2501SB and PCL280B-PSK005 split into their items', ['PCL1600K2', 'PBLRC2501SB', 'PCL280B-PSK005']],
    ]);
    expect(models(row.options[1]!)).toEqual([...KIT_MODELS, 'PBLRC01', 'PBLRC25', 'PCL280', 'PBP006', 'PCG002']);
    expect(row.options[1]!.leftovers).toEqual([...UNNAMED, 'Reversible 1/4 in. and 3/8 in. Anvil', '1/2 in. Anvil with 1/4 in. Hex']);
  });

  it('a kit whose own page lists the kit itself is not split', async () => {
    const store = new MemoryScanStore();
    // 328814689's page lists PBLRC01 and PBLRC25, stored here under the model PBLRC01B.
    await store.putBundle(stored('328814689', 'PBLRC01B'));
    await store.putBundle(holding(['PBLRC01B', 'P553']));
    const row = (await buildReport(store, KITS)).bundles.find((b) => b.key === P553)!;
    expect(row.options.map((o) => o.id)).toEqual(['whole']);
  });
});

// ---------------------------------------------------------------- the primary rule (hand-made matches)

describe('the primary option', () => {
  /** The plain kit 317987591 with its recorded page, bought at $199 and resolved to itself, as the replay leaves it. */
  async function kitWorld(over: Partial<BundleRecord> = {}): Promise<MemoryScanStore> {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: KIT, retailer: 'homedepot', itemId: '317987591', title: 'ONE+ 18V Cordless 6-Tool Combo Kit', brand: 'RYOBI', model: 'PCL1600K2', upc: null,
      price: 199, regularPrice: 299, percentOff: 33, link: null, seenAt: T0, page: { ...page('317987591'), readAt: T0 },
      split: { components: ['PCL1600K2'], status: 'resolved', notes: ['manufacturer kit'] }, ...over,
    });
    return store;
  }

  /** A hand-made match: a priced, active listing, or (null) looked up with none found. */
  async function listed(store: MemoryScanStore, model: string, price: number | null): Promise<void> {
    const asin = price === null ? null : `B0TEST${model}`;
    await store.putMatch({
      key: partKey('RYOBI', model), brand: 'RYOBI', model, status: price === null ? 'none' : 'matched', asin, grade: price === null ? null : 'probable',
      alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null,
    });
    if (asin !== null) await store.putPrice({ asin, price, reviews: null, seenAt: T0, checkedAt: T0 });
  }

  const report = async (store: MemoryScanStore, settings: ScanSettings = KITS) => (await buildReport(store, settings)).bundles.find((b) => b.key === KIT)!;

  it('with no estimate anywhere, the primary is whole', async () => {
    const store = await kitWorld();
    const row = await report(store);
    expect(row.options.map((o) => [o.id, o.estimate])).toEqual([['whole', null], ['split:PCL1600K2', null]]);
  });

  it('an option that leaves nothing comes first, even when an option with leftovers makes more', async () => {
    const store = await kitWorld();
    await listed(store, 'PCL1600K2', 250);
    for (const m of KIT_MODELS) await listed(store, m, 100);
    const row = await report(store);
    const split = row.options.find((o) => o.id === 'split:PCL1600K2')!;
    expect(split.leftovers).toEqual(UNNAMED);
    expect(split.estimate!.profit).toBeGreaterThan(row.options.find((o) => o.id === 'whole')!.estimate!.profit);
    expect(row.options[0]!).toMatchObject({ id: 'whole', leftovers: [] });
    // A whole primary keeps today's section: every part has an active listing.
    expect(row).toMatchObject({ section: 'confirmed', status: 'complete', uncovered: [], estimate: row.options[0]!.estimate });
  });

  it('when every option leaves something, the highest profit; a split primary with leftovers is a missing listing', async () => {
    const store = await kitWorld();
    await listed(store, 'PCL1600K2', null);
    for (const m of KIT_MODELS) await listed(store, m, 100);
    const row = await report(store);
    expect(row.options.map((o) => o.id)).toEqual(['split:PCL1600K2', 'whole']);
    expect(row.options[1]!.leftovers).toEqual(['PCL1600K2']);
    // Every model of the split has an active listing; its unnamed items are what it leaves.
    expect(row.parts.every((p) => p.availability === 'active')).toBe(true);
    expect(row).toMatchObject({ section: 'missing_listing', status: 'partial', estimate: row.options[0]!.estimate, uncovered: UNNAMED });
  });

  it('when every option leaves something and whole makes more, whole', async () => {
    const store = await kitWorld();
    await listed(store, 'PCL1600K2', null);
    for (const m of KIT_MODELS) await listed(store, m, null);
    // At the full liquidation rate whole values the kit at $199; the split values its 19 items at $10.47 each, $198.93.
    const row = await report(store, { ...KITS, liquidationRate: 1 });
    expect(row.options.map((o) => [o.id, o.estimate?.profit, o.leftovers.length])).toEqual([['whole', 0, 1], ['split:PCL1600K2', -0.07, 19]]);
  });

  it('a tie goes to whole', async () => {
    const store = await kitWorld();
    await listed(store, 'PCL1600K2', null);
    for (const m of KIT_MODELS) await listed(store, m, null);
    const row = await report(store);
    expect(row.options.map((o) => [o.id, o.estimate?.profit])).toEqual([['whole', -199], ['split:PCL1600K2', -199]]);
  });

  it('an option with an estimate beats one without, and a split that leaves nothing keeps the section its parts give', async () => {
    // 335849279 (PBLRC2501SB-A13401) holding the kit PBLRC2501SB, whose page (328814689) lists only PBLRC01 and PBLRC25.
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('328814689'), retailer: 'homedepot', itemId: '328814689', title: 'PBLRC2501SB', brand: 'RYOBI', model: 'PBLRC2501SB', upc: null,
      price: 189, regularPrice: 338, percentOff: 44, link: null, seenAt: T0, page: { ...page('328814689'), readAt: T0 }, split: null,
    });
    const key = bundleKey('335849279');
    await store.putBundle({
      key, retailer: 'homedepot', itemId: '335849279', title: 'PBLRC2501SB-A13401', brand: 'RYOBI', model: 'PBLRC2501SB-A13401', upc: null,
      price: 200, regularPrice: 300, percentOff: 33, link: null, seenAt: T0, page: { ...page('335849279'), readAt: T0 },
      split: { components: ['PBLRC2501SB', 'A13401'], status: 'resolved', notes: ['parts chosen by you'] },
    });
    await listed(store, 'A13401', 40);
    await listed(store, 'PBLRC01', 120);
    await listed(store, 'PBLRC25', 130);
    // The kit itself is not looked up yet: whole has no estimate, the split has one and leaves nothing.
    const row = (await buildReport(store, KITS)).bundles.find((b) => b.key === key)!;
    expect(row.options.map((o) => [o.id, o.estimate === null, o.leftovers])).toEqual([['split:PBLRC2501SB', false, []], ['whole', true, []]]);
    expect(models(row.options[0]!)).toEqual(['PBLRC01', 'PBLRC25', 'A13401']);
    expect(row).toMatchObject({ section: 'confirmed', status: 'complete', uncovered: [], parts: row.options[0]!.parts, estimate: row.options[0]!.estimate });
  });
});
