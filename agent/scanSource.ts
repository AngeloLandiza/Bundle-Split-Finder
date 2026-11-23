// The free scan's hooks into the agent's scan (agent/work.ts), kept here so work.ts only calls them (Nov 23): where a
// scan's bundle lists come from (core/src/scan/listingSource.ts chooseListingSource, with the owner's Settings), whether
// a due scheduled scan waits for Chrome, what the scan's settings become, and the sentence Activity shows.
//
// The Amazon brand pages (the catalog step, runner.ts catalogWanted) are not read when Keepa can look parts up: measured on
// the owner's store (scripts/measure-catalog-step.ts, fixtures/e2e-2026-11-23/after-scan3), the 92 listings only the brand
// pages saved change no split of the 59 bundles, and the 5 parts they matched (6 with a B twin) are each one Keepa
// lookup (11 tokens) away; the 3 pages cost 3 of the month's searches. Without Keepa they stay, within the fifth of the
// scan's allowance they always had, which is 0 when the budget is short (it skips cleanly).

import type { AppSettings } from '../core/src/api/contract';
import { chooseListingSource, DEFAULT_LISTING_SOURCE, type ListingSourceSetting, type SourceChoice } from '../core/src/scan/listingSource';
import type { ScanDeps } from '../core/src/scan/runner';
import type { ScanJob, ScanSettings } from '../core/src/scan/types';
import { BRAND_QUERIES } from '../core/src/settings';
import type { RemoteReaders } from './remoteReaders';

export interface ScanSource {
  listingSource: ListingSourceSetting;
  serpWhenChromeClosed: boolean;
}

/** The owner's choice, with the defaults for a store written before it existed. */
export function scanSourceOf(app: Pick<AppSettings, 'scan'>): ScanSource {
  const s = app.scan;
  return {
    listingSource: s?.listingSource === 'chrome' || s?.listingSource === 'serpapi' || s?.listingSource === 'auto' ? s.listingSource : DEFAULT_LISTING_SOURCE,
    serpWhenChromeClosed: s?.serpWhenChromeClosed === true,
  };
}

/**
 * The scheduler's check: a due scheduled scan with Chrome closed waits (it is started by a later tick, once the helper is
 * back), unless the owner let SerpApi find the bundles then. Whether a search can pay is the scan's own check, made after
 * the account is read; here it is taken as yes, so a scan that may search is never held back.
 */
export function scheduledScanWaits(app: Pick<AppSettings, 'scan'>, chromeConnected: boolean): boolean {
  const s = scanSourceOf(app);
  return chooseListingSource({ setting: s.listingSource, chromeConnected, trigger: 'scheduled', serpWhenChromeClosed: s.serpWhenChromeClosed, serpCanPay: true }).source === 'wait';
}

export interface Discovery {
  source: SourceChoice['source'];
  /** The scan's settings: no SerpApi listing page unless SerpApi is the source; no Amazon brand page when Keepa looks parts up. */
  settings: ScanSettings;
  /** The Chrome readers, when Chrome is the source. */
  chromeListing?: NonNullable<ScanDeps['chromeListing']>;
  /** A sentence for the run's summary, when the source needs one. */
  note: string | null;
}

export function discoveryFor(i: {
  app: Pick<AppSettings, 'scan'>;
  trigger: 'manual' | 'scheduled';
  chromeConnected: boolean;
  /** SerpApi can pay for one search now (the scan's SearchBudget). */
  serpCanPay: boolean;
  /** Keepa has a key, Amazon lookups go through it, and its token count was read. */
  keepaCanLookUp: boolean;
  settings: ScanSettings;
  readers: Pick<RemoteReaders, 'readBundleListing' | 'readPromoPages'>;
}): Discovery {
  const s = scanSourceOf(i.app);
  const choice = chooseListingSource({ setting: s.listingSource, chromeConnected: i.chromeConnected, trigger: i.trigger, serpWhenChromeClosed: s.serpWhenChromeClosed, serpCanPay: i.serpCanPay });
  const catalogPagesPerScan = i.keepaCanLookUp ? 0 : i.settings.catalogPagesPerScan;
  if (choice.source === 'chrome') {
    return {
      source: 'chrome', settings: { ...i.settings, queries: [], catalogPagesPerScan }, note: null,
      chromeListing: { queries: BRAND_QUERIES, readListing: i.readers.readBundleListing, readPages: i.readers.readPromoPages },
    };
  }
  if (choice.source === 'serpapi') {
    return { source: 'serpapi', settings: { ...i.settings, catalogPagesPerScan }, note: i.chromeConnected ? null : 'Chrome is closed, so the bundle lists were searched on SerpApi.' };
  }
  // 'none', or a 'wait' that reached a scan (Chrome went away after the scheduler looked): no list is read or searched.
  return { source: choice.source, settings: { ...i.settings, queries: [], catalogPagesPerScan }, note: `No new bundles were looked for: ${choice.why === 'Chrome closed' ? 'Chrome is closed' : 'no searches are left'}.` };
}

/** The run's sentence about the lists read in Chrome ("Bundle lists read in Chrome: 24 bundles."); null when none were. */
export function discoveryNote(job: Pick<ScanJob, 'chromeListing'> | null | undefined): string | null {
  const c = job?.chromeListing;
  if (!c?.done || c.pages === 0) return null;
  return `Bundle lists read in Chrome: ${c.bundles} ${c.bundles === 1 ? 'bundle' : 'bundles'}${c.complete ? '' : ' so far'}.`;
}
