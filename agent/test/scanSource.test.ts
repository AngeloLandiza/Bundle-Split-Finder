// The free scan's hooks (agent/scanSource.ts): which source the agent's scan uses in each state, what its settings
// become, whether a due scheduled scan waits for Chrome, and the run's sentence.

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, toScanSettings } from '../../core/src/settings';
import { bundleListsOf, discoveryFor, discoveryNote, scanSourceOf, scheduledScanWaits } from '../scanSource';
import { latestSample } from '../../scripts/record-listing-sample';

const settings = toScanSettings(DEFAULT_SETTINGS);
const readers = { readBundleListing: async () => ({ products: [] }), readPromoPages: async () => [] };
const base = { app: {}, trigger: 'scheduled' as const, chromeConnected: true, serpCanPay: true, keepaCanLookUp: true, settings, readers };

describe('discoveryFor', () => {
  it('Chrome connected (the default auto): the lists come from Chrome, no SerpApi listing page and, with Keepa, no brand page', () => {
    const d = discoveryFor(base);
    expect(d.source).toBe('chrome');
    expect(d.settings.queries).toEqual([]);
    expect(d.settings.catalogPagesPerScan).toBe(0);
    expect(d.chromeListing?.queries).toMatchObject({ RYOBI: 'ryobi 18v combo kit', DEWALT: 'dewalt 20v combo kit' });
    expect(d.chromeListing?.readListing).toBe(readers.readBundleListing);
    expect(d.note).toBeNull();
    // A scheduled scan may not search: an empty list is not searched on SerpApi.
    expect(d.chromeListing?.serpFallback).toBeUndefined();
  });

  it('fix round: an empty Chrome list falls back to SerpApi only where the owner allowed a search', () => {
    expect(discoveryFor({ ...base, trigger: 'manual' }).chromeListing?.serpFallback).toEqual(settings.queries);
    expect(discoveryFor({ ...base, app: { scan: { listingSource: 'auto', serpWhenChromeClosed: true } } }).chromeListing?.serpFallback).toEqual(settings.queries);
    expect(discoveryFor({ ...base, trigger: 'manual', serpCanPay: false }).chromeListing?.serpFallback).toBeUndefined();
    expect(discoveryFor({ ...base, trigger: 'manual', app: { scan: { listingSource: 'chrome', serpWhenChromeClosed: true } } }).chromeListing?.serpFallback).toBeUndefined();
  });

  it('without Keepa the brand pages stay, within the scan\'s allowance as before', () => {
    expect(discoveryFor({ ...base, keepaCanLookUp: false }).settings.catalogPagesPerScan).toBe(settings.catalogPagesPerScan);
  });

  it('Chrome closed, a scan the owner started: SerpApi\'s listing pages, said in the summary', () => {
    const d = discoveryFor({ ...base, trigger: 'manual', chromeConnected: false });
    expect(d.source).toBe('serpapi');
    expect(d.settings.queries).toEqual(settings.queries);
    expect(d.chromeListing).toBeUndefined();
    expect(d.note).toBe('Chrome is closed, so the bundle lists were searched on SerpApi.');
  });

  it('Chrome closed and nothing may be searched: no list is read, and the summary says why', () => {
    const d = discoveryFor({ ...base, trigger: 'manual', chromeConnected: false, serpCanPay: false });
    expect(d).toMatchObject({ source: 'none', note: 'No new bundles were looked for: no searches are left.' });
    expect(d.settings.queries).toEqual([]);
    expect(discoveryFor({ ...base, app: { scan: { listingSource: 'chrome', serpWhenChromeClosed: false } }, trigger: 'manual', chromeConnected: false }).note)
      .toBe('No new bundles were looked for: Chrome is closed.');
  });

  it('the owner chose SerpApi: its listing pages even with Chrome open', () => {
    expect(discoveryFor({ ...base, app: { scan: { listingSource: 'serpapi', serpWhenChromeClosed: false } } }).source).toBe('serpapi');
  });
});

