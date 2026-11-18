// Test helper: the PageViews the worker would send for recorded Home Depot pages, made by the real
// notePage over the recorded scan (the replay of fixtures/recorded). Nothing here reaches the network.
// Pages are fixtures/homedepot-pages/pages-2026-11-10.json; their prices, which those recordings cut out,
// are the shape captured on Nov 17 (fixtures/homedepot-pages/pricing-2026-11-17.json).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { replayRecorded } from '../../scripts/replay';
import { parseProductPage, type ProductPage } from '@core/hdPage';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { notePage } from '@core/scan/pageView';
import { runScan } from '@core/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@core/scan/types';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, SerpApiClient } from '@core/serpapi/client';
import { SERPAPI_ACCOUNT_FREE } from '../../core/test/fixtures';
import type { BundleView } from '../lib/messages';

const T0 = Date.UTC(2026, 10, 9, 12);
const VISIT = T0 + 2 * 60 * 60 * 1000;
export const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

// Paths from the repository root, where the tests run: jsdom replaces URL, so import.meta.url is no help here.
const dir = resolve('fixtures/homedepot-pages');
const pages = (JSON.parse(readFileSync(resolve(dir, 'pages-2026-11-10.json'), 'utf8')) as { pages: { itemId: string; text: string }[] }).pages;
const pricing = JSON.parse(readFileSync(resolve(dir, 'pricing-2026-11-17.json'), 'utf8')) as Record<string, { key: string; value: Record<string, unknown> }>;

/** The recorded page's inline script text for `itemId`. */
export const recordedText = (itemId: string): string => pages.find((p) => p.itemId === itemId)!.text;

/** The recorded page with the captured pricing entry put into its product object ($189, was $338 for 328814689). */
export function pricedText(itemId: string): string {
  const captured = pricing[itemId]!;
  const mark = `"base-catalog-${itemId}":{`;
  return recordedText(itemId).replace(mark, `${mark}${JSON.stringify(captured.key)}:${JSON.stringify(captured.value)},`);
}

/** 328814689 as the owner sees it: priced as captured. */
export const founderPage = (): ProductPage => parseProductPage(pricedText('328814689'), '328814689')!;

const bundle = (view: Awaited<ReturnType<typeof notePage>>): BundleView => {
  if (view.kind !== 'bundle') throw new Error(`expected a bundle, got ${view.kind}`);
  return view;
};

/** The recorded ratchet scan: one listing page and two lookups, all from the replay. */
async function scanned(): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount(SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings: RATCHET, now: () => T0 });
  return store;
}

/** After the recorded scan: both parts matched and priced, so the estimate. */
export async function estimateView(): Promise<BundleView> {
  return bundle(await notePage(await scanned(), RATCHET, founderPage(), VISIT));
}

/** On an empty store: the page names both parts, no listing is saved, so a lookup of 2 parts waits. */
export async function lookupView(): Promise<BundleView> {
  return bundle(await notePage(new MemoryScanStore(), RATCHET, founderPage(), VISIT));
}

/** 328814689 with its bullets taken out (hand-made from the recording): one open question offering one reading. */
export async function oneReadingView(): Promise<BundleView> {
  return bundle(await notePage(new MemoryScanStore(), RATCHET, { ...founderPage(), bullets: [] }, VISIT));
}

/** 328690510 (PCL500525SB, no split rule): an open question that offers no reading. */
export async function noReadingView(): Promise<BundleView> {
  return bundle(await notePage(new MemoryScanStore(), RATCHET, parseProductPage(recordedText('328690510'), '328690510')!, VISIT));
}
