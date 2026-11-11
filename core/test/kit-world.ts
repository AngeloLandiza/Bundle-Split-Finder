// A replayed world for the ways-to-sell tests of the CSV and the side panel: the recorded Home Depot
// searches and pages, the recorded Amazon searches, the owner's answer to PCL1600K2-P553's split, and the
// panel's own Look up. Nothing reaches the network.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { replayRecorded } from '../../scripts/replay';
import { parseBundlePage } from '../src/hdPage';
import { applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { PaidProblem, quotePaid, refusalFor, runPaid, savedAnswers } from '../src/scan/paid';
import { buildReport } from '../src/scan/report';
import { applyLookup, matchFromListings, type PartContext, runScan, sendLookup } from '../src/scan/runner';
import { knownModels } from '../src/scan/split';
import { DEFAULT_SCAN_SETTINGS, type PageOutcome, partKey, type ScanCounts, type PaidAction, type Quote, type ReadPages, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

export const KIT_T0 = Date.UTC(2026, 10, 11, 12);
export const P553_KEY = 'homedepot:320243741';
export const KIT_KEY = 'homedepot:317987591';
const QUESTION = `split:${P553_KEY}`;

export const KIT_SETTINGS: ScanSettings = {
  ...DEFAULT_SCAN_SETTINGS, brands: ['RYOBI'], catalogPagesPerScan: 0,
  queries: [{ q: 'ryobi 18v combo kit' }, { q: 'ryobi 18v combo kit', filterTokens: 'bwo64,m5d', bundlesOnly: true }],
};
const BRAND_PAGE: ScanSettings = { ...KIT_SETTINGS, queries: [], catalogPagesPerScan: 1 };

const PAGES = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'fixtures/homedepot-pages/pages-2026-11-10.json'), 'utf8')) as { pages: { itemId: string; text: string }[] }
).pages;

const recordedPages: ReadPages = async (ids) => ids.map((itemId): PageOutcome => {
  const rec = PAGES.find((p) => p.itemId === itemId);
  const content = rec ? parseBundlePage(rec.text, itemId) : null;
  return content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' };
});

export interface KitWorld {
  store: MemoryScanStore;
  cache: MemoryCache;
  ledger: string[];
}

/** The recorded free-plan account, with `account` over it (such as this hour's searches). */
function paidDeps(w: KitWorld, maxPerRun: number, account: Record<string, unknown> = {}) {
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, ...account }), { reserve: 0, maxPerRun });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: replayRecorded().fetchFn, now: () => KIT_T0, onSpend: (e) => void w.ledger.push(e.label) });
  return { budget, client };
}

/** The brand page, both listing pages with the recorded bundle pages, then the owner's answer: PCL1600K2 + P553 (or `none`). No lookup has run. */
export async function answeredKitWorld(answer: 'choice' | 'none' = 'choice', pages = true): Promise<KitWorld> {
  const w: KitWorld = { store: new MemoryScanStore(), cache: new MemoryCache(), ledger: [] };
  await runScan({ ...paidDeps(w, 5), store: w.store, settings: BRAND_PAGE, now: () => KIT_T0 });
  await runScan({ ...paidDeps(w, 2), store: w.store, settings: KIT_SETTINGS, now: () => KIT_T0, readPages: pages ? recordedPages : undefined });
  const question = (await w.store.getReview(QUESTION))!;
  const seen = reviewSignature(question);
  await applyReviewAnswer(w.store, QUESTION, answer === 'choice' ? { choice: 0, seen } : { none: true, seen }, KIT_T0);
  return w;
}

export const kitReport = async (w: KitWorld) => ({ ...(await buildReport(w.store, KIT_SETTINGS)), packaging: {} });

/**
 * What the worker answers to a quote: the store's refusal or the budget's, the number of searches and
 * the parts the per-scan limit leaves out (Ruling 72). `perScan` is the settings' searches per scan,
 * the manual-trigger budget's cap; default 20. `account` goes over the recorded account. Nothing is spent.
 */
export async function kitQuote(w: KitWorld, action: PaidAction, perScan = 20, account: Record<string, unknown> = {}): Promise<Quote> {
  const { budget } = paidDeps(w, perScan, account);
  const q = quotePaid(action, await savedAnswers(w.store), budget);
  return { ...q, refusal: (await refusalFor(w.store, action)) ?? q.refusal };
}

/** The panel's Look up as the worker runs it, under a per-scan limit of `perScan` (default 20); resolves to the refusal sentence, or null when it ran. */
export async function kitRunPaid(w: KitWorld, action: PaidAction, perScan = 20): Promise<string | null> {
  try {
    await runPaid({ ...paidDeps(w, perScan), store: w.store, now: () => KIT_T0, settings: KIT_SETTINGS }, action);
    return null;
  } catch (err) {
    if (err instanceof PaidProblem) return err.message;
    throw err;
  }
}

const NO_COUNTS: ScanCounts = {
  pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
  catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0,
};

/**
 * The kit's items looked up by the scan's own steps (a saved listing first, free; else one replayed search),
 * as the panel's Look up will run them once it asks for kit items. Until then the panel's own Look up leaves them.
 */
export async function kitLookUpItems(w: KitWorld, models: string[]): Promise<void> {
  const known = await knownModels(w.store);
  const ctx: PartContext = {
    ...paidDeps(w, 20), store: w.store, settings: KIT_SETTINGS, now: () => KIT_T0, prefix: 'panel', catalog: known.catalog, job: { counts: { ...NO_COUNTS } },
  };
  for (const model of models) {
    if (await matchFromListings(ctx, known.listings, { key: partKey('RYOBI', model), brand: 'RYOBI', model })) continue;
    const step = { kind: 'lookup', brand: 'RYOBI', model } as const;
    const result = await sendLookup(ctx, step);
    await applyLookup(ctx, step, result.data, result.at);
  }
}
