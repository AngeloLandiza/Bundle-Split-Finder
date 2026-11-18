import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { parseBundlePage } from '../src/hdPage';
import { applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type PageOutcome, partKey, type ReadPages, type ScanJob, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

// Task 3b (Ruling 67): the free page phase reads the page of a plain kit that a resolved split holds.
// In a scan of the default searches (no bundles-only query) the plain kit PCL1600K2 (317987591) is
// a catalog entry, not a bundle, so before this its page was never read. Everything here is the
// replay: the recorded Home Depot searches and the recorded Home Depot pages. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 11, 12);
const KIT_ID = '317987591';
const KIT = partKey('RYOBI', 'PCL1600K2');
const P553 = bundleKey('320243741');
const P553_QUESTION = `split:${P553}`;
const PCL430B = bundleKey('324904496');
/** PCL1201K2, the kit inside PCL1201K2-PCL430B. Its page is not recorded. */
const KIT_1201_ID = '317987584';

/** The default searches, from the cache within the hour; no Amazon brand page, so the default limit is not needed. */
const SETTINGS: ScanSettings = { ...DEFAULT_SCAN_SETTINGS };
/** No listing page: a scan of what is stored. */
const STORED: ScanSettings = { ...SETTINGS, queries: [] };

/** The bundle pages scan 1 asks for and the replay has no recording of: they stay unread, so every later scan asks again. */
const UNRECORDED = ['341644756', '341645227', '343659640', '345177929'];

const PAGES = (
  JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: { itemId: string; text: string }[];
  }
).pages;

interface World {
  store: MemoryScanStore;
  cache: MemoryCache;
  replay: Replay;
  ledger: string[];
  /** Every call to the page reader, in order: the item ids it was asked for. */
  reads: string[][];
}

/** The recorded pages by item id; an id with no recording comes back unreadable, as the reader says of an empty page. */
function reader(w: World, refuse: string[] = []): ReadPages {
  return async (ids) => {
    w.reads.push([...ids]);
    return ids.map((itemId): PageOutcome => {
      if (refuse.includes(itemId)) return { itemId, kind: 'refused' };
      const rec = PAGES.find((p) => p.itemId === itemId);
      const content = rec ? parseBundlePage(rec.text, itemId) : null;
      return content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' };
    });
  };
}

function paid(w: World, maxPerRun: number) {
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: w.replay.fetchFn, now: () => T0, onSpend: (e) => void w.ledger.push(e.label) });
  return { budget, client };
}

interface ScanOptions {
  settings?: ScanSettings;
  /** The run limit; default 2. */
  cap?: number;
  readPages?: ReadPages;
  shouldStop?: () => boolean;
}

/**
 * One scan, at a run limit of 2 by default: the two listing pages (paid once, then from the cache);
 * the searches they leave go to lookups, which the replay may have no recording of.
 */
async function scan(w: World, opts: ScanOptions = {}): Promise<ScanJob> {
  return runScan({ ...paid(w, opts.cap ?? 2), store: w.store, settings: opts.settings ?? SETTINGS, now: () => T0, readPages: opts.readPages ?? reader(w), shouldStop: opts.shouldStop });
}

/** Scan 1 of the default searches with the recorded pages (or none). */
async function scanned(pages = true): Promise<World> {
  const w: World = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), ledger: [], reads: [] };
  await runScan({ ...paid(w, 2), store: w.store, settings: SETTINGS, now: () => T0, readPages: pages ? reader(w) : undefined });
  return w;
}

/** The owner answers a split question with its first choice. */
async function answer(w: World, id: string): Promise<void> {
  const question = (await w.store.getReview(id))!;
  await applyReviewAnswer(w.store, id, { choice: 0, seen: reviewSignature(question) }, T0);
}

/** Scan 1, then the owner's answer to PCL1600K2-P553: PCL1600K2 + P553. */
async function answered(pages = true): Promise<World> {
  const w = await scanned(pages);
  await answer(w, P553_QUESTION);
  return w;
}

