// Pictures from what the app already reads (Nov 25): stored listings without a picture get one from the Keepa answers the
// agent already cached (agent/pictureBackfill.ts). Built on the recorded Keepa answers in fixtures/keepa/ and the real store
// after six scans (fixtures/e2e-2026-11-23/after-scan6). Reads files only: any fetch throws.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pictureCoverage } from '../../core/src/links/pictures';
import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import { buildReport } from '../../core/src/scan/report';
import { DEFAULT_SCAN_SETTINGS, type ListingRecord, type MatchRecord } from '../../core/src/scan/types';
import { loadScanFolder } from '../../scripts/data-folder';
import { backfillPictures, backfillSentence, cachedHomeDepotPictures, cachedPictures } from '../pictureBackfill';
import { DirCache } from '../scanStore';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const json = (...p: string[]) => JSON.parse(readFileSync(join(FIX, ...p), 'utf8')) as unknown;
const PRODUCTS = json('keepa', 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json') as Record<string, unknown>;
const SEARCH = json('keepa', 'search-RYOBI-PCL235B.json') as Record<string, unknown>;

let dir = '';
const fetchSpy = vi.fn(() => {
  throw new Error('the picture backfill must not reach the network');
});
beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchSpy.mockClear();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

async function cacheWithFixtures(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'pictures-'));
  const cacheDir = join(dir, 'cache');
  const cache = new DirCache(cacheDir);
  await cache.set('keepa:product?asin=B0BGYFTPGK,B01H9BL8EO,B09M3TL9BB&domain=1&history=0&stats=180', { at: 2, data: PRODUCTS });
  await cache.set('keepa:search?domain=1&term=RYOBI PCL235B&type=product', { at: 1, data: SEARCH });
  // Not a product answer: never read for a picture.
  await cache.set('keepa:trend:B0BGYFTPGK', { at: 3, data: { products: [{ asin: 'B0BGYFTPGK', images: [{ m: 'XXXXXXXXXXX.jpg', variant: 'MAIN' }] }] } });
  return cacheDir;
}

const listing = (asin: string, image: string | null): ListingRecord => ({
  asin, brand: 'RYOBI', title: `RYOBI listing ${asin}`, models: [], image, price: 10, reviews: null, seenAt: 1, checkedAt: 1,
});
const match = (key: string, asin: string): MatchRecord => ({
  key, brand: 'RYOBI', model: key.split(':')[1]!, status: 'matched', asin, grade: 'exact', alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null,
});