describe('scheduledScanWaits', () => {
  it('a scheduled scan waits for Chrome unless the owner let SerpApi find the bundles', () => {
    expect(scheduledScanWaits({}, false)).toBe(true);
    expect(scheduledScanWaits({}, true)).toBe(false);
    expect(scheduledScanWaits({ scan: { listingSource: 'auto', serpWhenChromeClosed: true } }, false)).toBe(false);
    expect(scheduledScanWaits({ scan: { listingSource: 'serpapi', serpWhenChromeClosed: false } }, false)).toBe(false);
    expect(scheduledScanWaits({ scan: { listingSource: 'chrome', serpWhenChromeClosed: true } }, false)).toBe(true);
  });

  it('a stored value that is not a choice reads as the default', () => {
    expect(scanSourceOf({ scan: { listingSource: 'bing' as never, serpWhenChromeClosed: 'yes' as never } })).toEqual({ listingSource: 'auto', serpWhenChromeClosed: false });
  });
});

describe('bundleListsOf (fix round 2: the run\'s Activity details)', () => {
  it('each list\'s total, pages and products found, with an empty list\'s sample; nothing without lists', () => {
    const sample = { kinds: { '#': 30 }, entries: [{ kind: '#', key: '1', text: '{}' }] };
    const lists = [
      { brand: 'RYOBI', query: 'ryobi 18v combo kit', pages: 1, listed: 0, added: 0, complete: false, empty: true, total: 24, sample },
      { brand: 'RYOBI', query: null, pages: 9, listed: 101, added: 101, complete: true, empty: false, total: 101, pagedOn: '/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64' },
    ];
    expect(bundleListsOf({ chromeListing: { done: true, pages: 10, bundles: 101, itemPagesRead: 0, complete: false, lists } })).toEqual([
      { brand: 'RYOBI', query: 'ryobi 18v combo kit', total: 24, pages: 1, found: 0, added: 0, empty: true, sample },
      { brand: 'RYOBI', query: null, total: 101, pages: 9, found: 101, added: 101, empty: false, pagedOn: '/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64' },
    ]);
    expect(bundleListsOf(null)).toEqual([]);
  });

  it('scripts/record-listing-sample.ts takes the newest scan whose lists carry a sample', () => {
    const run = (id: string, at: string, withSample: boolean) => ({
      id, kind: 'scan' as const, startedAt: at, finishedAt: at, status: 'finished', searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: '',
      bundleLists: [{ brand: 'RYOBI', query: null, total: 1, pages: 1, found: 0, added: 0, empty: true, ...(withSample ? { sample: { kinds: {}, entries: [] } } : {}) }],
    });
    expect(latestSample([run('a', '2026-11-23T10:00:00Z', true), run('b', '2026-11-23T12:00:00Z', true), run('c', '2026-11-23T13:00:00Z', false)])?.run.id).toBe('b');
    expect(latestSample([run('c', '2026-11-23T13:00:00Z', false)])).toBeNull();
  });
});

describe('discoveryNote', () => {
  it('says how many bundles the Chrome lists held, and nothing when none were read', () => {
    expect(discoveryNote({ chromeListing: { done: true, pages: 6, bundles: 24, itemPagesRead: 24, complete: true } })).toBe('Bundle lists read in Chrome: 24 bundles.');
    expect(discoveryNote({ chromeListing: { done: true, pages: 1, bundles: 12, itemPagesRead: 0, complete: false } })).toBe('Bundle lists read in Chrome: 12 bundles so far.');
    expect(discoveryNote({ chromeListing: { done: true, pages: 0, bundles: 0, itemPagesRead: 0, complete: false } })).toBeNull();
    expect(discoveryNote(null)).toBeNull();
    const lists = [
      { brand: 'DEWALT', query: 'dewalt 20v combo kit', pages: 1, listed: 3, added: 3, complete: true, empty: false },
      { brand: 'DEWALT', query: null, pages: 4, listed: 40, added: 37, complete: true, empty: false },
    ];
    expect(discoveryNote({ chromeListing: { done: true, pages: 5, bundles: 40, itemPagesRead: 0, complete: true, lists } }))
      .toBe('Bundle lists read in Chrome: 40 bundles (DEWALT: 3 with the search words, 37 more without them (40)).');
    const empty = lists.map((l) => ({ ...l, pages: 1, listed: 0, added: 0, empty: true }));
    expect(discoveryNote({ chromeListing: { done: true, pages: 2, bundles: 0, itemPagesRead: 0, complete: true, lists: empty, empty: true } }))
      .toBe("Home Depot's bundle lists came back empty (DEWALT: empty with the search words, empty without them); the bundles found before are kept.");
  });
});