const rowOf = async (w: World, key: string) => (await buildReport(w.store, SETTINGS)).bundles.find((b) => b.key === key)!;
const kitReads = (w: World): string[][] => w.reads.filter((ids) => ids.includes(KIT_ID));

describe('a plain kit in a scan of the default searches', () => {
  it('PCL1600K2 is stored as a catalog kit with item id 317987591, not as a bundle', async () => {
    const w = await scanned();
    expect(w.ledger).toHaveLength(2);
    expect(await w.store.getBundle(bundleKey(KIT_ID))).toBeUndefined();
    expect(await w.store.getCatalogEntry(KIT)).toMatchObject({ brand: 'RYOBI', model: 'PCL1600K2', isKit: true, itemId: KIT_ID });
    // No resolved split holds it yet (PCL1600K2-P553 is a question): its page is not read.
    expect((await w.store.getBundle(P553))!.split?.status).toBe('needs_review');
    expect(kitReads(w)).toEqual([]);
    expect((await w.store.getCatalogEntry(KIT))!.page).toBeUndefined();
  });

  it('once the owner has answered, the split holds it: one way to sell, and the kit is not read', async () => {
    const w = await answered();
    const row = await rowOf(w, P553);
    expect(row.options.map((o) => o.id)).toEqual(['whole']);
    expect(row.kitsNotRead).toEqual(['PCL1600K2']);
  });

  it('the next scan reads 317987591 after the bundle pages, free, and the report gives two ways to sell', async () => {
    const w = await answered();
    w.reads = [];
    const job = await scan(w);
    // From the cache: nothing spent.
    expect(w.ledger).toHaveLength(2);
    expect(job.searchesUsed).toBe(0);
    // Bundle pages first, as today (the ones the replay has no page for), then the kit's, by its own item id.
    expect(w.reads).toEqual([UNRECORDED, [KIT_ID]]);
    expect(job.counts.pagesRead).toBe(1);
    const kit = (await w.store.getCatalogEntry(KIT))!;
    expect(kit.page).toMatchObject({ readAt: T0 });
    expect(kit.page!.bullets.some((b) => b.startsWith('Includes:'))).toBe(true);
    const row = await rowOf(w, P553);
    expect(row.kitsNotRead).toEqual([]);
    expect(row.options.map((o) => [o.id, o.label])).toEqual([
      ['whole', 'PCL1600K2 sold whole'],
      ['split:PCL1600K2', 'PCL1600K2 split into its parts'],
    ]);
  });

  it('a kit page is read once: later scans do not ask for it again', async () => {
    const w = await answered();
    await scan(w);
    w.reads = [];
    await scan(w);
    await scan(w, { settings: STORED });
    expect(w.reads).toEqual([UNRECORDED, UNRECORDED]);
    expect((await rowOf(w, P553)).options).toHaveLength(2);
  });

  it('a later listing row keeps the kit page, as it keeps a bundle page', async () => {
    const w = await answered();
    await scan(w);
    const page = (await w.store.getCatalogEntry(KIT))!.page;
    await scan(w);
    expect((await w.store.getCatalogEntry(KIT))!.page).toEqual(page);
  });

  it('kit pages share pageReadsPerScan with bundle pages, which go first', async () => {
    // Scan 1 read no page, so the next scan has 15 bundle pages to read, 11 of them recorded.
    const at = async (pageReadsPerScan: number) => {
      const w = await answered(false);
      w.reads = [];
      const job = await scan(w, { settings: { ...SETTINGS, pageReadsPerScan } });
      return { w, job };
    };
    // Fifteen bundle pages asked for fill the cap, though only 11 were read: the kit waits.
    const fifteen = await at(15);
    expect(fifteen.job.counts.pagesRead).toBe(11);
    expect(fifteen.w.reads).toHaveLength(1);
    expect(kitReads(fifteen.w)).toEqual([]);
    expect((await rowOf(fifteen.w, P553)).kitsNotRead).toEqual(['PCL1600K2']);
    // One more leaves one for the kit.
    const sixteen = await at(16);
    expect(sixteen.w.reads.at(-1)).toEqual([KIT_ID]);
    expect(sixteen.job.counts.pagesRead).toBe(12);
    expect((await rowOf(sixteen.w, P553)).options).toHaveLength(2);
  });

  it('the two passes together never ask Home Depot for more than pageReadsPerScan pages', async () => {
    // The four bundle pages the next scan asks for are not recorded, so none is read; each still counts as asked.
    for (const [cap, kit] of [[3, false], [4, false], [5, true]] as const) {
      const w = await answered();
      w.reads = [];
      await scan(w, { settings: { ...STORED, pageReadsPerScan: cap }, cap: 0 });
      expect(w.reads.flat().length).toBeLessThanOrEqual(cap);
      expect(w.reads.flat()).toEqual(kit ? [...UNRECORDED, KIT_ID] : UNRECORDED.slice(0, cap));
    }
  });

  it('kit pages go newest bundle first', async () => {
    const w = await answered();
    await answer(w, `split:${PCL430B}`);
    expect((await w.store.getBundle(PCL430B))!.split).toMatchObject({ status: 'resolved', components: ['PCL1201K2', 'PCL430B'] });
    expect(await w.store.getCatalogEntry(partKey('RYOBI', 'PCL1201K2'))).toMatchObject({ isKit: true, itemId: KIT_1201_ID });
    // Both bundles were seen in the same response: by key, P553 first.
    w.reads = [];
    await scan(w, { settings: STORED });
    expect(w.reads.at(-1)).toEqual([KIT_ID, KIT_1201_ID]);

    // PCL1201K2-PCL430B seen later (its row, by hand): its kit goes first. 317987584 has no recorded page, so it is asked again.
    const v = await answered();
    await answer(v, `split:${PCL430B}`);
    await v.store.putBundle({ ...(await v.store.getBundle(PCL430B))!, seenAt: T0 + 1 });
    v.reads = [];
    await scan(v, { settings: STORED });
    expect(v.reads.at(-1)).toEqual([KIT_1201_ID, KIT_ID]);
  });
});