describe('pictures from cached Keepa answers', () => {
  it('reads every recorded product’s picture, the newest answer winning, from product answers only', async () => {
    const pictures = cachedPictures(await cacheWithFixtures());
    expect(pictures.size).toBe(22);
    expect(pictures.get('B0BGYFTPGK')).toBe('https://m.media-amazon.com/images/I/31335X5Nl8L.jpg');
    expect(pictures.get('B09M3TL9BB')).toBe('https://m.media-amazon.com/images/I/41WmSLY8N0L.jpg');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fills listings with none, keeps a stored one, creates none, and does nothing the second time', async () => {
    const pictures = cachedPictures(await cacheWithFixtures());
    const store = new MemoryScanStore();
    const had = 'https://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg';
    await store.putListing(listing('B0BGYFTPGK', null));
    await store.putListing(listing('B09M3TL9BB', had));
    await store.putListing(listing('B0NOTCACHED', null));
    await store.putMatch(match('RYOBI:PCL235B', 'B0BGYFTPGK'));
    await store.putMatch(match('DEWALT:DCF921B', 'B09M3TL9BB'));

    const first = await backfillPictures(store, pictures);
    expect(first).toEqual({ listings: 1, deals: 0, parts: 1 });
    expect(backfillSentence(first)).toBe('Found pictures for 1 part from data already stored. Nothing was spent.');
    expect((await store.getListing('B0BGYFTPGK'))!.image).toBe('https://m.media-amazon.com/images/I/31335X5Nl8L.jpg');
    expect((await store.getListing('B09M3TL9BB'))!.image).toBe(had);
    expect((await store.getListing('B0NOTCACHED'))!.image).toBeNull();
    expect(await store.getListing('B01H9BL8EO')).toBeUndefined();

    const again = await backfillPictures(store, cachedPictures(join(dir, 'cache')));
    expect(again).toEqual({ listings: 0, deals: 0, parts: 0 });
    expect(backfillSentence(again)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with no cache folder, finds nothing', () => {
    expect(cachedPictures(join(tmpdir(), 'no-such-cache-dir-pictures'))).toEqual(new Map());
  });

  it('on the real store after six scans, with the Keepa answers and Home Depot pages recorded in fixtures/', async () => {
    const store = await loadScanFolder(join(FIX, 'e2e-2026-11-23', 'after-scan6'));
    const coverage = async () => pictureCoverage((await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles);
    const pictured = async () => (await store.listListings()).filter((l) => l.image).length;
    // Before: what the app showed (docs/decisions.md, Nov 25): 46 of 258 rows, 46 of 153 distinct parts.
    expect(await pictured()).toBe(573);
    expect(await coverage()).toEqual({ deals: 46, dealsOf: 258, parts: 46, partsOf: 153 });

    const cacheDir = await cacheWithFixtures();
    // SerpApi's recorded Home Depot list pages, cached as the agent caches them (DirCache, by engine).
    const cache = new DirCache(cacheDir);
    for (const name of ['hd-bundles-ryobi-p1', 'hd-bundles-dewalt-p1', 'hd-bogo-bundles-ryobi-p1', 'hd-bogo-bundles-dewalt-p1', 'hd-search-ryobi-combo-p1', 'hd-search-dewalt-combo-p1', 'hd-search-ryobi-ratchet']) {
      await cache.set(`engine=home_depot&page=1&q=${name}`, { at: 1, data: json('recorded', `${name}.json`) });
    }
    const r = await backfillPictures(store, cachedPictures(cacheDir), cachedHomeDepotPictures(cacheDir));
    expect(fetchSpy).not.toHaveBeenCalled();
    // Four stored listings are in the recorded Keepa answers without a picture, none a part's chosen listing; the recorded
    // Home Depot pages hold 20 of the 258 bundles and 33 of the 50 catalog parts. The owner's own cache (521 Keepa answers,
    // and the SerpApi list pages of his first scans) is not this: his numbers will differ, most likely higher.
    expect(r).toEqual({ listings: 4, deals: 20, parts: 33 });
    expect(await pictured()).toBe(577);
    const after = await coverage();
    expect(after).toEqual({ deals: 62, dealsOf: 258, parts: 48, partsOf: 153 });
  });
});

describe('the backfill after an upgrade', () => {
  it('runs once at start, says one line in Activity, and never again', async () => {
    const { createAgent } = await import('../app');
    dir = mkdtempSync(join(tmpdir(), 'pictures-agent-'));
    const noNetwork = (async () => {
      throw new Error('the picture backfill must not reach the network');
    }) as unknown as typeof fetch;
    const agent = createAgent({ dataDir: dir, port: 0, timers: false, fetchFn: noNetwork, now: () => Date.UTC(2026, 10, 25, 12) });
    try {
      await agent.work.idle();
      // The store as the version before left it: a part's listing with no picture, its Keepa answer in the cache.
      await agent.work.scanStore.putListing(listing('B0BGYFTPGK', null));
      await agent.work.scanStore.putMatch(match('RYOBI:PCL235B', 'B0BGYFTPGK'));
      await new DirCache(join(dir, 'cache')).set('keepa:product?asin=B0BGYFTPGK,B01H9BL8EO,B09M3TL9BB&domain=1&history=0&stats=180', { at: 2, data: PRODUCTS });
      agent.store.update('runtime', (r) => ({ ...r, migrations: (r.migrations ?? []).filter((m) => m !== 'keepa-picture-backfill') }));

      await agent.work.signalsAtStart();
      const line = 'Found pictures for 1 part from data already stored. Nothing was spent.';
      expect(agent.store.get('activity').runs.map((r) => r.summary)).toContain(line);
      expect(agent.store.get('runtime').migrations).toContain('keepa-picture-backfill');
      expect((await agent.work.scanStore.getListing('B0BGYFTPGK'))!.image).toBe('https://m.media-amazon.com/images/I/31335X5Nl8L.jpg');

      // A second start: done already, nothing said again.
      await agent.work.signalsAtStart();
      expect(agent.store.get('activity').runs.filter((r) => r.summary === line)).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await agent.work.idle();
      agent.close();
    }
  });
});
