import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseIncludes } from '@core/kitContents';
import { parseBundlePage } from '@core/hdPage';
import { buildReport } from '@core/scan/report';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type BundleRecord, type CatalogRecord, type PageOutcome, partKey, type ReadPages } from '@core/scan/types';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS, type EbaySettings } from '@core/settings';
import type { AppState, Reply, Request } from './messages';
import { createWorker, type Prefs } from './worker';

// Read kit page: one recorded Home Depot page (PCL1600K2, item 317987591), saved where a scan would
// save it. Nothing is searched, and no Amazon listing is chosen from the page.

const T0 = Date.UTC(2026, 10, 20, 12);
const KIT_ID = '317987591';
const PAGE = parseBundlePage(
  (JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: { itemId: string; text: string }[];
  }).pages.find((p) => p.itemId === KIT_ID)!.text,
  KIT_ID,
)!;

const combo = (): BundleRecord => ({
  key: bundleKey('320243741'),
  retailer: 'homedepot',
  itemId: '320243741',
  title: 'RYOBI ONE+ 18V combo',
  brand: 'RYOBI',
  model: 'PCL1600K2-P553',
  upc: null,
  price: 388,
  regularPrice: null,
  percentOff: null,
  link: 'https://www.homedepot.com/p/320243741',
  seenAt: T0,
  split: { components: ['PCL1600K2', 'P553'], status: 'resolved', notes: [] },
});

const kitEntry = (itemId: string | null): CatalogRecord => ({
  key: partKey('RYOBI', 'PCL1600K2'),
  brand: 'RYOBI',
  model: 'PCL1600K2',
  title: 'ONE+ 18V Cordless 6-Tool Combo Kit',
  kinds: [],
  isKit: true,
  upc: null,
  seenAt: T0,
  ...(itemId === null ? {} : { itemId }),
});

function prefs(): Prefs {
  return {
    getKey: async () => null,
    setKey: async () => {},
    forgetKey: async () => {},
    restrictKeyAccess: async () => {},
    getSettings: async () => DEFAULT_SETTINGS,
    saveSettings: async () => {},
    getActiveScan: async () => null,
    setActiveScan: async () => {},
    getLastScheduledRunAt: async () => null,
    setLastScheduledRunAt: async () => {},
    getNotified: async () => [],
    setNotified: async () => {},
    getPackaging: async () => ({}),
    savePackaging: async () => {},
    getAccount: async () => null,
    setAccount: async () => {},
    getShowChip: async () => true,
    getEbayKeys: async () => null,
    setEbayKeys: async () => {},
    forgetEbayKeys: async () => {},
    getAnthropicKey: async () => null,
    setAnthropicKey: async () => {},
    forgetAnthropicKey: async () => {},
    getEbaySettings: async () => DEFAULT_EBAY_SETTINGS,
    saveEbaySettings: async (_s: EbaySettings) => {},
    getEbayToken: async () => null,
    setEbayToken: async () => {},
    clearEbayToken: async () => {},
  };
}

function harness(readPages?: ReadPages) {
  const store = new MemoryScanStore();
  const fetches: string[] = [];
  const asked: string[][] = [];
  const broadcasts: AppState[] = [];
  const reader: ReadPages | undefined = readPages
    ? async (ids) => {
        asked.push([...ids]);
        return readPages(ids);
      }
    : undefined;
  const worker = createWorker({
    store,
    cache: { get: async () => undefined, set: async () => {}, clear: async () => {} },
    prefs: prefs(),
    ledger: () => {},
    fetchFn: (async () => {
      fetches.push('fetch');
      throw new Error('no network');
    }) as typeof fetch,
    now: () => T0,
    notify: () => {},
    broadcast: (state) => {
      broadcasts.push(state);
    },
    ...(reader ? { readPages: reader } : {}),
  });
  const send = (request: Request): Promise<Reply<null>> => worker.onMessage(request) as Promise<Reply<null>>;
  return { store, fetches, asked, broadcasts, send };
}

const readRecorded: ReadPages = async (ids) => ids.map((itemId): PageOutcome => (
  itemId === KIT_ID ? { itemId, kind: 'read', content: PAGE } : { itemId, kind: 'unreadable' }
));

const modelsOnPage = (): string[] => parseIncludes('RYOBI', PAGE.bullets).flatMap((item) => (item.model === null ? [] : [item.model]));