describe('only a kit some resolved split holds, by its own item id', () => {
  it('a kit held only by splits still in question is never read', async () => {
    const w = await scanned();
    // Six bundles hold PCL1600K2 in their readings, none resolved.
    for (let i = 0; i < 2; i++) await scan(w, { settings: i === 0 ? SETTINGS : STORED });
    expect(kitReads(w)).toEqual([]);
  });

  it('the owner\'s None of these holds nothing: the kit is not read', async () => {
    const w = await scanned();
    const question = (await w.store.getReview(P553_QUESTION))!;
    await applyReviewAnswer(w.store, P553_QUESTION, { none: true, seen: reviewSignature(question) }, T0);
    await scan(w);
    expect(kitReads(w)).toEqual([]);
  });

  it('a catalog entry not marked a kit is never read, even when a resolved split holds it', async () => {
    const w = await answered();
    // The recorded entry, its kit mark taken off by hand.
    await w.store.putCatalogEntry({ ...(await w.store.getCatalogEntry(KIT))!, isKit: false });
    await scan(w, { settings: STORED });
    expect(kitReads(w)).toEqual([]);
    // Not a kit: nothing to read, and no kit to report unread.
    expect((await rowOf(w, P553)).kitsNotRead).toEqual([]);
  });

  it('a stored item id that is not a Home Depot item id is never sent to the reader', async () => {
    const w = await answered();
    await w.store.putCatalogEntry({ ...(await w.store.getCatalogEntry(KIT))!, itemId: '../317987591' });
    w.reads = [];
    await scan(w, { settings: STORED });
    expect(w.reads).toEqual([UNRECORDED]);
    expect((await rowOf(w, P553)).kitsNotRead).toEqual(['PCL1600K2']);
  });

  it('one item id per kit: a record under the tool-only B form of the same kit is not read too', async () => {
    const w = await answered();
    // Hand-made: the recorded entry copied under PCL1600K2B with another item id. sameModel groups the two as one kit.
    const kit = (await w.store.getCatalogEntry(KIT))!;
    await w.store.putCatalogEntry({ ...kit, key: partKey('RYOBI', 'PCL1600K2B'), model: 'PCL1600K2B', itemId: '317987592' });
    w.reads = [];
    await scan(w, { settings: STORED, cap: 0 });
    expect(w.reads).toEqual([UNRECORDED, [KIT_ID]]);
    expect((await w.store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2B')))!.page).toBeUndefined();
    expect((await rowOf(w, P553)).options).toHaveLength(2);
  });

  it('a kit that is also stored as a bundle is read by the bundle phase only, once', async () => {
    // The bundles-only query stores 317987591 as a bundle too (step 4's world): the kit phase leaves it to the bundle phase.
    const KITS: ScanSettings = { ...SETTINGS, queries: [...SETTINGS.queries, { q: 'ryobi 18v combo kit', filterTokens: 'bwo64,m5d', bundlesOnly: true }] };
    const w: World = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), ledger: [], reads: [] };
    await runScan({ ...paid(w, 3), store: w.store, settings: KITS, now: () => T0, readPages: reader(w) });
    await answer(w, P553_QUESTION);
    await runScan({ ...paid(w, 3), store: w.store, settings: KITS, now: () => T0, readPages: reader(w) });
    expect(w.reads.flat().filter((id) => id === KIT_ID)).toEqual([KIT_ID]);
    expect(w.reads[0]).toContain(KIT_ID);
    expect((await w.store.getCatalogEntry(KIT))!.page).toBeUndefined();
    expect((await rowOf(w, P553)).options).toHaveLength(2);
  });
});

// With no listing page and a run limit of 0, nothing is searched: the job's message holds only the pages' notes.
describe('stopping and failing', () => {
  it('a stop asked for during the bundle pages reads no kit page', async () => {
    const w = await answered();
    w.reads = [];
    let stop = false;
    const read = reader(w);
    const job = await scan(w, { readPages: async (ids) => { stop = true; return read(ids); }, shouldStop: () => stop });
    expect(w.reads).toEqual([UNRECORDED]);
    expect(job.stopReason).toBe('user');
    expect((await rowOf(w, P553)).kitsNotRead).toEqual(['PCL1600K2']);
  });

  it('Home Depot refusing a bundle page reads no kit page; the next scan reads it', async () => {
    const w = await answered();
    w.reads = [];
    const job = await scan(w, { settings: STORED, cap: 0, readPages: reader(w, UNRECORDED.slice(0, 1)) });
    expect(w.reads).toEqual([UNRECORDED]);
    expect(job.stopMessage).toContain('Home Depot refused a page');
    await scan(w);
    expect(w.reads.at(-1)).toEqual([KIT_ID]);
  });

  it('a kit page that cannot be read stays unread and is asked for again next scan', async () => {
    const w = await answered();
    w.reads = [];
    const job = await scan(w, {
      settings: STORED, cap: 0, readPages: async (ids) => { w.reads.push([...ids]); return ids.map((itemId) => ({ itemId, kind: 'unreadable' })); },
    });
    expect(w.reads).toEqual([UNRECORDED, [KIT_ID]]);
    expect(job.stopMessage).toContain('No Home Depot page could be read.');
    expect((await w.store.getCatalogEntry(KIT))!.page).toBeUndefined();
    await scan(w);
    expect(w.reads.at(-1)).toEqual([KIT_ID]);
    expect((await rowOf(w, P553)).options).toHaveLength(2);
  });

  it('the note names the status of the first refused page', async () => {
    const w = await answered();
    w.reads = [];
    const read = reader(w);
    const job = await scan(w, {
      settings: STORED, cap: 0,
      readPages: async (ids) => (await read(ids)).map((o, i) => (i === 0 ? { itemId: o.itemId, kind: 'refused' as const, status: 403 } : i === 1 ? { itemId: o.itemId, kind: 'refused' as const, status: 0 } : o)),
    });
    expect(job.stopMessage).toContain('Home Depot refused a page (HTTP 403); the rest are read next scan.');
    expect(job.stopMessage).not.toContain('no answer');
  });

  it('a status of 0 is said as no answer', async () => {
    const w = await answered();
    w.reads = [];
    const read = reader(w);
    const job = await scan(w, {
      settings: STORED, cap: 0,
      readPages: async (ids) => (await read(ids)).map((o, i) => (i === 0 ? { itemId: o.itemId, kind: 'refused' as const, status: 0 } : o)),
    });
    expect(job.stopMessage).toContain('Home Depot refused a page (no answer); the rest are read next scan.');
  });

  it('a kit page refused by Home Depot is noted, and asked for again next scan', async () => {
    const w = await answered();
    w.reads = [];
    const job = await scan(w, { settings: STORED, cap: 0, readPages: reader(w, [KIT_ID]) });
    expect(w.reads).toEqual([UNRECORDED, [KIT_ID]]);
    expect(job.stopMessage).toContain('Home Depot refused a page; the rest are read next scan.');
    await scan(w);
    expect(w.reads.at(-1)).toEqual([KIT_ID]);
  });
});