describe('read kit page', () => {
  it('saves the recorded kit page on the catalog entry, splits the kit, and does not search or choose a listing', async () => {
    const h = harness(readRecorded);
    await h.store.putBundle(combo());
    await h.store.putCatalogEntry(kitEntry(KIT_ID));

    const before = (await buildReport(h.store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'PCL1600K2-P553')!;
    expect(before.kitsNotRead).toEqual(['PCL1600K2']);
    expect(before.kitReads).toEqual([{ model: 'PCL1600K2', itemId: KIT_ID }]);

    expect(await h.send({ type: 'readKitPage', brand: 'ryobi', model: 'pcl1600k2' })).toEqual({ ok: true, data: null });
    expect(h.asked).toEqual([[KIT_ID]]);
    expect(h.fetches).toEqual([]);
    const saved = (await h.store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2')))!.page!;
    expect(saved.bullets).toEqual(PAGE.bullets);
    expect(saved.description).toEqual(PAGE.description);
    expect(saved.readAt).toBe(T0);

    const row = (await buildReport(h.store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'PCL1600K2-P553')!;
    expect(row.kitsNotRead).toEqual([]);
    expect(row.kitReads).toEqual([]);
    const split = row.options.find((o) => o.id === 'split:PCL1600K2')!;
    for (const model of modelsOnPage()) expect(split.parts.map((p) => p.model)).toContain(model);
    expect(split.parts.every((p) => p.asin === null)).toBe(true);
    expect(h.broadcasts.length).toBeGreaterThan(0);

    expect(await h.send({ type: 'readKitPage', brand: 'RYOBI', model: 'PCL1600K2' })).toEqual({
      ok: false, error: "That kit's page is already stored.",
    });
    expect(h.asked).toEqual([[KIT_ID]]);
  });

  it('saves a kit that is its own bundle on that bundle, and does not read a different catalog id', async () => {
    const h = harness(readRecorded);
    await h.store.putBundle(combo());
    await h.store.putBundle({
      ...combo(),
      key: bundleKey(KIT_ID),
      itemId: KIT_ID,
      model: 'PCL1600K2',
      split: { components: ['PCL1600K2'], status: 'resolved', notes: [] },
    });
    await h.store.putCatalogEntry(kitEntry('999'));

    expect(await h.send({ type: 'readKitPage', brand: 'RYOBI', model: 'PCL1600K2' })).toEqual({ ok: true, data: null });
    expect(h.asked).toEqual([[KIT_ID]]);
    expect(h.fetches).toEqual([]);
    expect((await h.store.getBundle(bundleKey(KIT_ID)))!.page!.bullets).toEqual(PAGE.bullets);
    expect((await h.store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2')))!.page).toBeUndefined();
    const row = (await buildReport(h.store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'PCL1600K2-P553')!;
    expect(row.kitsNotRead).toEqual([]);
  });

  it('a refusal or a failed read stores nothing, and a kit with no item id is not asked for', async () => {
    const refused = harness(async () => [{ itemId: KIT_ID, kind: 'refused', status: 403 }]);
    await refused.store.putBundle(combo());
    await refused.store.putCatalogEntry(kitEntry(KIT_ID));
    expect(await refused.send({ type: 'readKitPage', brand: 'RYOBI', model: 'PCL1600K2' })).toEqual({
      ok: false, error: 'Home Depot refused the page (HTTP 403). Try again later.',
    });
    expect((await refused.store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2')))!.page).toBeUndefined();
    expect(refused.fetches).toEqual([]);

    const broken = harness(async () => {
      throw new Error('tab closed');
    });
    await broken.store.putBundle(combo());
    await broken.store.putCatalogEntry(kitEntry(KIT_ID));
    expect(await broken.send({ type: 'readKitPage', brand: 'RYOBI', model: 'PCL1600K2' })).toEqual({
      ok: false, error: 'Reading the Home Depot page failed. Try again.',
    });
    expect((await broken.store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2')))!.page).toBeUndefined();

    const noId = harness(readRecorded);
    await noId.store.putBundle(combo());
    await noId.store.putCatalogEntry(kitEntry(null));
    expect(await noId.send({ type: 'readKitPage', brand: 'RYOBI', model: 'PCL1600K2' })).toEqual({
      ok: false, error: 'The next scan has to find this kit on Home Depot before its page can be read.',
    });
    expect(noId.asked).toEqual([]);
  });

  it('while the page is being read, a scan and a Look up are refused and nothing is fetched', async () => {
    let release!: (rows: PageOutcome[]) => void;
    const gate = new Promise<PageOutcome[]>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const saw = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = harness(async () => {
      started();
      return gate;
    });
    await h.store.putBundle(combo());
    await h.store.putCatalogEntry(kitEntry(KIT_ID));
    const pending = h.send({ type: 'readKitPage', brand: 'RYOBI', model: 'PCL1600K2' });
    await saw;
    expect(await h.send({ type: 'scanNow' })).toEqual({ ok: false, error: 'A kit page is being read. Scan when it has finished.' });
    expect(await h.send({ type: 'runPaid', action: { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'P553' }] } })).toEqual({
      ok: false, error: 'A kit page is being read. Try again when it has finished.',
    });
    expect(await h.send({ type: 'askAi', questionId: 'split:homedepot:320243741' })).toEqual({
      ok: false, error: 'A kit page is being read. Ask again when it has finished.',
    });
    expect(await h.send({ type: 'askAiAll' })).toEqual({
      ok: false, error: 'A kit page is being read. Ask again when it has finished.',
    });
    expect(h.fetches).toEqual([]);
    release([{ itemId: KIT_ID, kind: 'read', content: PAGE }]);
    expect(await pending).toEqual({ ok: true, data: null });
  });
});