describe('an interrupted kit pass', () => {
  it('is continued: the kit page is saved once and pagesRead counts every page read', async () => {
    // Scan 1 read no page, so the next scan reads 11 bundle pages, then the kit's.
    const w = await answered(false);
    w.reads = [];
    let saves = 0;
    let fail = true;
    // The store fails the first time a kit page is saved: the worker stopped after the bundle pages.
    const store = new Proxy(w.store, {
      get(target, prop) {
        if (prop === 'putCatalogEntry') {
          return async (record: Parameters<MemoryScanStore['putCatalogEntry']>[0]) => {
            if (record.page) {
              if (fail) {
                fail = false;
                throw new Error('the worker stopped');
              }
              saves += 1;
            }
            return target.putCatalogEntry(record);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const run = () => runScan({ ...paid(w, 2), store, settings: SETTINGS, now: () => T0, readPages: reader(w) });
    await expect(run()).rejects.toThrow('the worker stopped');
    const interrupted = (await w.store.listScans())[0]!;
    expect(interrupted).toMatchObject({ status: 'running', phase: 'listing' });
    expect(interrupted.counts.pagesRead).toBe(11);
    expect((await w.store.getCatalogEntry(KIT))!.page).toBeUndefined();

    const job = await run();
    expect(job.id).toBe(interrupted.id);
    // The continued job asks again only for the pages still unread: the four with no recording, then the kit.
    expect(w.reads.slice(2)).toEqual([UNRECORDED, [KIT_ID]]);
    expect(saves).toBe(1);
    expect(job.counts.pagesRead).toBe(12);
    expect((await w.store.getCatalogEntry(KIT))!.page).toMatchObject({ readAt: T0 });
    expect((await rowOf(w, P553)).options).toHaveLength(2);
  });
});

describe('migration: catalog entries saved before step 6', () => {
  /** The world after the owner's answer, with PCL1600K2's entry as step 5 saved it: no item id, no page. */
  async function old(): Promise<World> {
    const w = await answered();
    const { itemId: _id, page: _page, ...entry } = (await w.store.getCatalogEntry(KIT))!;
    await w.store.putCatalogEntry(entry);
    return w;
  }

  it('an entry with no item id stays unread, and its bundle has one way to sell', async () => {
    const w = await old();
    w.reads = [];
    await scan(w, { settings: STORED });
    await scan(w, { settings: STORED });
    expect(kitReads(w)).toEqual([]);
    expect((await w.store.getCatalogEntry(KIT))!.itemId).toBeUndefined();
    const row = await rowOf(w, P553);
    expect(row.options.map((o) => o.id)).toEqual(['whole']);
    expect(row.kitsNotRead).toEqual(['PCL1600K2']);
  });

  it('until a listing row shows it again: then its item id is saved and its page read in the same scan', async () => {
    const w = await old();
    w.reads = [];
    await scan(w);
    expect((await w.store.getCatalogEntry(KIT))!.itemId).toBe(KIT_ID);
    expect(w.reads.at(-1)).toEqual([KIT_ID]);
    expect((await rowOf(w, P553)).options).toHaveLength(2);
  });
});
