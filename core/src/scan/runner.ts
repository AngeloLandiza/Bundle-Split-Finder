// The scan runner: a few pages of the brands' own Amazon listings, then Home Depot listing
// pages, then the bundles' own pages (free, never a search), then splits (free), then the pages of
// the plain kits those splits hold (free, step 6), then one Amazon lookup per new part that no saved
// listing answers and a refresh per stale price.
// The lookup step, matching from saved listings and the match question are shared with the
// side panel's Look up and Verify (paid.ts), through PartContext.
//
// "Rule n" refers to the step 2 plan, Task 4 ("The scan runner"); "2c rule n" to the step 2c
// plan, Task 2 ("The catalog phase"); "3 rule n" to the step 3 plan, Task 3 ("Runner: stop on
// request, and one failed lookup does not end a scan"); "Pn" to the step 4 plan, Task 4
// ("Runner reads pages before the split").

import { type Catalog, catalogEntry, type Decomposition } from '../decompose';
import { kitIndex, kitItemParts, kitKey, kitPageStored, kitRecords } from '../kitContents';
import { BRAND_NOT_CONFIRMED, type Candidate, type Grade, type Graded, isReviewCap, maySparePart, pick, type Picked, sameModel, toolPageToRead } from '../match';
import { KEEPA_LOOKUP_TOKEN_ESTIMATE, productTokenEstimate } from '../keepa/estimates';
import { amazonPriceDelta, partTrendFromProduct, readPartTrend } from '../keepa/trends';
import type { Cache } from '../serpapi/client';
import type { KeepaScaleSettings } from '../keepa/plan';
import { keepaTokensForScan, type LookupBlock, lookupBlockOf, routeAmazonWork } from '../keepa/route';
import { planScan } from '../scanPlan';
import { estimatedJudgeCost } from '../settings';
import type { TokenBudget } from '../keepa/budget';
import { KeepaBudgetExceededError } from '../keepa/client';
import { BudgetExceededError, RateLimitedError, type SearchResult } from '../serpapi/client';
import { amazonHasNextPage, parseAmazonProduct, parseAmazonSearch, parseHomeDepotSearch } from '../serpapi/parsers';
import { choicesOf, NONE, notKnown, ownerSplit, RESOLVED_BY_SCAN, sameChoices, splitChoices } from './answers';
import { looksLikeBundle, wantedFor } from './classify';
import { candidatesFor, listingFrom } from './listings';
import { type KnownModels, knownModels, readSplit } from './split';
import { closeRest, endStep, ensurePipeline, failStep, finishUnit, measure, moveUnits, newPipeline, reopenStep, type StepId, setJudge, skipStep, startStep } from './pipeline';
import { rejectedOf, twinKeys, writeTwins } from './twins';
import { type EbayPart, type EbayStep, noteEbay, runEbayPass } from './ebayPass';
import { HOME_DEPOT_ITEM_ID, pickUnread } from './kitPage';
import { bundleKey, PART_PRICE_READS_MAX, partKey, priceActive, resolvedParts } from './types';
import type {
  BudgetView, BundleRecord, CatalogCursor, CatalogRecord, ListingRecord, MatchRecord, PageOutcome, PageReading, PartPriceRecord, PriceRecord, ReadPages, ReadPartPrices,
  ReviewCandidate,
  ScanJob, ScanSettings,
  ScanStep, ScanStore, SearchClient, StopReason,
} from './types';

export interface ScanDeps {
  client: SearchClient;
  budget: BudgetView;
  store: ScanStore;
  settings: ScanSettings;
  /** Clock, in epoch ms. Default Date.now. */
  now?: () => number;
  /** First part of every ledger label. Default 'scan'. The command line passes 'demo'. */
  labelPrefix?: string;
  /** Checked before every paid step. True ends the scan as stopped by the user. */
  shouldStop?: () => boolean;
  /**
   * Reads Home Depot pages in the owner's browser: bundle pages (P1), then kit pages (step 6). Without
   * it no page is read; pages read before still count in the split (P5) and in the ways to sell.
   */
  readPages?: ReadPages;
  /**
   * Step 9: reads Home Depot's own price for parts sold alone, in the owner's browser, after the kit
   * pages (readPartPricesPass). Without it no price is read; prices read before are still shown.
   */
  readPartPrices?: ReadPartPrices;
  /**
   * Step 13 (W4): what the progress row says for the page and price steps when there is no reader, in four words or
   * fewer. Default "no page reader" / "no price reader". The agent says "Chrome closed" when no helper is connected.
   */
  noReaderReason?: string;
  /**
   * Step 10: the eBay step, after Home Depot's part prices (ebayPass.ts): eBay's search and item reads and a
   * model's judgement of each listing, as a reference value per part. `skip` says why it does not run (keys
   * missing). Absent: the step does not exist (the command line). It never stops a scan.
   */
  ebay?: EbayStep;
  /**
   * v2 Keepa: product pulls for refresh and identify (1 token each when not cached).
   * SerpApi still owns HD pages and amazon text search.
   */
  keepaProduct?: (asin: string, label: string, maxAgeMs?: number) => Promise<SearchResult>;
  keepaLookup?: (brand: string, model: string, label: string) => Promise<SearchResult>;
  keepaBudget?: TokenBudget;
  /** When set with keepaProduct, refresh steps are capped by planKeepaRun instead of SerpApi. */
  keepaScale?: KeepaScaleSettings;
  /** Plan §6: cache part trends after Keepa refreshes. */
  trendWriter?: (trend: import('../keepa/trends').PartTrend) => void | Promise<void>;
  /** Optional cache for part-trend reads on Keepa refresh (extension and agent). */
  cache?: Cache;
  /**
   * BOGO pairs the agent found (core/src/tracking/bogoPairs.ts): a pair's bundle key to its group id. Their parts are
   * looked up after every other bundle's, at most PAIR_LOOKUPS_PER_GROUP new pairs per group a scan (pairLookupOrder).
   */
  bogoPairs?: Readonly<Record<string, string>>;
  /**
   * Nov 23 (the agent): a bundle whose own Home Depot page is not read yet is not a Review question; it waits for its
   * page (splitOne, waiting_page), and an open question a scan opened for it is withdrawn. Default false: the command
   * line, which reads no page, asks from the title as before.
   */
  waitForPages?: boolean;
}

type CatalogStep = Extract<ScanStep, { kind: 'catalog' }>;
type Listing = Extract<ScanStep, { kind: 'listing' }>;
export type LookupStep = Extract<ScanStep, { kind: 'lookup' }>;
export type IdentifyStep = Extract<ScanStep, { kind: 'identify' }>;
type Lookup = LookupStep;
type Refresh = Extract<ScanStep, { kind: 'refresh' }>;
type AmazonStep = Lookup | Refresh | IdentifyStep;

const isAmazonStep = (s: ScanStep): s is AmazonStep => s.kind === 'lookup' || s.kind === 'refresh' || s.kind === 'identify';

/**
 * What the lookup step, and matching a part from saved listings, need. A scan's run is one. The
 * side panel's Look up and Verify build their own (paid.ts), so they apply exactly a scan's rules.
 */
export interface PartContext {
  client: SearchClient;
  store: ScanStore;
  settings: ScanSettings;
  now: () => number;
  /** First part of every ledger label. */
  prefix: string;
  /**
   * The models the splitter and wantedFor know (2c rule 4, knownModels). A scan builds it when the
   * listing queue is empty, or when a continued job starts in the parts phase.
   */
  catalog: Catalog;
  /** Counted as a scan counts. The panel's are not kept. */
  job: Pick<ScanJob, 'counts'>;
}

interface Run extends PartContext {
  budget: BudgetView;
  shouldStop: () => boolean;
  readPages: ReadPages | null;
  readPartPrices: ReadPartPrices | null;
  noReaderReason?: string;
  ebay: EbayStep | null;
  keepaProduct: ScanDeps['keepaProduct'];
  keepaLookup?: ScanDeps['keepaLookup'];
  keepaBudget: ScanDeps['keepaBudget'];
  keepaScale?: ScanDeps['keepaScale'];
  trendWriter?: ScanDeps['trendWriter'];
  cache?: Cache;
  bogoPairs: Readonly<Record<string, string>>;
  waitForPages: boolean;
  job: ScanJob;
  /** Set by rule 8 and 3 rules 1 and 2: no further search in this run. */
  halted: boolean;
  /** 3 rule 2: the last lookup or refresh of this run failed, and no paid step has succeeded since. */
  lastFailed: boolean;
  /** 3 rule 2: steps this run set aside after a failure. They lead `deferred`, in the order they failed. */
  setAside: number;
  /**
   * Ruling 48: the steps this run's planning deferred for the phase now running, in plan order,
   * that may still move into the queue when a planned step is answered from the cache. Each
   * leaves this list when it moves, so it moves at most once. Never a step set aside after a
   * failure. A continued job starts with it empty, so its listing pages are not topped up; one
   * continued in the listing phase still plans its parts (planParts), which fills it, so its
   * parts phase may top up. Safe either way: every move is checked against what may still be spent.
   */
  movable: ScanStep[];
  /**
   * Rulings 50 and 57: the parts whose last lookup or refresh failed, as the job before this one
   * left them, least recent failure first; planned after every other candidate, in this order.
   */
  failedBefore: string[];
  /** Step 15: part keys this run's planning has planned (queued or deferred), so a second pass plans only new ones. */
  plannedKeys: Set<string>;
  /** Step 15: part keys of the splits this run's part-price pass settled (splitWaiting), for the second lookup pass. */
  settledParts: Set<string>;
}

/** Start a scan, or continue the newest one whose status is "running". Resolves with the finished job. */
export async function runScan(deps: ScanDeps): Promise<ScanJob> {
  const run = await startJob(deps);
  beginPipeline(run);
  if (run.job.phase === 'listing') {
    // Amazon brand pages, then Home Depot pages: one queue.
    await runQueue(run);
    // P1: the bundles' own pages, free, once the queue is empty and before the split.
    const bundlePass = await readBundlePages(run);
    // Read once for the split and the planning pass that follows it.
    const known = await knownModels(run.store);
    run.catalog = known.catalog;
    await splitBundles(run, known);
    // Step 6: then the pages of the plain kits the splits now hold, free, before the planning, which
    // looks up a kit's items only from its page. Not after Home Depot refused a page, or the reader failed.
    // The bundle pages asked for and not read still count: the two passes never ask for more than the cap.
    const kitPass = bundlePass.goOn ? await readKitPages(run, bundlePass.notRead) : bundlePass;
    if (!kitPass.goOn) {
      // Step 11: the row says why these did not run.
      for (const id of ['kitPages', 'partPrices'] as const) skipStep(run.job, id, kitPass.why ?? 'page read failed');
    }
    // Step 15, decision 3: the Amazon lookups, which make the estimates, before the slow free steps.
    await planParts(run, known.listings);
  } else if (run.job.phase === 'parts') {
    // A continued job: its lookups are judged with the models the split knew.
    run.catalog = (await knownModels(run.store)).catalog;
  }
  if (run.job.phase === 'parts') await runQueue(run);
  // Step 9: then Home Depot's prices for the parts sold alone, free, unless Home Depot refused a page (skipped above),
  // for at most PART_PRICE_MS; what is left is read by the next scan, or by the agent between scans.
  if (stepWaits(run.job, 'partPrices')) await readPartPricesPass(run);
  // Step 15: the splits the part prices settled have parts nobody looked up yet: a second pass for those only.
  await lookUpSettled(run);
  // Step 10: then eBay's reference values for the parts, free, whether or not Home Depot refused a page.
  if (run.ebay?.kind === 'skip' || stepWaits(run.job, 'ebay')) await ebayPass(run);
  return finish(run);
}

/**
 * Step 15: the lookups for the parts a split settled by the part-price pass (splitWaiting) newly holds, through the same
 * routing (Keepa above its reserve, then what is left of the per-scan searches), counted in the same Amazon step, which
 * opens again with the added units. Nothing when the run was halted or stopped, or no new part is wanted.
 */
async function lookUpSettled(run: Run): Promise<void> {
  const { job } = run;
  if (run.settledParts.size === 0 || run.halted || run.shouldStop() || job.phase !== 'parts' || job.stopReason === 'user') return;
  const known = new Set([...run.plannedKeys, ...[...job.deferred, ...job.queue].flatMap((s) => (s.kind === 'lookup' || s.kind === 'refresh' || s.kind === 'identify' ? [partKey(s.brand, s.model)] : []))]);
  const queuedBefore = job.queue.length;
  await planParts(run, (await knownModels(run.store)).listings, (k) => run.settledParts.has(k) && !known.has(k));
  if (job.queue.length === queuedBefore || job.queue.length === 0) return;
  reopenStep(job, 'amazon', { remaining: job.queue.filter(isAmazonStep).length, now: run.now() });
  await runQueue(run);
}

/** Step 15: the step has not run in this job yet (a continued job may have run it before the order changed). */
const stepWaits = (job: ScanJob, id: StepId): boolean => {
  const s = job.pipeline?.find((p) => p.id === id);
  return s === undefined || s.state === 'next' || s.state === 'now';
};

// ---------------------------------------------------------------- rule 1: start

async function startJob(deps: ScanDeps): Promise<Run> {
  const now = deps.now ?? Date.now;
  const { store, settings, budget } = deps;
  // A stop, once asked for, holds for the rest of the run (finish reads it).
  const asked = deps.shouldStop ?? (() => false);
  let stopAsked = false;
  const shouldStop = (): boolean => (stopAsked ||= asked());
  const scans = await store.listScans();
  const newest = scans[0];
  const failedBefore = failingBefore(scans);
  const run = (job: ScanJob): Run => ({
    client: deps.client, budget, store, settings, now, prefix: deps.labelPrefix ?? 'scan', shouldStop,
    readPages: deps.readPages ?? null, readPartPrices: deps.readPartPrices ?? null, noReaderReason: deps.noReaderReason, ebay: deps.ebay ?? null,
    keepaProduct: deps.keepaProduct, keepaLookup: deps.keepaLookup, keepaBudget: deps.keepaBudget, keepaScale: deps.keepaScale, trendWriter: deps.trendWriter, cache: deps.cache,
    bogoPairs: deps.bogoPairs ?? {}, waitForPages: deps.waitForPages ?? false,
    job, catalog: new Map(), halted: false, lastFailed: false, setAside: 0, movable: [], failedBefore, plannedKeys: new Set(), settledParts: new Set(),
  });

  // An interrupted job is continued as saved: no new plan, whatever budget this run has. A job
  // saved before step 4 has no pagesRead: it counts from 0, so its page limit is not NaN (P1).
  if (newest?.status === 'running') return run({ ...newest, counts: { ...newest.counts, pagesRead: newest.counts.pagesRead ?? 0 } });

  const startedAt = now();
  // 2c rule 1: brand pages first, from at most a fifth of the allowance, measured before
  // anything is spent. Pages that do not fit are dropped, not deferred: the cursor keeps the place.
  const catalog = await catalogWanted(store, settings);
  const catalogPages = Math.min(catalog.length, Math.floor(budget.spendable * 0.2));
  // Page 1 of every query in settings order, then page 2 of every query, and so on.
  const inOrder: Listing[] = [];
  for (let page = 1; page <= settings.pagesPerQuery; page++) {
    for (const q of settings.queries) {
      inOrder.push({ kind: 'listing', q: q.q, page, filterTokens: q.filterTokens ?? null, bundlesOnly: q.bundlesOnly ?? false });
    }
  }
  // Ruling 48: the pages the last job deferred go first, in its order, so at a low limit one
  // query cannot hold the only slot on every scan. Only pages the settings still ask for.
  // Ruling 52: a page whose search failed in the last job goes after every other page.
  const failedPages = failedPagesOf(newest);
  // F9 review: the pages whose last answer said there is a next one, as the last job left them.
  const askedFor = new Set(inOrder.map(pageKey));
  const answered = new Set([...answeredPagesOf(newest)].filter((k) => askedFor.has(k) && !failedPages.has(k)));
  const pages = deferredFirst(inOrder, newest?.deferred ?? [], failedPages, answered);
  const wants = await wantedParts(store, settings, startedAt, undefined, failedBefore, deps.bogoPairs);
  const plan = planScan(budget.spendable - catalogPages, { hdPagesWanted: pages.length, pendingLookups: wants.lookups, staleRefreshes: wants.refreshes });
  const deferred = pages.slice(plan.hdPages);
  // Ruling 52: a page that failed last job runs only if planning reaches it, never by a top-up:
  // once the other pages come from the cache, a top-up would reach it on every scan, and its
  // failure would end the scan before any lookup.
  const movable = deferred.filter((p) => !failedPages.has(pageKey(p)));
  const job: ScanJob = {
    id: String(startedAt), startedAt, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'listing',
    queue: [...catalog.slice(0, catalogPages), ...pages.slice(0, plan.hdPages)], deferred, searchesUsed: 0, keepaTokensUsed: 0,
    counts: {
      pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
      catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0, partPricesRead: 0,
    },
  };
  job.pipeline = newPipeline(job.queue.length);
  // Ruling 57: carried on, so a part that keeps failing stays behind the others until it is answered.
  if (failedBefore.length > 0) job.failingParts = [...failedBefore];
  if (answered.size > 0) job.answeredPages = [...answered];
  await store.putScan(job);
  return { ...run(job), movable };
}

/** A listing page's key in `ScanJob.failedPages` (Ruling 52). */
const pageKey = (p: Listing): string => JSON.stringify([p.q, p.page, p.filterTokens ?? null]);

/** The pages a stored job's search failed on (Ruling 52). Stored data is untrusted: anything but a list of strings counts as none. */
function failedPagesOf(job: ScanJob | undefined): Set<string> {
  const pages: unknown = job?.failedPages;
  return new Set(Array.isArray(pages) ? pages.filter((p): p is string => typeof p === 'string') : []);
}

/** The pages a stored job knew to have a next page (F9 review). Untrusted, as failedPagesOf. */
function answeredPagesOf(job: ScanJob | undefined): Set<string> {
  const pages: unknown = job?.answeredPages;
  return new Set(Array.isArray(pages) ? pages.filter((p): p is string => typeof p === 'string') : []);
}

/** The key of the page before `p` in its query. */
const earlierPageKey = (p: Listing): string => pageKey({ ...p, page: p.page - 1 });

/**
 * The parts a stored job left failing, least recent failure first (Ruling 57); a job saved before
 * that field existed gives the parts it set aside (Ruling 50). Stored data is untrusted: anything
 * but a list of strings counts as none.
 */
function failingPartsOf(job: ScanJob | undefined): string[] {
  const parts: unknown = Array.isArray(job?.failingParts) ? job.failingParts : job?.setAsideParts;
  return Array.isArray(parts) ? [...new Set(parts.filter((p): p is string => typeof p === 'string'))] : [];
}

/**
 * Rulings 50 and 57: the parts failing as of the job before the next one, from the stored jobs,
 * newest first (listScans): the newest job's, or the one's before it while the newest is still
 * running and so is the job a scan continues.
 */
export function failingBefore(scans: ScanJob[]): string[] {
  const newest = scans[0];
  return failingPartsOf(newest?.status === 'running' ? scans[1] : newest);
}

/** Ruling 57: `job.failingParts` with only the parts `keep` accepts; absent when none is left. */
function keepFailing(job: ScanJob, keep: (key: string) => boolean): void {
  const left = (job.failingParts ?? []).filter(keep);
  if (left.length > 0) job.failingParts = left;
  else delete job.failingParts;
}

const sameListing = (a: Listing, b: Listing): boolean =>
  a.q === b.q && a.page === b.page && (a.filterTokens ?? null) === (b.filterTokens ?? null);

/** A listing page's query: pages of one query share it. */
const queryKey = (p: Listing): string => JSON.stringify([p.q, p.filterTokens ?? null]);

/**
 * `pages` with those that equal a listing step in `earlier` first, in `earlier`'s order; the rest
 * keep their order; and last, in that same order, the pages in `failed` and the later pages of
 * their queries (Ruling 52). Then, within the places each query holds, a page N waits behind page
 * N−1 while N−1 is unanswered: not in `answered` (its last answer said there is a next page), or
 * failed. Page N−1 may say page N does not exist (final review); but once it has said there is a
 * page N, page N keeps its deferred place, or a low limit would read page 1 on every scan and never
 * page 2 (F9 review).
 */
function deferredFirst(pages: Listing[], earlier: ScanStep[], failed: Set<string> = new Set(), answered: Set<string> = new Set()): Listing[] {
  const first: Listing[] = [];
  for (const step of earlier) {
    if (step.kind !== 'listing') continue;
    const page = pages.find((p) => sameListing(p, step));
    if (page && !first.includes(page)) first.push(page);
  }
  const ordered = [...first, ...pages.filter((p) => !first.includes(p))];
  const failedAt = pages.filter((p) => failed.has(pageKey(p)));
  const isFailed = (p: Listing) => failedAt.some((f) => queryKey(f) === queryKey(p) && f.page <= p.page);
  const placed = [...ordered.filter((p) => !isFailed(p)), ...ordered.filter(isFailed)];
  const free = (p: Listing) => p.page <= 1 || (answered.has(earlierPageKey(p)) && !failed.has(earlierPageKey(p)));
  const byQuery = new Map<string, Listing[]>();
  for (const p of placed) byQuery.set(queryKey(p), [...(byQuery.get(queryKey(p)) ?? []), p]);
  for (const [query, group] of byQuery) {
    const out: Listing[] = [];
    // Pages held, by the page number they wait for.
    const held = new Map<number, Listing[]>();
    const emit = (p: Listing): void => {
      out.push(p);
      const next = held.get(p.page) ?? [];
      held.delete(p.page);
      for (const n of next) emit(n);
    };
    for (const p of group) {
      if (free(p) || out.some((o) => o.page === p.page - 1) || !group.some((o) => o.page === p.page - 1)) emit(p);
      else held.set(p.page - 1, [...(held.get(p.page - 1) ?? []), p]);
    }
    byQuery.set(query, out);
  }
  return placed.map((p) => byQuery.get(queryKey(p))!.shift()!);
}

/**
 * A listing step whose earlier page has not said there is a next page, in this job or one before it
 * (F9 review): it must wait for that page.
 */
const waitsForEarlierPage = (step: ScanStep, job: ScanJob): boolean =>
  step.kind === 'listing' && step.page > 1 && !(job.answeredPages ?? []).includes(earlierPageKey(step));

/**
 * 2c rule 1: `catalogPagesPerScan` brand pages, shared by the scanned brands that have a
 * brand filter, one page per brand in turn: a brand with no cursor first, then the brand
 * whose cursor moved longest ago, ties by name. Each brand reads on from its cursor.
 */
async function catalogWanted(store: ScanStore, settings: ScanSettings): Promise<CatalogStep[]> {
  const brands = unique(settings.brands.map((b) => b.trim().toUpperCase())).filter((b) => brandFilter(settings, b) !== null);
  const cursors = new Map<string, CatalogCursor | undefined>();
  for (const b of brands) cursors.set(b, await store.getCursor(b));
  const movedAt = (b: string) => cursors.get(b)?.updatedAt ?? -Infinity;
  brands.sort((a, b) => (movedAt(a) !== movedAt(b) ? (movedAt(a) < movedAt(b) ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0));
  const wanted = Math.max(0, Math.floor(settings.catalogPagesPerScan));
  const steps: CatalogStep[] = [];
  for (let round = 0; brands.length > 0 && steps.length < wanted; round++) {
    for (const brand of brands.slice(0, wanted - steps.length)) steps.push({ kind: 'catalog', brand, page: pageOf(cursors.get(brand)) + round });
  }
  return steps;
}

/** The page a cursor points at; 1 without a usable cursor. */
const pageOf = (cursor: CatalogCursor | undefined): number =>
  cursor && Number.isInteger(cursor.nextPage) && cursor.nextPage >= 1 ? cursor.nextPage : 1;

/** Amazon's brand filter for a brand (upper case), or null when the settings have none. */
function brandFilter(settings: ScanSettings, brand: string): string | null {
  const rh = Object.hasOwn(settings.brandFilters, brand) ? settings.brandFilters[brand] : undefined;
  return typeof rh === 'string' && rh.trim() !== '' ? rh : null;
}

// ---------------------------------------------------------------- rules 2, 3, 6, 7, 2c rules 2, 3 and 3 rules 1, 2: paid steps

async function runQueue(run: Run): Promise<void> {
  const { job } = run;
  // Step 11: the listing phase is the Home Depot deals pages (and the brands' Amazon pages), the parts phase the lookups.
  const stage: StepId = job.phase === 'listing' ? 'hdPages' : 'amazon';
  const queued = (): number => job.queue.filter((s) => (stage === 'hdPages' ? s.kind === 'listing' || s.kind === 'catalog' : isAmazonStep(s))).length;
  const unitsBefore = job.pipeline?.find((s) => s.id === stage)?.unitsDone ?? 0;
  if (stage === 'amazon' && job.queue.length === 0 && (job.stopReason !== null || job.deferred.length > 0)) skipStep(job, 'amazon', whyNot(job.stopReason));
  // Nothing queued and nothing done before (a continued job keeps what it did): the step had nothing to do.
  else if (job.queue.length === 0 && unitsBefore === 0) skipStep(job, stage, NONE_FOUND);
  else startStep(job, stage, { remaining: queued(), now: run.now() });
  // Saved as the step starts, so the row shows it with its count from the first moment (UI review of P2).
  await run.store.putScan(job);
  while (!run.halted && job.queue.length > 0) {
    const step = job.queue[0]!;
    // 3 rule 1: asked before every paid step, never during one.
    if (run.shouldStop()) {
      await halt(run, 'user', null);
      return;
    }
    // Only the search is inside the try. An error from the store (below, in setAside or in
    // halt) is not caught: the job stays "running" and the next runScan continues it.
    let result: SearchResult;
    const sentAt = run.now();
    try {
      result = await send(run, step);
    } catch (err) {
      if (err instanceof KeepaBudgetExceededError) {
        const sentence = err.message;
        // Step 15: Keepa refused before anything was sent, so nothing was spent and nothing failed. A lookup goes to
        // SerpApi when a search can still pay for it (a route, not a retry); else it waits for Keepa's tokens, as a
        // refresh does. Neither is a failure (Ruling 57 is for requests that were sent and failed).
        if (step.kind === 'lookup') {
          if (step.via !== 'serpapi' && serpCanTake(run)) {
            job.queue[0] = { ...step, via: 'serpapi' };
            continue;
          }
          await waitForKeepa(run, step);
          continue;
        }
        if (step.kind === 'refresh') {
          await waitForKeepa(run, step);
          continue;
        }
        if (step.kind === 'identify') {
          job.queue.shift();
          job.deferred.push(step);
          moveUnits(job, stage, { remaining: queued() });
          if (job.stopMessage === null) job.stopMessage = `Keepa: ${sentence}`;
          else if (!job.stopMessage.includes(sentence)) job.stopMessage = `${job.stopMessage} Keepa: ${sentence}`;
          await run.store.putScan(job);
          continue;
        }
      }
      const stop = stopFor(err);
      if (step.kind === 'catalog' && stop.reason === 'error') {
        // 2c rule 3: a brand page that failed is dropped, not deferred, and the scan goes on.
        // It does not count toward the two failures of 3 rule 2. The cursor keeps its page and
        // passes, so the brand asks for the same page again; only its time moves, so the other
        // brands have their turn first (a brand with no cursor gets one at page 1).
        const old = await run.store.getCursor(step.brand);
        await run.store.putCursor(old ? { ...old, updatedAt: run.now() } : { brand: step.brand, nextPage: 1, passes: 0, updatedAt: run.now() });
        const sentence = `The ${step.brand} Amazon page ${step.page} was skipped: ${stop.message}`;
        job.stopMessage = job.stopMessage === null ? sentence : `${job.stopMessage} ${sentence}`;
        job.queue.shift();
        moveUnits(job, stage, { remaining: queued() });
        await run.store.putScan(job);
        continue;
      }
      // 3 rule 2: a lookup or refresh that failed is set aside, unless the one before it failed too.
      // A product page that cannot be read leaves the accessory question as the lookup wrote it.
      if (step.kind === 'identify' && stop.reason === 'error') {
        await clearPageDue(run, step);
        job.queue.shift();
        moveUnits(job, stage, { remaining: queued() });
        await run.store.putScan(job);
        continue;
      }
      if ((step.kind === 'lookup' || step.kind === 'refresh') && stop.reason === 'error' && !run.lastFailed) {
        await setAside(run, step, stop.message);
        continue;
      }
      await halt(run, stop.reason, stop.message);
      return;
    }
    // 3 rule 2: a step answered, from the network or the cache, resets the count.
    run.lastFailed = false;
    // Rule 3: the store first, then the job.
    const follow = await apply(run, step, result);
    // An identify pull carries the same Keepa product (sales, FBA fee), so it starts the part's trend too.
    if ((step.kind === 'refresh' || step.kind === 'identify') && result.keepaProduct) {
      try {
        const next = partTrendFromProduct(result.keepaProduct, result.at);
        const prev = run.cache ? await readPartTrend(run.cache, step.asin) : undefined;
        if (run.trendWriter) await run.trendWriter(next);
        const delta = step.kind === 'refresh' ? amazonPriceDelta(prev, next) : null;
        if (delta !== null && delta >= 2) {
          (job.partPriceDrops ??= []).push({ partModel: step.model, delta });
        }
      } catch {
        // Trend cache failures must not stop the scan (worker digests and alerts still run).
      }
    }
    if (step.kind === 'lookup') {
      const via = result.billAs === 'keepa' ? 'keepa' : 'serpapi';
      job.lookupsVia = { keepa: job.lookupsVia?.keepa ?? 0, serpapi: job.lookupsVia?.serpapi ?? 0 };
      job.lookupsVia[via] += 1;
      if (via === 'keepa' && follow === null) await schedulePricePull(run, step);
    }
    if (step.kind === 'lookup' && follow) await schedulePageRead(run, step, follow);
    // Ruling 57: a part answered is no longer failing.
    if (step.kind === 'lookup' || step.kind === 'refresh') {
      const answered = partKey(step.brand, step.model);
      keepFailing(job, (k) => k !== answered);
    }
    // searchesUsed counts the paid steps this job saved. A search in flight when the worker
    // was interrupted was paid (the ledger has it) but its step was never saved, so it is
    // not counted; the continued job answers that step from the cache, which is free.
    if (result.source === 'network' && result.billAs !== 'keepa') job.searchesUsed += 1;
    if (result.source === 'network' && result.billAs === 'keepa') {
      job.keepaTokensUsed = (job.keepaTokensUsed ?? 0) + (result.keepaTokens ?? 1);
    }
    job.queue.shift();
    if (result.source === 'cache') topUp(run);
    // Step 11: a cached answer is free and instant, so it counts but is not timed.
    finishUnit(job, stage, { ms: result.source === 'network' ? run.now() - sentAt : null, remaining: queued() });
    await run.store.putScan(job);
  }
  endStep(job, stage, run.now());
  await run.store.putScan(job);
}

/** Step 11: the reason a step with nothing to do gives in the step list. */
const NONE_FOUND = 'none found';

/** Step 11: why a step that did not run did not, in four words or fewer, from the job's stop reason. */
export function whyNot(reason: StopReason | null): string {
  switch (reason) {
    case null: return 'nothing to do';
    case 'user': return 'stopped';
    case 'rate_limited': return 'rate limited';
    case 'no_tokens': return 'no Keepa tokens';
    case 'keepa_tokens': return 'waits for Keepa tokens';
    case 'error': return 'search failed';
    case 'run_cap': return 'search limit';
    case 'reserve': return 'search reserve';
    case 'hourly_limit': return 'hourly search limit';
  }
}

/**
 * Step 15: whether SerpApi can pay for one more lookup now, beside the queued steps that will also be searches: listing
 * and brand pages, lookups routed to SerpApi, and (without Keepa) refreshes and product pages.
 */
function serpCanTake(run: Run): boolean {
  const keepaPulls = Boolean(run.keepaProduct && run.settings.amazonRefreshViaKeepa);
  const keepaSearch = Boolean(run.keepaLookup && run.settings.amazonRefreshViaKeepa);
  const searches = run.job.queue.slice(1).filter((s) => {
    if (s.kind === 'lookup') return s.via === 'serpapi' || (s.via === undefined && !keepaSearch);
    if (s.kind === 'refresh' || s.kind === 'identify') return !keepaPulls;
    return true;
  }).length;
  return run.budget.blockReason(searches + 1) === null;
}

/** Step 15: the step at the head of the queue waits for Keepa's tokens: deferred (the next scan or the drip runs it), not failed. */
async function waitForKeepa(run: Run, step: Lookup | Refresh): Promise<void> {
  const { job } = run;
  job.queue.shift();
  const { via: _via, ...plain } = step as Lookup;
  job.deferred.push(step.kind === 'lookup' ? (plain as Lookup) : step);
  if (step.kind === 'lookup') {
    await markWaiting(run, step);
    job.lookupsBlockedBy = 'keepa_tokens';
  }
  moveUnits(job, 'amazon', { remaining: job.queue.filter(isAmazonStep).length });
  await run.store.putScan(job);
}

/**
 * Step 15: a Keepa search's products carry no price (fixtures/keepa/search-RYOBI-PCL235B.json: no stats, no csv), so
 * the listing a Keepa lookup matched is pulled once more with stats (1 token, KEEPA_PRICE_PULL_TOKENS) right after it,
 * as a refresh: that is what gives the part a price, and its bundle an estimate, in this scan. Part of the lookup's
 * estimate (KEEPA_LOOKUP_TOKEN_ESTIMATE), so the plan already holds the token.
 */
async function schedulePricePull(run: Run, step: Lookup): Promise<void> {
  const match = await run.store.getMatch(partKey(step.brand, step.model));
  if (match?.status !== 'matched' || match.asin === null) return;
  const price = await run.store.getPrice(match.asin);
  if (price && price.price !== null) return;
  run.job.queue.splice(1, 0, { kind: 'refresh', brand: step.brand, model: step.model, asin: match.asin });
}

/**
 * Ruling 48: a step answered from the cache spent nothing, so its planned slot is given back: the
 * next step this run's planning deferred in the same phase moves to the end of the queue. Only
 * when what may still be spent is more than the steps already queued, so every queued step can
 * still be paid for; the guard still decides each search. Not a retry: a step set aside after a
 * failure is never in `movable`, and a step leaves `movable` when it moves. A listing page whose
 * earlier page has not said there is a next one does not move yet, as that page may say it does not
 * exist (final review); it stays movable, so a later top-up in the run takes it once that page is
 * answered (F9 review).
 */
function topUp(run: Run): void {
  const { job } = run;
  if (run.budget.spendable <= job.queue.length) return;
  for (let i = 0; i < run.movable.length; i++) {
    const step = run.movable[i]!;
    const at = job.deferred.indexOf(step);
    if (at < 0) {
      run.movable.splice(i--, 1);
      continue;
    }
    if (waitsForEarlierPage(step, job)) continue;
    run.movable.splice(i, 1);
    job.deferred.splice(at, 1);
    job.queue.push(step);
    return;
  }
}

// ---------------------------------------------------------------- rule 8 and 3 rules 1, 2: stopping

/** What a search error means for the scan. Only an "error" may drop or set aside a step (2c rule 3, 3 rule 2). */
type Stop = { reason: 'error'; message: string } | { reason: Exclude<StopReason, 'error' | 'user'>; message: string | null };

function stopFor(err: unknown): Stop {
  if (err instanceof KeepaBudgetExceededError) return { reason: err.reason, message: err.message };
  if (err instanceof BudgetExceededError) return { reason: err.reason, message: null };
  // RateLimitedError extends SerpApiError, so it is checked before the general case.
  if (err instanceof RateLimitedError) return { reason: 'rate_limited', message: err.message };
  // Any other SerpApiError, or anything else the search threw (a body that is not JSON).
  // SerpApi may already have counted that search, so the job must not stay "running":
  // a continued run would send the same request again.
  return { reason: 'error', message: (err instanceof Error && err.message) || String(err) };
}

/**
 * 3 rule 2: the failed step is deferred after the steps set aside before it in this run, in
 * front of anything the budget deferred; a lookup's part waits. The job's stopMessage keeps
 * the first failure's message (after a skipped brand page's sentence, if there is one). The
 * stop reason is not touched, and the scan goes on with the next step.
 */
async function setAside(run: Run, step: Lookup | Refresh, message: string): Promise<void> {
  const { job } = run;
  if (step.kind === 'lookup') await markWaiting(run, step);
  // Ruling 50: remembered, so the next job plans this part after the others.
  const key = partKey(step.brand, step.model);
  if (!(job.setAsideParts ?? []).includes(key)) job.setAsideParts = [...(job.setAsideParts ?? []), key];
  // Ruling 57: now the most recent failure, so it goes last among the failing parts.
  job.failingParts = [...(job.failingParts ?? []).filter((k) => k !== key), key];
  // Ruling 49: the sentence names what failed, so it reads true beside the other sentences here.
  const sentence = `${step.kind === 'lookup' ? 'The lookup' : 'The price check'} of ${step.model} failed: ${message}`;
  if (run.setAside === 0) job.stopMessage = job.stopMessage === null ? sentence : `${job.stopMessage} ${sentence}`;
  job.queue.shift();
  moveUnits(job, 'amazon', { remaining: job.queue.filter(isAmazonStep).length });
  job.deferred.splice(run.setAside, 0, step);
  run.setAside += 1;
  run.lastFailed = true;
  await run.store.putScan(job);
}

/** The step at the head of the queue and the rest of the queue are deferred; no further search in this run. */
async function halt(run: Run, reason: StopReason, message: string | null): Promise<void> {
  const { job } = run;
  for (const step of job.queue) if (step.kind === 'lookup') await markWaiting(run, step);
  // Ruling 52: a listing page whose own search failed is remembered, so the next job plans it after
  // the other pages. A 429, a budget refusal or Stop says nothing about the page: it keeps its place.
  // (A brand page that fails is dropped instead, 2c rule 3, so it never stops here with an error.)
  const head = job.queue[0];
  if (reason === 'error' && head?.kind === 'listing' && !(job.failedPages ?? []).includes(pageKey(head))) {
    job.failedPages = [...(job.failedPages ?? []), pageKey(head)];
  }
  // F9 review: a page whose search failed is unanswered until it answers again.
  if (reason === 'error' && head?.kind === 'listing') setAnswered(job, head, false);
  job.stopReason = reason;
  job.stopMessage = message;
  // After the steps this run set aside (3 rule 2), in front of anything deferred earlier.
  job.deferred.splice(run.setAside, 0, ...job.queue);
  job.queue = [];
  run.halted = true;
  await run.store.putScan(job);
}

function send(run: Run, step: ScanStep): Promise<SearchResult> {
  const { settings, prefix, job } = run;
  switch (step.kind) {
    case 'catalog': {
      const rh = brandFilter(settings, step.brand);
      // The settings lost the filter since the job was planned: without it the search would be
      // a different one. Thrown before searching, so nothing is spent (2c rule 3 drops the step).
      if (rh === null) throw new Error(`No Amazon brand filter is set for ${step.brand}.`);
      return run.client.search(
        // Page 1 goes without a page parameter, the request Amazon's own first page answers.
        { engine: 'amazon', k: step.brand, rh, amazon_domain: settings.amazonDomain, page: step.page === 1 ? undefined : step.page },
        // Always reuse a page fetched earlier in the same job, as a listing page is.
        { label: `${prefix}:catalog:${step.brand}:p${step.page}`, maxAgeMs: Math.max(settings.freshnessMs, run.now() - job.startedAt) },
      );
    }
    case 'listing':
      return run.client.search(
        { engine: 'home_depot', q: step.q, page: step.page, hd_filter_tokens: step.filterTokens ?? undefined },
        // Always reuse a page fetched earlier in the same job.
        { label: `${prefix}:listing:${step.q}:p${step.page}`, maxAgeMs: Math.max(settings.listingMaxAgeMs, run.now() - job.startedAt) },
      );
    case 'lookup':
      // Step 15: the plan's route; a step saved before step 15 has none and goes to Keepa when it can, as before.
      if (run.keepaLookup && run.settings.amazonRefreshViaKeepa && step.via !== 'serpapi') {
        const block = run.keepaBudget?.blockReason(KEEPA_LOOKUP_TOKEN_ESTIMATE);
        if (block) throw new KeepaBudgetExceededError(block);
        return run.keepaLookup(step.brand, step.model, `${prefix}:lookup:${step.model}`);
      }
      return sendLookup(run, step);
    case 'identify':
      if (run.keepaProduct && settings.amazonRefreshViaKeepa) {
        const block = run.keepaBudget?.blockReason(productTokenEstimate(settings.keepaTrackingDepth, 1));
        if (block) throw new KeepaBudgetExceededError(block);
        return run.keepaProduct(step.asin, `${prefix}:identify:${step.model}`);
      }
      return run.client.search(
        { engine: 'amazon_product', asin: step.asin, amazon_domain: settings.amazonDomain },
        { label: `${prefix}:identify:${step.model}` },
      );
    case 'refresh':
      if (run.keepaProduct && settings.amazonRefreshViaKeepa) {
        const block = run.keepaBudget?.blockReason(productTokenEstimate(settings.keepaTrackingDepth, 1));
        if (block) throw new KeepaBudgetExceededError(block);
        return run.keepaProduct(step.asin, `${prefix}:refresh:${step.model}`, settings.freshnessMs);
      }
      return run.client.search(amazonPart(run, step), { label: `${prefix}:refresh:${step.model}`, maxAgeMs: settings.freshnessMs });
    default:
      return unknownStep(step);
  }
}

/** Rule 6: the lookup step's search. No maxAgeMs on a lookup: a part is paid for once. */
export function sendLookup(ctx: PartContext, step: LookupStep): Promise<SearchResult> {
  return ctx.client.search(amazonPart(ctx, step), { label: `${ctx.prefix}:lookup:${step.model}` });
}

const amazonPart = (ctx: PartContext, step: Lookup | Refresh) => ({
  engine: 'amazon', k: `${step.brand} ${step.model}`, amazon_domain: ctx.settings.amazonDomain,
});

/** Rule 3 and 2c rule 2: what a step's response changes in the store. */
/**
 * Every time read from a response (a listing's or price's seenAt and checkedAt, a bundle's or
 * catalog entry's seenAt) is `at`, when SerpApi answered, which for a cached answer may be days
 * ago; a stored record is never replaced by an older response. Match records, review items,
 * cursors and the job use the clock: they record when the tool decided something.
 */
async function apply(run: Run, step: ScanStep, result: SearchResult): Promise<string | null> {
  const { data, at } = result;
  switch (step.kind) {
    case 'catalog':
      await applyCatalog(run, step, data, at);
      return null;
    case 'listing':
      await applyListing(run, step, data, at);
      return null;
    case 'lookup':
      return applyLookup(run, step, data, at);
    case 'identify':
      await applyIdentify(run, step, data, at);
      return null;
    case 'refresh':
      await applyRefresh(run, step, data, at);
      return null;
    default:
      return unknownStep(step);
  }
}

/** Every step kind is handled above: a new kind does not compile until it is. */
function unknownStep(step: never): never {
  throw new Error(`Unknown scan step: ${JSON.stringify(step)}`);
}

/** 2c rule 2: save every row of a brand page, then move the brand's cursor on from this page. */
async function applyCatalog(run: Run, step: CatalogStep, data: unknown, at: number): Promise<void> {
  const { store, job } = run;
  const now = run.now();
  await saveListings(run, parseAmazonSearch(data), at);
  // The new cursor comes from the step's own page, not from the stored cursor, so a step
  // repeated from the cache after an interruption leaves the cursor where the first apply put
  // it. For the same reason a pass is counted only while the cursor still points at this page.
  const old = await store.getCursor(step.brand);
  const passes = old?.passes ?? 0;
  if (amazonHasNextPage(data)) {
    await store.putCursor({ brand: step.brand, nextPage: step.page + 1, passes, updatedAt: now });
  } else {
    await store.putCursor({ brand: step.brand, nextPage: 1, passes: pageOf(old) === step.page ? passes + 1 : passes, updatedAt: now });
    // The brand has no later page: later pages queued for it are dropped, not deferred.
    job.queue = job.queue.filter((s) => !(s.kind === 'catalog' && s.brand === step.brand && s.page > step.page));
  }
  job.counts.catalogPages += 1;
}

/** Records whether `page`'s last answer said there is a next page (`ScanJob.answeredPages`); the field is absent when empty. */
function setAnswered(job: ScanJob, page: Listing, hasNext: boolean): void {
  const left = (job.answeredPages ?? []).filter((k) => k !== pageKey(page));
  if (hasNext) left.push(pageKey(page));
  if (left.length > 0) job.answeredPages = left;
  else delete job.answeredPages;
}

async function applyListing(run: Run, step: Listing, data: unknown, at: number): Promise<void> {
  const { store, job } = run;
  const brands = new Set(run.settings.brands.map((b) => b.trim().toUpperCase()));
  const { listings, hasNextPage } = parseHomeDepotSearch(data);
  for (const row of listings) {
    const brand = row.brand?.trim().toUpperCase();
    if (!brand || !brands.has(brand) || row.model === null) continue;
    job.counts.productsSeen += 1;
    // A search row carries no barcode: one already stored is kept, never replaced by null.
    if (step.bundlesOnly || looksLikeBundle(brand, row.model)) {
      const key = bundleKey(row.itemId);
      const known = await store.getBundle(key);
      // A record seen later than this response is kept as it is.
      if (!known || known.seenAt <= at) {
        await store.putBundle({
          key, retailer: 'homedepot', itemId: row.itemId, title: row.title, brand, model: row.model, upc: known?.upc ?? null,
          price: row.price, regularPrice: row.regularPrice, percentOff: row.percentOff, link: row.link, seenAt: at,
          split: known?.split ?? null,
          // A page is read once (P1): a row seen again keeps it.
          ...(known && known.page !== undefined ? { page: known.page } : {}),
        });
      }
      job.counts.bundlesSeen += 1;
    } else {
      const entry = catalogEntry(brand, row.model, row.title);
      const key = partKey(entry.brand, entry.model);
      const known = await store.getCatalogEntry(key);
      if (!known || known.seenAt <= at) {
        await store.putCatalogEntry({
          key, brand: entry.brand, model: entry.model, title: row.title,
          kinds: entry.kinds, isKit: entry.isKit ?? false, upc: known?.upc ?? null, seenAt: at,
          // Step 6: the row's own item id, by which a kit's page is read (readKitPages).
          itemId: row.itemId,
          // A kit's page is read once, as a bundle's (P1): a row seen again keeps it.
          ...(known && known.page !== undefined ? { page: known.page } : {}),
        });
      }
    }
  }
  // F9 review: remembered, so the next page may be planned before this one on a later scan.
  setAnswered(job, step, hasNextPage);
  if (!hasNextPage) {
    // Later pages of this query do not exist: dropped, not deferred.
    const later = (s: ScanStep) => s.kind === 'listing' && s.q === step.q && s.filterTokens === step.filterTokens && s.page > step.page;
    job.queue = job.queue.filter((s) => !later(s));
    // Nor are they moved into the queue, or put first by the next job (Ruling 48). Only listing
    // steps leave `deferred`, and the listing phase sets nothing aside, so run.setAside still
    // counts the steps at its front.
    run.movable = run.movable.filter((s) => !later(s));
    job.deferred = job.deferred.filter((s) => !later(s));
  }
  job.counts.pagesFetched += 1;
}

/** Rule 6: what a lookup's response changes in the store. */
export async function applyLookup(ctx: PartContext, step: LookupStep, data: unknown, at: number): Promise<string | null> {
  const { store, job } = ctx;
  const now = ctx.now();
  const key = partKey(step.brand, step.model);
  job.counts.lookupsDone += 1;
  const candidates = parseAmazonSearch(data);
  await saveListings(ctx, candidates, at);
  // A saved queue can outlive the plan: the user may have decided this part since, or (fix round 3) a
  // Verify sent it to review from the listing's page, which a search pick must not undo.
  const existing = await store.getMatch(key);
  if (existing?.decidedBy === 'user' || (await pageEvidence(store, existing)).page) return null;
  const picked = pick(wantedFor(step.brand, step.model, ctx.catalog), candidates);
  const base = { key, brand: step.brand, model: step.model, decidedBy: 'auto' as const, updatedAt: now, waitingSince: null };
  let match: MatchRecord;
  if (picked.chosen) {
    const asin = picked.chosen.asin;
    const alternatives = unique(picked.alternatives.map((g) => g.asin)).filter((a) => a !== asin);
    match = { ...base, status: 'matched', asin, grade: picked.chosen.grade, alternatives };
    for (const a of [asin, ...alternatives]) await savePrice(ctx, a, firstWith(candidates, a), at);
    job.counts.partsMatched += 1;
  } else if (picked.review.length > 0) {
    match = { ...base, status: 'review', asin: null, grade: null, alternatives: [] };
    const { reason, listed } = matchQuestion(picked.review, candidates, at);
    await openMatchReview(ctx, { key, brand: step.brand, model: step.model }, reason, listed, now);
  } else {
    match = { ...base, status: 'none', asin: null, grade: null, alternatives: [] };
  }
  await store.putMatch(match);
  if (picked.chosen) return null;
  return toolPageToRead(wantedFor(step.brand, step.model, ctx.catalog), candidates);
}

/**
 * One product page for a same-brand row the lookup could not name. Exact or strong (the page's part
 * number or barcode is the model): that listing is the match and the accessory question is closed.
 * Any other page leaves the lookup's question as it is. Either way a page that could be read is not
 * owed again.
 */
export async function applyIdentify(ctx: PartContext, step: IdentifyStep, data: unknown, at: number): Promise<void> {
  const page = parseAmazonProduct(data, step.asin);
  // A page that came back but cannot be read is not owed again: the next scan would pay for the same body.
  if (page === null || page.asin !== step.asin) {
    await clearPageDue(ctx, step);
    return;
  }
  await savePrice(ctx, step.asin, page, at);
  const key = partKey(step.brand, step.model);
  const existing = await ctx.store.getMatch(key);
  if (!existing) return;
  if (existing.pageDue !== undefined) {
    const { pageDue: _owed, ...rest } = existing;
    await ctx.store.putMatch(rest);
  }
  const current = (await ctx.store.getMatch(key))!;
  if (current.decidedBy === 'user') return;
  if ((await pageEvidence(ctx.store, current)).page && current.status !== 'waiting') return;
  const chosen = pick(wantedFor(step.brand, step.model, ctx.catalog), [page]).chosen;
  if (!chosen || (chosen.grade !== 'exact' && chosen.grade !== 'strong')) return;
  const now = ctx.now();
  const match: MatchRecord = {
    ...current, status: 'matched', asin: page.asin, grade: chosen.grade, alternatives: [],
    decidedBy: 'auto', updatedAt: now, waitingSince: null, source: 'page',
  };
  await ctx.store.putMatch(match);
  await writeTwins(ctx.store, match, (twin) => twin.decidedBy === 'auto');
  await closeQuestion(ctx, key);
  for (const twin of twinKeys(step.brand, step.model)) await closeQuestion(ctx, twin);
  ctx.job.counts.partsMatched += 1;
}

/** The page read is still owed: the next scan plans it, and this one does not repeat the search. */
export async function notePageDue(ctx: Pick<PartContext, 'store'>, step: LookupStep, asin: string): Promise<void> {
  const match = await ctx.store.getMatch(partKey(step.brand, step.model));
  if (!match || match.decidedBy === 'user' || match.status === 'matched') return;
  await ctx.store.putMatch({ ...match, pageDue: asin });
}

async function clearPageDue(ctx: Pick<PartContext, 'store'>, step: IdentifyStep): Promise<void> {
  const match = await ctx.store.getMatch(partKey(step.brand, step.model));
  if (!match?.pageDue) return;
  const { pageDue: _owed, ...rest } = match;
  await ctx.store.putMatch(rest);
}

/**
 * Read the page in this run when one more search fits beside the steps still queued, or by giving
 * it the slot of the last lookup or refresh not yet started. Otherwise it is owed to the next scan.
 * The page read never spends a search the cap does not allow.
 */
async function schedulePageRead(run: Run, step: LookupStep, asin: string): Promise<void> {
  const { job } = run;
  const identify: IdentifyStep = { kind: 'identify', brand: step.brand, model: step.model, asin };
  const rest = job.queue.length - 1;
  if (run.budget.blockReason(rest + 1) === null) {
    await notePageDue(run, step, asin);
    job.queue.splice(1, 0, identify);
    return;
  }
  let stealAt = -1;
  for (let i = job.queue.length - 1; i > 0; i--) {
    const kind = job.queue[i]!.kind;
    if (kind === 'lookup' || kind === 'refresh') { stealAt = i; break; }
  }
  if (stealAt > 0) {
    const [stolen] = job.queue.splice(stealAt, 1);
    if (stolen) {
      job.deferred.push(stolen);
      if (stolen.kind === 'lookup') await markWaiting(run, stolen);
    }
    await notePageDue(run, step, asin);
    job.queue.splice(1, 0, identify);
    return;
  }
  await notePageDue(run, step, asin);
}

/** Ruling 71: a match question offers at most this many listings. */
export const MATCH_CHOICES = 5;

/** Ruling 71: the note when a listing the question offers says "Replacement" or "OEM" (maySparePart). */
export const SPARE_PART_NOTE = 'title says Replacement or OEM, which often marks a spare part';

const GRADE_RANK: Record<Grade, number> = { exact: 0, strong: 1, probable: 2, review: 3, reject: 4 };

/**
 * Ruling 71: the listings a lookup's match question offers, and its reason. One candidate per ASIN (a
 * search can list the same ASIN twice), best first: grade, then most reviews, then a price shown; then
 * as the response listed them. At most MATCH_CHOICES are kept. The reason's notes, joined by "; ":
 * how many of all the listings show the model with the brand not confirmed; each step 8b reason a listing
 * kept is review rather than rejected (isReviewCap); SPARE_PART_NOTE when a listing kept says
 * "Replacement" or "OEM"; and how many were left out.
 */
export function matchQuestion(review: Graded[], candidates: Candidate[], at: number): { reason: string; listed: ReviewCandidate[] } {
  const all = unique(review.map((g) => g.asin)).map((asin) => {
    const c = firstWith(candidates, asin)!;
    const g = review.find((x) => x.asin === asin)!;
    return { grade: g.grade, candidate: { asin, title: c.title, price: c.price ?? null, reviews: c.reviews ?? null, reasons: g.reasons, seenAt: at } };
  });
  // Array.prototype.sort is stable: ties keep the response's order.
  all.sort((a, b) =>
    GRADE_RANK[a.grade] - GRADE_RANK[b.grade]
    || (b.candidate.reviews ?? 0) - (a.candidate.reviews ?? 0)
    || Number(a.candidate.price === null) - Number(b.candidate.price === null));
  const listed = all.slice(0, MATCH_CHOICES).map((x) => x.candidate);
  const notes: string[] = [];
  const unconfirmed = all.filter((x) => x.candidate.reasons.includes(BRAND_NOT_CONFIRMED)).length;
  if (unconfirmed > 0) notes.push(`${unconfirmed} listing(s) show the model number, but the brand is not confirmed`);
  // Step 8b: why a listing shown is review rather than rejected (isReviewCap), once each.
  for (const cap of unique(listed.flatMap((c) => c.reasons.filter(isReviewCap)))) notes.push(cap);
  if (listed.some((c) => maySparePart(c.title))) notes.push(SPARE_PART_NOTE);
  if (all.length > listed.length) notes.push(`${all.length - listed.length} more listing(s) not shown`);
  return { reason: notes.join('; '), listed };
}

/**
 * The match question for a part, opened at `now` and counted, unless the part already has one
 * (open or answered by the owner), which is left as it is. One a scan closed is replaced. Its title is
 * the catalog's.
 */
export async function openMatchReview(ctx: PartContext, part: Part, reason: string, candidates: ReviewCandidate[], now: number): Promise<void> {
  const { store, job } = ctx;
  const id = `match:${part.key}`;
  // A question a scan closed (Ruling 73) is asked again, as a split question is.
  const old = await store.getReview(id);
  if (old && old.answer !== RESOLVED_BY_SCAN) return;
  await store.putReview({
    id, kind: 'match', subject: part.key, brand: part.brand, model: part.model, title: (await store.getCatalogEntry(part.key))?.title ?? null,
    reason, candidates, choices: [], openedAt: now, answer: null, answeredAt: null,
  });
  job.counts.reviewsOpened += 1;
}

export async function applyRefresh(run: PartContext, step: Refresh, data: unknown, at: number): Promise<void> {
  const product = parseAmazonProduct(data, step.asin);
  if (product) {
    await savePrice(run, step.asin, product, at);
    run.job.counts.refreshesDone += 1;
    return;
  }
  const candidates = parseAmazonSearch(data);
  await saveListings(run, candidates, at);
  // A listing missing from the results keeps its old price; the check is still recorded,
  // so the part is not paid for again until it is stale once more.
  await savePrice(run, step.asin, firstWith(candidates, step.asin), at);
  run.job.counts.refreshesDone += 1;
}

/**
 * Rules 6 and 7: every row of an Amazon response whose brand is scanned is saved as a listing,
 * as seen at `at`, when SerpApi answered. A listing checked later than that is kept as it is,
 * so an old response never makes an old price look fresh. Every such row is counted.
 */
async function saveListings(ctx: PartContext, candidates: Candidate[], at: number): Promise<void> {
  const { store, settings, job } = ctx;
  for (const c of candidates) {
    const old = await store.getListing(c.asin);
    const record = listingFrom(c, settings.brands, at, old);
    if (record === null) continue;
    if (!old || old.checkedAt <= at) await store.putListing(record);
    // A row seen in two responses is counted twice; the store holds one record per ASIN.
    job.counts.listingsSaved += 1;
  }
}

/** Saves the price an ASIN has in a response received at `at`, unless the stored one was checked later. */
export async function savePrice(ctx: Pick<PartContext, 'store'>, asin: string, cand: Candidate | undefined, at: number): Promise<void> {
  const old = await ctx.store.getPrice(asin);
  if (old && old.checkedAt > at) return;
  await ctx.store.putPrice(priceSeen(asin, old, cand, at));
}

/** A price record after a response received at `at` was read: `cand` is the ASIN's row in it, if it was there. */
function priceSeen(asin: string, old: PriceRecord | undefined, cand: Candidate | undefined, at: number): PriceRecord {
  if (!cand) return { asin, price: old?.price ?? null, reviews: old?.reviews ?? null, seenAt: old?.seenAt ?? null, checkedAt: at };
  const price = cand.price ?? null;
  return { asin, price, reviews: cand.reviews ?? null, seenAt: price === null ? (old?.seenAt ?? null) : at, checkedAt: at };
}

const firstWith = (candidates: Candidate[], asin: string): Candidate | undefined => candidates.find((c) => c.asin === asin);
const unique = (xs: string[]): string[] => [...new Set(xs)];

// ---------------------------------------------------------------- P1 to P4: the bundles' own pages, then the kits' (free)

/** What is left of pageReadsPerScan in this job: bundle pages and kit pages read count alike. */
const pagesLeft = (run: Run): number => Math.max(0, Math.floor(run.settings.pageReadsPerScan) - run.job.counts.pagesRead);

/** A page to read, and where its reading is saved. */
interface PageTarget {
  itemId: string;
  save: (page: PageReading) => Promise<void>;
}

/**
 * How a pass of page reading went. goOn: false when Home Depot refused a page or the reader threw.
 * notRead: the pages it asked for that were not read (unreadable, refused, skipped or unanswered).
 */
interface PassResult {
  goOn: boolean;
  notRead: number;
  /** Step 11: when goOn is false, why the later reads were skipped, in four words or fewer. */
  why?: string;
}

/**
 * P1: bundles with no page yet, newest seenAt first then key, in one call to readPages. The
 * limit is per job: a job continued after its readings were saved reads only what is left of
 * pageReadsPerScan. P2: each page read is saved on its bundle. P3: a refusal, a page that could
 * not be read, or a reader that threw is noted in stopMessage; none of them stops the scan.
 * P4: the bundles are saved, then the job, once, before the split. goOn is false when Home Depot
 * refused a page or the reader threw: then no kit page is read this run (step 6).
 */
async function readBundlePages(run: Run): Promise<PassResult> {
  const { store } = run;
  if (!run.readPages) return { goOn: true, notRead: 0 };
  const unread = (await store.listBundles())
    .filter((b) => b.page === undefined || b.page === null)
    .sort(newestFirst)
    .slice(0, pagesLeft(run));
  if (run.shouldStop()) return { goOn: true, notRead: 0 };
  if (unread.length === 0) return nothingToRead(run, 'bundlePages');
  return readInto(run, 'bundlePages', unread.map((b) => ({ itemId: b.itemId, save: (page) => store.putBundle({ ...b, page }) })));
}

/**
 * Step 6 (Ruling 67): the pages of the plain kits that resolved splits hold, after the bundle pages
 * and from what they left of pageReadsPerScan, read and saved as P1 to P4 read a bundle's. What they
 * left counts the bundle pages asked for (`bundleNotRead` of them not read), so one run never asks
 * Home Depot for more than pageReadsPerScan pages. The reader itself pauses before this second call. A kit is
 * read only when it is a catalog entry marked a kit, with a Home Depot item id from its listing row
 * (an entry saved before step 6 has none, and waits for a row to show it again), no page yet, no
 * stored page under another record of the same kit, and no bundle record of its own (the bundle
 * phase reads that one). Kits go by the bundles that hold them, newest seenAt first then key, as
 * bundle pages do, in each bundle's part order; each kit once, by one item id: of the records
 * sameModel groups as one kit (PCL1600K2 and PCL1600K2B), the first in key order that can be read.
 * Never a search.
 */
async function readKitPages(run: Run, bundleNotRead: number): Promise<PassResult> {
  const { store } = run;
  const none = { goOn: true, notRead: 0 };
  if (!run.readPages) return none;
  const room = Math.max(0, pagesLeft(run) - bundleNotRead);
  if (run.shouldStop()) return none;
  if (room === 0) return nothingToRead(run, 'kitPages', 'page limit reached');
  const bundles = await store.listBundles();
  const catalog = await store.listCatalog();
  const bundlesOf = kitIndex(bundles);
  const kitsOf = kitIndex(catalog.filter((c) => c.isKit === true));
  const allOf = kitIndex(kitRecords(bundles, catalog));
  const wanted: CatalogRecord[] = [];
  // kitKey of every kit already judged, and every item id already asked for.
  const judged = new Set<string>();
  const asked = new Set<string>();
  for (const b of [...bundles].sort(newestFirst)) {
    // Step 15: a split that waits for a kit's own page (scan/settle.ts rule 2) asks for it as a resolved split's kit is,
    // in a run that waits for pages (the agent's); elsewhere such a split is a question, as before.
    for (const part of [...resolvedParts(b), ...(run.waitForPages ? waitingParts(b) : [])]) {
      const kitId = kitKey(part.brand, part.model);
      if (judged.has(kitId)) continue;
      judged.add(kitId);
      if (bundlesOf(part.brand, part.model).length > 0 || kitPageStored(allOf(part.brand, part.model), part.brand, part.model)) continue;
      // The same pick as the panel's Read kit page (kitPageTarget): first in stored order, digit id, not yet asked.
      const kit = pickUnread(kitsOf(part.brand, part.model), asked);
      if (!kit) continue;
      asked.add(kit.itemId!);
      wanted.push(kit);
    }
  }
  if (wanted.length === 0) return nothingToRead(run, 'kitPages');
  return readInto(run, 'kitPages', wanted.slice(0, room).map((k) => ({ itemId: k.itemId!, save: (page) => store.putCatalogEntry({ ...k, page }) })));
}

// ---------------------------------------------------------------- step 9: Home Depot's prices for the parts (free)

/**
 * Step 9: the parts whose Home Depot price (sold alone) a scan reads now: every part bundleParts plans
 * for (kit items included) whose part price record, or a twin's (Ruling 70), was not checked within
 * freshnessMs. A reading that found nothing is a check, so a part Home Depot does not sell alone is not
 * asked for on every scan; a part never read (not_read) has no check and is asked for again. Largest
 * saving first, then key; a RYOBI part written two ways once.
 */
export async function partPricesWanted(store: ScanStore, settings: ScanSettings, now: number, waiting = false): Promise<Part[]> {
  const parts: { key: string; brand: string; model: string; saving: number }[] = [...(await bundleParts(store)).values()];
  // Step 15: with `waiting` (a run that waits for pages, the agent's), the parts a waiting split needs Home Depot's reading
  // of (scan/settle.ts rule 2), with their bundle's saving.
  const planned = new Set(parts.map((p) => p.key));
  // Step 15: the parts a waiting split needs are read first, as each one read can settle a split and unblock estimates.
  const unblocks = new Set<string>();
  for (const b of waiting ? await store.listBundles() : []) {
    const saving = (b.regularPrice ?? b.price ?? 0) - (b.price ?? 0);
    for (const p of waitingParts(b)) {
      unblocks.add(p.key);
      if (planned.has(p.key)) continue;
      planned.add(p.key);
      parts.push({ ...p, saving });
    }
  }
  const checkedAt = new Map((await store.listPartPrices()).map((r) => [r.key, r.checkedAt] as const));
  const fresh = (p: Part): boolean => [p.key, ...twinKeys(p.brand, p.model)].some((k) => {
    const at = checkedAt.get(k);
    return at !== undefined && now - at <= settings.freshnessMs;
  });
  const seen = new Set<string>();
  return parts
    .filter((p) => !fresh(p))
    .sort((a, b) => Number(unblocks.has(b.key)) - Number(unblocks.has(a.key)) || b.saving - a.saving || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((p) => once(seen, kitKey(p.brand, p.model)))
    .map(({ key, brand, model }) => ({ key, brand, model }));
}

/** A Home Depot link the panel may open: http or https only. Stored data and the reader's answer are untrusted. */
const webLink = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v.trim()) ? v.trim() : null);

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * Step 9: each reading of a part asked for is saved in the part price store, never on a catalog entry (a
 * price is not a fact the splitter may read), at `readAt` (the clock: the owner's browser read it now).
 * - found: saved whole, when its price is a positive number and its page's model is the part's or its
 *   twin's (sameModel); a found reading short of either says nothing and is not saved.
 * - not_found: a check with no price and no link. It never replaces a price read before: that price is kept
 *   with its own time (seenAt) and only checkedAt moves.
 * - not_read, a reading with no known status, one for a part not asked for, a second one for the same part,
 *   or something that is not a reading: ignored. The part's record, if any, is left as it was, and the part
 *   is asked for again next scan.
 * An item id that is not digits is none. Returns how many readings were saved.
 */
export async function savePartPrices(store: ScanStore, asked: Pick<Part, 'brand' | 'model'>[], readings: unknown, readAt: number): Promise<number> {
  const want = new Map(asked.map((p) => [partKey(p.brand, p.model), p] as const));
  let saved = 0;
  for (const r of Array.isArray(readings) ? readings : []) {
    if (typeof r !== 'object' || r === null || typeof r.brand !== 'string' || typeof r.model !== 'string') continue;
    if (r.status !== 'found' && r.status !== 'not_found') continue;
    const key = partKey(r.brand, r.model);
    const part = want.get(key);
    if (!part) continue;
    const brand = part.brand.trim().toUpperCase();
    const model = part.model.trim().toUpperCase();
    let record: PartPriceRecord;
    if (r.status === 'found') {
      const price = typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0 ? r.price : null;
      const matchedModel = textOrNull(r.matchedModel)?.toUpperCase() ?? null;
      if (price === null || matchedModel === null || !sameModel(brand, matchedModel, model)) continue;
      const itemId = typeof r.itemId === 'string' && HOME_DEPOT_ITEM_ID.test(r.itemId) ? r.itemId : null;
      record = { key, brand, model, itemId, matchedModel, price, title: textOrNull(r.title), link: webLink(r.link), seenAt: readAt, checkedAt: readAt };
    } else {
      const before = await store.getPartPrice(key);
      record = before && before.price !== null
        ? { ...before, checkedAt: Math.max(before.checkedAt, readAt) }
        : { key, brand, model, itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: readAt };
    }
    want.delete(key);
    await store.putPartPrice(record);
    saved += 1;
  }
  return saved;
}

/**
 * Step 15, decision 3: how long one scan reads Home Depot's part prices at most. A setting-free constant: the reads are
 * free but slow (the real Nov 23 scan spent 9 of its 13.5 minutes reading 40 of them, about 13 s each, before the
 * lookups that make the estimates), so a scan stops reading after 4 minutes and the next scan, or the agent between
 * scans, carries on from the parts not read (partPricesWanted asks again for every part not checked).
 */
export const PART_PRICE_MS = 4 * 60_000;

/** Step 15: parts asked of the reader per call, so the step counts each part as it is read and the time limit holds. */
export const PART_PRICE_BATCH = 1;

export interface PartPriceRun {
  store: ScanStore;
  settings: ScanSettings;
  readPartPrices: ReadPartPrices;
  now: () => number;
  shouldStop: () => boolean;
  /** Most parts read in all. Default the settings' partPriceReadsPerScan, never above PART_PRICE_READS_MAX. */
  cap?: number;
  /** Most time spent, in ms. Default PART_PRICE_MS. */
  maxMs?: number;
  /** Step 15 (P2): also the parts a waiting split needs Home Depot's reading of (partPricesWanted's `waiting`). */
  waiting?: boolean;
  /** Called with the parts asked for, before the first read; then after each batch with the readings saved so far. */
  onStart?: (asked: number) => void | Promise<void>;
  onBatch?: (saved: number, processed: number, ms: number) => void | Promise<void>;
}

/**
 * Step 9 and step 15: Home Depot's own price for each part partPricesWanted names, PART_PRICE_BATCH at a time, until
 * the parts, the cap or the time limit run out, a stop is asked for, or the reader says it could not read (a part comes
 * back not_read: Home Depot refused, or Chrome went away; nothing more is asked). Each reading is saved
 * (savePartPrices). Never a search. Throws what the reader throws, after saving what came before.
 */
export async function readPartPricesFor(r: PartPriceRun): Promise<{ asked: number; saved: number; stopped: 'time' | 'refused' | 'stop' | null }> {
  const cap = Math.min(PART_PRICE_READS_MAX, Math.max(0, Math.floor(r.cap ?? r.settings.partPriceReadsPerScan)));
  const asked = (await partPricesWanted(r.store, r.settings, r.now(), r.waiting ?? false)).slice(0, cap);
  if (asked.length === 0) return { asked: 0, saved: 0, stopped: null };
  await r.onStart?.(asked.length);
  const began = r.now();
  const maxMs = r.maxMs ?? PART_PRICE_MS;
  let saved = 0;
  for (let i = 0; i < asked.length; i += PART_PRICE_BATCH) {
    if (r.shouldStop()) return { asked: asked.length, saved, stopped: 'stop' };
    if (r.now() - began >= maxMs) return { asked: asked.length, saved, stopped: 'time' };
    const batch = asked.slice(i, i + PART_PRICE_BATCH);
    const at = r.now();
    const readings = await r.readPartPrices(batch.map(({ brand, model }) => ({ brand, model })));
    saved += await savePartPrices(r.store, batch, readings, r.now());
    await r.onBatch?.(saved, i + batch.length, r.now() - at);
    const refused = Array.isArray(readings) && readings.some((x) => typeof x === 'object' && x !== null && (x as { status?: unknown }).status === 'not_read');
    if (refused) return { asked: asked.length, saved, stopped: 'refused' };
  }
  return { asked: asked.length, saved, stopped: null };
}

/**
 * Step 9: the part-price step of a scan (readPartPricesFor), counted (counts.partPricesRead) and shown part by part.
 * Never a search, and never stops the scan: a reader that throws fails the step, its sentence in stopMessage, and the
 * scan goes on. Not run after Home Depot refused a page in this run (the caller), nor once a stop was asked for.
 */
async function readPartPricesPass(run: Run): Promise<void> {
  const { store, job } = run;
  if (!run.readPartPrices || run.shouldStop()) return;
  const before = job.pipeline?.find((p) => p.id === 'partPrices')?.unitsDone ?? 0;
  let started = false;
  let counted = 0;
  try {
    const out = await readPartPricesFor({
      store, settings: run.settings, readPartPrices: run.readPartPrices, now: run.now, shouldStop: run.shouldStop, waiting: run.waitForPages,
      onStart: async (asked) => {
        started = true;
        // Step 11: saved before the reader is called, so the row shows "0 of N" while the first part is read.
        startStep(job, 'partPrices', { remaining: asked, now: run.now() });
        await store.putScan(job);
      },
      onBatch: async (saved, processed, ms) => {
        job.counts.partPricesRead = (job.counts.partPricesRead ?? 0) + saved - counted;
        counted = saved;
        moveUnits(job, 'partPrices', { done: before + processed });
        measure(job, 'partPrices', ms, PART_PRICE_BATCH);
        await store.putScan(job);
      },
    });
    if (!started) {
      await nothingToRead(run, 'partPrices');
      return;
    }
    if (out.stopped === 'time') noteProblem(job, `Home Depot part prices: ${out.saved} of ${out.asked} read in this scan's ${PART_PRICE_MS / 60_000} minutes; the rest are read next time.`);
  } catch (err) {
    noteProblem(job, `Reading Home Depot prices failed: ${(err instanceof Error && err.message) || String(err)}`);
    if (started) failStep(job, 'partPrices', 'price reader failed', run.now());
    await store.putScan(job);
    return;
  }
  endStep(job, 'partPrices', run.now());
  await store.putScan(job);
  await splitWaiting(run);
}

/** Step 15: the parts a split waits for Home Depot's reading of (Decomposition.waitingFor), as parts. */
export function waitingParts(b: Pick<BundleRecord, 'brand' | 'split'>): Part[] {
  if (!b.split || b.split.status === 'resolved') return [];
  const brand = b.brand.trim().toUpperCase();
  return (b.split.waitingFor ?? []).map((m) => ({ key: partKey(brand, m), brand, model: m.trim().toUpperCase() }));
}

/**
 * Step 15: once Home Depot's part prices are read, every split that waited for them is read again (splitOne, with the
 * readings now stored): settled, still waiting, or a question with its reason. Never a search.
 */
async function splitWaiting(run: Run): Promise<void> {
  const out = await settleWaitingSplits(run.store, run.now(), { catalog: run.catalog, waitForPages: run.waitForPages });
  run.job.counts.bundlesResolved += out.resolved;
  run.job.counts.reviewsOpened += out.opened;
  for (const k of out.parts) run.settledParts.add(k);
}

/**
 * Step 15: every split that waits for Home Depot's part pages read again with the readings stored now (splitOne): the
 * scan's part-price pass and the agent's drip both call it. `catalog`: the models the splitter knows (default: read
 * now). Returns how many it settled and how many Review questions it opened. Never a search.
 */
export async function settleWaitingSplits(
  store: ScanStore, now: number, o: { catalog?: Catalog; waitForPages?: boolean } = {},
): Promise<{ resolved: number; opened: number; parts: string[] }> {
  const waiting = (await store.listBundles()).filter((b) => waitingParts(b).length > 0);
  const out = { resolved: 0, opened: 0, parts: [] as string[] };
  if (waiting.length === 0) return out;
  const known = await knownModels(store);
  for (const bundle of waiting) {
    const { split, opened } = await splitOne(store, bundle, { stored: known.stored, catalog: o.catalog ?? known.catalog, settle: known.settle }, now, o.waitForPages ?? true);
    if (split.status === 'resolved') {
      out.resolved += 1;
      for (const m of split.components) out.parts.push(partKey(bundle.brand, m));
    }
    if (opened) out.opened += 1;
  }
  return out;
}

// ---------------------------------------------------------------- step 10: eBay's reference values for the parts (free)

/**
 * Step 10: the parts whose eBay value a scan checks now: every part bundleParts plans for (kit items included)
 * whose eBay value record, or a twin's, is complete and was checked within freshnessMs. A record that left
 * listings unjudged is asked for again whatever its age. Largest saving first, then key; a RYOBI part written
 * two ways once.
 */
export async function ebayPartsWanted(store: ScanStore, settings: ScanSettings, now: number): Promise<EbayPart[]> {
  const parts = [...(await bundleParts(store)).values()];
  const checked = new Map((await store.listEbayValues()).filter((r) => r.complete).map((r) => [r.key, r.checkedAt] as const));
  const fresh = (p: Part): boolean => [p.key, ...twinKeys(p.brand, p.model)].some((k) => {
    const at = checked.get(k);
    return at !== undefined && now - at <= settings.freshnessMs;
  });
  const seen = new Set<string>();
  return parts
    .filter((p) => !fresh(p))
    .sort((a, b) => b.saving - a.saving || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((p) => once(seen, kitKey(p.brand, p.model)))
    .map(({ key, brand, model }) => ({ key, brand, model }));
}

/**
 * Step 10: the eBay step (runEbayPass), or the plain sentence saying why it did not run. Never a search of
 * SerpApi's, and never stops the scan: a failure is a sentence in the job's ebayNotice. Not run once a stop was asked for.
 */
async function ebayPass(run: Run): Promise<void> {
  const { store, job, ebay } = run;
  if (!ebay || run.shouldStop()) return;
  if (ebay.kind === 'skip') {
    noteEbay(job, ebay.notice);
    await store.putScan(job);
    return;
  }
  const parts = await ebayPartsWanted(store, run.settings, run.now());
  if (parts.length === 0) {
    for (const id of ['ebay', 'judge'] as const) skipStep(job, id, 'all up to date');
    await store.putScan(job);
    return;
  }
  // Step 11: the eBay step and the listing check run together, a listing at a time; the pass keeps their figures.
  const counts = job.counts;
  startStep(job, 'ebay', { remaining: null, done: (counts.ebaySearches ?? 0) + (counts.ebayItemReads ?? 0), now: run.now() });
  startStep(job, 'judge', { remaining: null, done: counts.listingsJudged ?? 0, now: run.now() });
  await store.putScan(job);
  // Only eBay and the model are called inside the pass, and it catches what they throw. An error from the store
  // is not caught: the job stays "running" and the next run continues it, as for the other free steps.
  await runEbayPass({
    store, job, save: () => store.putScan(job), parts, ebay: ebay.ebay, judge: ebay.judge, listingsJudgedPerScan: ebay.listingsJudgedPerScan,
    now: run.now, shouldStop: () => run.shouldStop() || (ebay.halted?.() ?? false),
    ...(ebay.signal ? { signal: ebay.signal } : {}), ...(ebay.callTimeoutMs ? { callTimeoutMs: ebay.callTimeoutMs } : {}),
  });
  for (const id of ['ebay', 'judge'] as const) {
    // A pass that made no call of this kind, and was not stopped, had nothing to do for it.
    const s = job.pipeline?.find((p) => p.id === id);
    if (s && s.unitsDone === 0 && s.costSoFar === undefined && !run.shouldStop()) skipStep(job, id, NONE_FOUND);
    else endStep(job, id, run.now());
  }
  await store.putScan(job);
}

const newestFirst = (a: BundleRecord, b: BundleRecord): number => b.seenAt - a.seenAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** P1 to P4 for one list of pages: one call to readPages, each page read saved and counted, problems noted, then the job saved. */
async function readInto(run: Run, stage: StepId, targets: PageTarget[]): Promise<PassResult> {
  const { store, job, readPages } = run;
  // Step 11: saved before the reader is called, so the row shows "0 of N" while the batch is in flight.
  startStep(job, stage, { remaining: targets.length, now: run.now() });
  await store.putScan(job);
  const readStart = run.now();
  // Only the reader is inside the try. An error from the store is not caught: the job stays
  // "running" and the next runScan continues it, reading only the pages still unread.
  let outcomes: PageOutcome[];
  try {
    outcomes = await readPages!(targets.map((t) => t.itemId));
  } catch (err) {
    noteProblem(job, `Reading Home Depot pages failed: ${(err instanceof Error && err.message) || String(err)}`);
    endStep(job, stage, run.now());
    await store.putScan(job);
    return { goOn: false, notRead: targets.length, why: 'page reader failed' };
  }
  const readAt = run.now();
  const asked = new Map(targets.map((t) => [t.itemId, t]));
  let refused = false;
  // The first refused page's status and note, said in the sentence.
  let refusedStatus: number | undefined;
  let refusedNote: string | undefined;
  let unreadable = 0;
  // What the first page that came back without its state showed instead (its title).
  let unreadableNote: string | undefined;
  // The reader stopped before the end (a refusal, or pages in a row without their state): nothing more is read this run.
  let skipped = false;
  let anyRead = false;
  let read = 0;
  for (const outcome of outcomes) {
    const target = asked.get(outcome.itemId);
    // An outcome for an id that was not asked for, or a second one for the same id, is ignored.
    if (!target) continue;
    asked.delete(outcome.itemId);
    if (outcome.kind === 'read') {
      await target.save({ ...outcome.content, readAt });
      job.counts.pagesRead += 1;
      read += 1;
      anyRead = true;
    } else if (outcome.kind === 'refused') {
      if (!refused) {
        refusedStatus = outcome.status;
        refusedNote = outcome.note;
      }
      refused = true;
    } else if (outcome.kind === 'unreadable') {
      unreadable += 1;
      unreadableNote ??= outcome.note;
    } else if (outcome.kind === 'skipped') {
      skipped = true;
    }
  }
  const titled = (note: string | undefined): string => (note ? `, titled "${note}"` : '');
  if (refused) {
    const said = refusedStatus === undefined
      ? refusedNote ? ` (its tab never showed the page${titled(refusedNote)})` : ''
      : refusedStatus === 0 ? ' (no answer)' : ` (HTTP ${refusedStatus}${titled(refusedNote)})`;
    noteProblem(job, `Home Depot refused a page${said}; the rest are read next scan.`);
  }
  else if (unreadable > 0) {
    // Nov 23: a 200 without the page's state is said with what came back, and is not a refusal.
    const what = unreadableNote ? ` (it came back without its data${titled(unreadableNote)})` : '';
    noteProblem(job, anyRead ? `A Home Depot page could not be read${what}.` : `No Home Depot page could be read${what}.`);
  }
  moveUnits(job, stage, { done: (job.pipeline?.find((p) => p.id === stage)?.unitsDone ?? 0) + read });
  measure(job, stage, run.now() - readStart, targets.length);
  endStep(job, stage, run.now());
  await store.putScan(job);
  const goOn = !refused && !skipped;
  return { goOn, notRead: targets.length - read, ...(refused ? { why: 'Home Depot refused' } : !goOn ? { why: 'pages not readable' } : {}) };
}

/**
 * Step 11: a read step with no page to read did not run: skipped, "none found" (or why there was no room), never
 * "done, 0 read" (UI review of P2).
 */
async function nothingToRead(run: Run, stage: StepId, why = NONE_FOUND): Promise<PassResult> {
  skipStep(run.job, stage, why);
  await run.store.putScan(run.job);
  return { goOn: true, notRead: 0 };
}

/**
 * Step 11: the record of the scan's stages, ready to be filled. A job without one (saved before step 11, or continued
 * from one) gets what its phase and counts say. The stages this run cannot run are skipped now, with the reason.
 */
function beginPipeline(run: Run): void {
  const { job, ebay } = run;
  ensurePipeline(job);
  if (!run.readPages) for (const id of ['bundlePages', 'kitPages'] as const) skipStep(job, id, run.noReaderReason ?? 'no page reader');
  if (!run.readPartPrices) skipStep(job, 'partPrices', run.noReaderReason ?? 'no price reader');
  if (!ebay) for (const id of ['ebay', 'judge'] as const) skipStep(job, id, 'not in this run');
  else if (ebay.kind === 'skip') {
    const missing = ebay.missing ?? [];
    const noEbay = 'no eBay keys';
    const noClaude = 'no Anthropic key';
    skipStep(job, 'ebay', missing.length === 0 ? 'keys not saved' : missing.includes('ebay') ? noEbay : noClaude);
    skipStep(job, 'judge', missing.length === 0 ? 'keys not saved' : missing.includes('anthropic') ? noClaude : noEbay);
  } else setJudge(job, ebay.judge.model, estimatedJudgeCost(ebay.judge.model, ebay.listingsJudgedPerScan));
}

/**
 * A problem that does not stop the scan, after any message already there, as a skipped brand
 * page's sentence is (2c rule 3). A continued job that meets the same problem again does not
 * repeat it.
 */
function noteProblem(job: ScanJob, sentence: string): void {
  if (job.stopMessage === null) job.stopMessage = sentence;
  else if (!job.stopMessage.includes(sentence)) job.stopMessage = `${job.stopMessage} ${sentence}`;
}

// ---------------------------------------------------------------- rule 4 and 2c rule 4: split (free)

// knownModels and readSplit live in split.ts, which a reopened split question reads with too.
export { type KnownModels, knownModels } from './split';

/** `known.stored`: the stored catalog alone; `run.catalog` adds the listings' models; `known.settle`: what the step 15 settle rules read. */
async function splitBundles(run: Run, known: KnownModels): Promise<void> {
  const { store, job, catalog } = run;
  const now = run.now();
  let resolved = 0;
  for (const bundle of await store.listBundles()) {
    const { split, opened } = await splitOne(store, bundle, { stored: known.stored, catalog, settle: known.settle }, now, run.waitForPages);
    if (split.status === 'resolved') resolved += 1;
    if (opened) job.counts.reviewsOpened += 1;
  }
  job.counts.bundlesResolved = resolved;
}

/**
 * Rule 4, P5 and step 5 for one bundle, as a scan splits each: the split is saved on the bundle, and
 * its split question (`split:` and the bundle key) is closed, opened, or made to follow the latest
 * reading. `opened`: a question was opened, new or asked again. A product page the owner has open is
 * split by it too (pageView.ts), so the two never differ. Never a search.
 */
/** Nov 23: the bundle's own Home Depot page has been read (and saved on it). */
export const pageRead = (bundle: Pick<BundleRecord, 'page'>): boolean => bundle.page !== undefined && bundle.page !== null;

/**
 * Nov 23, at the agent's start (the next scan does the same in splitOne): every open split question a scan opened for a
 * bundle whose own page was never read is withdrawn, closed as a scan closes one (RESOLVED_BY_SCAN), so the bundle waits
 * for its page instead of asking the owner. A bundle with no record, or whose split is resolved, is left to the scan.
 * Step 15: every other open split question is read again under the settle rules, and closed when they now settle its
 * split or make it wait for Home Depot's part pages. Returns the ids withdrawn or settled.
 */
export async function withdrawUnreadSplitQuestions(store: ScanStore, now: number): Promise<string[]> {
  const out: string[] = [];
  let known: KnownModels | null = null;
  for (const item of await store.listReview()) {
    if (item.kind !== 'split' || item.answer !== null) continue;
    const bundle = await store.getBundle(item.subject);
    if (!bundle || bundle.split?.status === 'resolved') continue;
    if (!pageRead(bundle)) {
      await store.putReview({ ...item, answer: RESOLVED_BY_SCAN, answeredAt: now });
      out.push(item.id);
      continue;
    }
    // Step 15: the question read again under the settle rules (scan/settle.ts), as the next scan would: a split they
    // settle is saved and its question closed as a scan closes one; one that now waits for Home Depot's part pages is
    // withdrawn. The owner's answers are never touched (only open questions are read).
    known ??= await knownModels(store);
    const { split } = await splitOne(store, bundle, known, now, true);
    const after = await store.getReview(item.id);
    if (split.status === 'resolved' || (after && after.answer === RESOLVED_BY_SCAN)) out.push(item.id);
  }
  return out;
}

export async function splitOne(
  store: ScanStore, bundle: BundleRecord, known: Pick<KnownModels, 'stored' | 'catalog'> & Partial<Pick<KnownModels, 'settle'>>, now: number, waitForPage = false,
): Promise<{ split: Decomposition; opened: boolean }> {
  const id = `split:${bundle.key}`;
  const item = await store.getReview(id);
  // The owner's answer comes first (step 5): parts the owner chose stand instead of any reading,
  // and "none" keeps the bundle in review whatever the readings now say. Otherwise P5: the
  // model number's split, then the bundle's own page, when it was read.
  const owner = ownerSplit(item);
  const read = () => readSplit(bundle, known);
  const split = owner === null ? read() : owner === NONE ? notKnown(read()) : owner;
  await store.putBundle({ ...bundle, split });
  if (split.status === 'resolved') {
    if (item && item.answer === null) await store.putReview({ ...item, answer: RESOLVED_BY_SCAN, answeredAt: now });
    return { split, opened: false };
  }
  // Nov 23: a bundle whose own Home Depot page has not been read is not a question yet (it waits for its
  // page, waiting_page): the page is what says what is inside, so asking the owner before it is read asks
  // him for what a free read may answer. An open question a scan opened for it is withdrawn (closed as a
  // scan closes one), and asked again if the page, once read, still leaves the split uncertain. The
  // owner's own answer is never touched. Rule 4 is unchanged: nothing here makes a split resolved.
  if (waitForPage && owner === null && !pageRead(bundle)) {
    if (item && item.answer === null) await store.putReview({ ...item, answer: RESOLVED_BY_SCAN, answeredAt: now });
    return { split, opened: false };
  }
  // Step 15 (decision 4, rule 2): a split whose parts Home Depot has not been read for yet (the free part-price read, a
  // kit's own page) waits for them (waiting_parts) the same way: a question is opened only once a reading came back not
  // found or the page contradicts the reading.
  if (waitForPage && owner === null && (split.waitingFor ?? []).length > 0) {
    if (item && item.answer === null) await store.putReview({ ...item, answer: RESOLVED_BY_SCAN, answeredAt: now });
    return { split, opened: false };
  }
  // The question follows the latest reading (a page that does not fit names both readings), and
  // offers the readings the split carries (step 5). An item the user answered is never changed.
  const reason = split.notes.join('; ');
  const choices = splitChoices(split);
  if (!item || item.answer === RESOLVED_BY_SCAN) {
    // A new question, or one a scan closed and must ask again.
    await store.putReview({
      id, kind: 'split', subject: bundle.key, brand: bundle.brand, model: bundle.model, title: bundle.title,
      reason, candidates: [], choices, openedAt: now, answer: null, answeredAt: null,
    });
    return { split, opened: true };
  }
  if (item.answer === null && (item.reason !== reason || !sameChoices(choicesOf(item), choices))) {
    // Still open: a new reading, the same question, so openedAt stays.
    await store.putReview({ ...item, reason, choices });
  }
  return { split, opened: false };
}

// ---------------------------------------------------------------- rule 5: plan the parts

interface Wants {
  /** Part keys, in the order they should be paid for. */
  lookups: string[];
  refreshes: string[];
  /**
   * Step 6: the lookups, then the refreshes, of kit items no bundle's split holds itself, in the
   * order they should be paid for. Planned only after every lookup and refresh above, from what the
   * allowance has left (planParts); a job's start never counts them, so they move nothing else.
   */
  items: string[];
  steps: Map<string, Lookup | Refresh | IdentifyStep>;
}

/** A part of a bundle: partKey(brand, model), brand and model upper case. */
export interface Part {
  key: string;
  brand: string;
  model: string;
}

/** Rule 5: a lookup is wanted for a part with no match, or one left waiting, never for a user's decision. */
export const lookupWanted = (match: MatchRecord | undefined): boolean => !match || (match.status === 'waiting' && match.decidedBy !== 'user');

/** A part some bundle holds, as the lookups see it. */
export interface BundlePart extends Part {
  /** The largest saving among the bundles that hold it. */
  saving: number;
  /**
   * Step 6: the part keys of the kits it is an item of (kitItemParts), when no bundle's split holds
   * the part itself; empty when one does, and then it is planned as any part.
   */
  kits: string[];
  /** The keys of the bundles that hold it, itself or as an item of one of their kits. */
  bundles: string[];
}

/**
 * Rule 5: the parts of every resolved bundle, by part key, each with the largest saving among its
 * bundles; then (step 6) the items with a model number of every kit those bundles' options split,
 * that no split holds itself, with the kits that hold them. A kit item that is also a part of some
 * split is that part. `only`, when given, keeps the parts of the bundles it accepts (a product page
 * the owner has open asks for its own bundle's); kits are still read from every stored record.
 */
export async function bundleParts(store: ScanStore, only?: (b: BundleRecord) => boolean): Promise<Map<string, BundlePart>> {
  const parts = new Map<string, BundlePart>();
  const items = new Map<string, BundlePart>();
  const stored = await store.listBundles();
  // Step 6: a kit's page may be on a bundle record or on its catalog entry (kitRecords).
  const recordsOf = kitIndex(kitRecords(stored, await store.listCatalog()));
  const bundles = only ? stored.filter(only) : stored;
  const add = (into: Map<string, BundlePart>, part: Part, saving: number, kit: string | null, bundle: string) => {
    const seen = into.get(part.key);
    if (!seen) into.set(part.key, { key: part.key, brand: part.brand, model: part.model, saving, kits: kit === null ? [] : [kit], bundles: [bundle] });
    else {
      seen.saving = Math.max(seen.saving, saving);
      if (kit !== null && !seen.kits.includes(kit)) seen.kits.push(kit);
      if (!seen.bundles.includes(bundle)) seen.bundles.push(bundle);
    }
  };
  for (const b of bundles) {
    const saving = (b.regularPrice ?? b.price ?? 0) - (b.price ?? 0);
    for (const part of resolvedParts(b)) add(parts, part, saving, null, b.key);
    for (const item of kitItemParts(b, recordsOf)) add(items, item, saving, item.kit, b.key);
  }
  for (const [key, item] of items) {
    const part = parts.get(key);
    if (!part) parts.set(key, item);
    else for (const b of item.bundles) if (!part.bundles.includes(b)) part.bundles.push(b);
  }
  return parts;
}

/**
 * Step 6: whether a scan may look up (or refresh) the items of a kit: the kit was looked up (its
 * match is no longer waiting) and has no active listing, by the report's rule (a matched listing
 * whose price was seen at its last check). Before the kit's own lookup nobody knows it does not sell
 * whole; with an active listing it does. Ruling 69: a kit in review holds its items too, as the owner
 * may still choose a listing that is the kit; the panel's Look up is not held.
 */
async function itemsWanted(store: ScanStore, kit: MatchRecord | undefined): Promise<boolean> {
  if (!kit || kit.status === 'waiting' || kit.status === 'review') return false;
  if (kit.status !== 'matched' || kit.asin === null) return true;
  return !priceActive(await store.getPrice(kit.asin));
}

/**
 * The lookups and refreshes the store asks for right now, most valuable first.
 * `fromListings` (2c rule 5, savedMatch) gives each part's match after its saved listings were
 * tried; without it the stored match is read.
 */
async function wantedParts(
  store: ScanStore, settings: ScanSettings, now: number, fromListings?: (part: Part) => Promise<MatchRecord | undefined>,
  failedBefore: string[] = [], pairs: Readonly<Record<string, string>> = {},
): Promise<Wants> {
  const parts = await bundleParts(store);
  const lookups: string[] = [];
  const refreshes: string[] = [];
  const itemLookups: string[] = [];
  const itemRefreshes: string[] = [];
  const waitingSince = new Map<string, number>();
  const steps = new Map<string, Lookup | Refresh | IdentifyStep>();
  // 2c rule 5 first, for every part, kit items too whatever their kit's state: a saved listing costs
  // nothing. The kits' own matches are final before any kit's items are judged below.
  const matches = new Map<string, MatchRecord | undefined>();
  for (const [key, { brand, model }] of parts) {
    matches.set(key, fromListings ? await fromListings({ key, brand, model }) : await store.getMatch(key));
  }
  // Step 6: per kit, whether a scan may look up its items, read once. A kit is itself a part of a
  // resolved split (kitItemParts), so its match was read above.
  const kitWanted = new Map<string, boolean>();
  const anyKitWanted = async (kits: string[]): Promise<boolean> => {
    for (const kit of kits) {
      if (!kitWanted.has(kit)) kitWanted.set(kit, await itemsWanted(store, matches.get(kit)));
      if (kitWanted.get(kit)) return true;
    }
    return false;
  };
  for (const [key, { brand, model, kits }] of parts) {
    const match = matches.get(key);
    const item = kits.length > 0;
    // A kit item is planned only while one of its kits was looked up and has no active listing.
    if (item && !(await anyKitWanted(kits))) continue;
    // Never a lookup for a match the user decided, even one left waiting.
    if (lookupWanted(match)) {
      if (match) waitingSince.set(key, match.waitingSince ?? 0);
      (item ? itemLookups : lookups).push(key);
      steps.set(key, { kind: 'lookup', brand, model });
    } else if (match?.pageDue && match.decidedBy !== 'user' && match.status !== 'matched' && match.status !== 'waiting') {
      (item ? itemLookups : lookups).push(key);
      steps.set(key, { kind: 'identify', brand, model, asin: match.pageDue });
    } else if (match?.status === 'matched' && match.asin !== null) {
      // Also a part just matched from a saved listing: its price is the listing's, as old as that.
      const price = await store.getPrice(match.asin);
      if (!price || now - price.checkedAt > settings.freshnessMs) {
        (item ? itemRefreshes : refreshes).push(key);
        steps.set(key, { kind: 'refresh', brand, model, asin: match.asin });
      }
    }
  }
  const { byLookup, byRefresh } = lookupOrder(parts, waitingSince, failedBefore);
  lookups.sort(byLookup);
  refreshes.sort(byRefresh);
  itemLookups.sort(byLookup);
  itemRefreshes.sort(byRefresh);
  // BOGO pairs never crowd out the other bundles: what only pairs hold is paid for after everything else, and a
  // group's new pairs are capped per scan (pairLookupOrder).
  if (Object.keys(pairs).length > 0) {
    const savings = new Map((await store.listBundles()).filter((b) => pairs[b.key] !== undefined).map((b) => [b.key, (b.regularPrice ?? b.price ?? 0) - (b.price ?? 0)]));
    const ordered = pairLookupOrder(lookups, parts, pairs, savings);
    lookups.splice(0, lookups.length, ...ordered);
    const pairOnly = (k: string) => onlyPairs(parts.get(k)!, pairs);
    const last = (keys: string[]) => keys.splice(0, keys.length, ...keys.filter((k) => !pairOnly(k)), ...keys.filter(pairOnly));
    last(refreshes);
    last(itemLookups);
    last(itemRefreshes);
  }
  // Ruling 70: one lookup per product. A RYOBI part written two ways (PCL515 and PCL515B, kitKey) is
  // looked up once, the first in this order; the other takes that match at the next planning
  // (matchFromListings). And one refresh per listing the two forms share. DEWALT parts are each their own.
  const looked = new Set<string>();
  const firstLookup = (k: string): boolean => once(looked, kitKey(parts.get(k)!.brand, parts.get(k)!.model));
  const refreshed = new Set<string>();
  const firstRefresh = (k: string): boolean => {
    const step = steps.get(k) as Refresh;
    return once(refreshed, `${kitKey(step.brand, step.model)} ${step.asin}`);
  };
  // Step 6: kit items take their own rank, below every part above, ordered among themselves the same way.
  return {
    lookups: lookups.filter(firstLookup),
    refreshes: refreshes.filter(firstRefresh),
    items: [...itemLookups.filter(firstLookup), ...itemRefreshes.filter(firstRefresh)],
    steps,
  };
}

/** New BOGO pairs a scan looks up per promotion group, at most; later scans continue down the group's list. */
export const PAIR_LOOKUPS_PER_GROUP = 3;

/** True when every bundle holding the part is a BOGO pair. */
const onlyPairs = (part: BundlePart, pairs: Readonly<Record<string, string>>): boolean =>
  part.bundles.length > 0 && part.bundles.every((b) => pairs[b] !== undefined);

/**
 * BOGO pairs (core/src/tracking/bogoPairs.ts) after every other bundle. `lookups` is in the scan's order; `pairs` maps a
 * pair's bundle key to its group (promotion and starter), `savings` a pair to Home Depot's own saving (was - price). The
 * parts some other bundle holds keep their order and come first. Then, group by group (the group whose best saving is
 * largest first), its pairs by saving, largest first: a pair that needs a part no earlier step looks up is a new pair,
 * and only the first PAIR_LOOKUPS_PER_GROUP new pairs of a group are looked up this scan. A pair whose parts are matched
 * or already planned (a free part shared with another bundle or group is looked up once) needs nothing and is not counted.
 * The parts of the pairs past the cap are left out, not deferred: the next scan plans them when their turn comes.
 */
export function pairLookupOrder(
  lookups: readonly string[], parts: ReadonlyMap<string, BundlePart>, pairs: Readonly<Record<string, string>>, savings: ReadonlyMap<string, number>,
  cap = PAIR_LOOKUPS_PER_GROUP,
): string[] {
  const isPairOnly = (k: string) => onlyPairs(parts.get(k)!, pairs);
  const out = lookups.filter((k) => !isPairOnly(k));
  const planned = new Set(out);
  const need = new Map<string, string[]>();
  for (const k of lookups) {
    if (!isPairOnly(k)) continue;
    for (const b of parts.get(k)!.bundles) need.set(b, [...(need.get(b) ?? []), k]);
  }
  const groups = new Map<string, string[]>();
  for (const [pair, group] of Object.entries(pairs)) if (savings.has(pair)) groups.set(group, [...(groups.get(group) ?? []), pair]);
  const saving = (pair: string) => savings.get(pair) ?? 0;
  const bySaving = (a: string, b: string) => saving(b) - saving(a) || (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...groups.entries()].map(([group, list]) => [group, list.sort(bySaving)] as const);
  ordered.sort((a, b) => saving(b[1][0]!) - saving(a[1][0]!) || (a[0] < b[0] ? -1 : 1));
  for (const [, list] of ordered) {
    let taken = 0;
    for (const pair of list) {
      const fresh = (need.get(pair) ?? []).filter((k) => !planned.has(k));
      if (fresh.length === 0) continue;
      if (taken >= cap) break;
      taken += 1;
      for (const k of fresh) {
        planned.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

/**
 * The order a scan pays for parts in, best first, as two comparators over part keys of `parts`.
 * `waitingSince` holds, for each part to look up that has a match record, its waitingSince (0 when
 * none). The panel's Look up orders its searches by `byLookup` too (Ruling 72); kit items are ranked
 * below every other part by the caller.
 */
export function lookupOrder(
  parts: Map<string, BundlePart>, waitingSince: Map<string, number>, failedBefore: string[],
): { byLookup: (a: string, b: string) => number; byRefresh: (a: string, b: string) => number } {
  const bySaving = (a: string, b: string) => parts.get(b)!.saving - parts.get(a)!.saving || (a < b ? -1 : a > b ? 1 : 0);
  // Rulings 50 and 57: a part whose last lookup or refresh failed goes after every other candidate,
  // the least recent failure first, so failing parts cannot take the only slot in turns; each still
  // runs when the allowance reaches it or nothing else waits.
  const failed = (k: string) => failedBefore.indexOf(k);
  // Then waiting parts first, oldest first; then by saving.
  const rank = (k: string) => waitingSince.get(k) ?? Infinity;
  const byLookup = (a: string, b: string) => failed(a) - failed(b) || (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) || bySaving(a, b);
  const byRefresh = (a: string, b: string) => failed(a) - failed(b) || bySaving(a, b);
  return { byLookup, byRefresh };
}

/** Adds `id` to `seen`: true the first time, false after. */
function once(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

/** Step 15: Keepa pays for Amazon work in this run (a key, the setting on, and its token figures handed in). */
const keepaInPlay = (run: Pick<Run, 'keepaProduct' | 'keepaScale' | 'settings'>): boolean =>
  Boolean(run.keepaProduct && run.settings.amazonRefreshViaKeepa && run.keepaScale);

/**
 * Step 15: a want list split the way keepa/route.ts pays for it, each in value order: the lookups (parts, then kit
 * items), the product pages owed (identify), and the refreshes (parts, then kit items).
 */
export function workOf(wants: Pick<Wants, 'lookups' | 'items' | 'refreshes' | 'steps'>): { lookups: string[]; identifies: string[]; refreshes: string[] } {
  const kind = (k: string) => wants.steps.get(k)!.kind;
  const all = [...wants.lookups, ...wants.items];
  return {
    lookups: all.filter((k) => kind(k) === 'lookup'),
    identifies: all.filter((k) => kind(k) === 'identify'),
    refreshes: [...wants.refreshes, ...wants.items.filter((k) => kind(k) === 'refresh')],
  };
}

/**
 * Step 15: the Amazon work a scan would plan now, from saved data alone (no search, nothing written, no saved listing
 * tried): each kind in value order, and the step of each key. What the agent's drip and "Look up all" route.
 */
export async function plannedWork(
  store: ScanStore, settings: ScanSettings, now: number, pairs: Readonly<Record<string, string>> = {},
): Promise<{ work: { lookups: string[]; identifies: string[]; refreshes: string[] }; steps: Map<string, ScanStep> }> {
  const wants = await wantedParts(store, settings, now, undefined, failingBefore(await store.listScans()), pairs);
  return { work: workOf(wants), steps: wants.steps };
}

/** `listings`: the saved listings, read once for this planning pass. */
async function planParts(run: Run, listings: ListingRecord[], only?: (key: string) => boolean): Promise<void> {
  const { job, budget } = run;
  // 2c rule 5 runs even when the listing phase stopped: it spends nothing.
  const all = await wantedParts(run.store, run.settings, run.now(), (part) => savedMatch(run, listings, part), run.failedBefore, run.bogoPairs);
  // Step 15: the second pass (after the part prices settled waiting splits) plans only the parts newly needed.
  const wants: Wants = only
    ? { lookups: all.lookups.filter(only), refreshes: all.refreshes.filter(only), items: all.items.filter(only), steps: all.steps }
    : all;
  for (const key of [...wants.lookups, ...wants.refreshes, ...wants.items]) run.plannedKeys.add(key);
  // A stop asked for during the last listing search, when the queue emptied as usual (QA M7), is a stop on request too.
  if (job.stopReason === null && run.shouldStop()) job.stopReason = 'user';
  // In the listing phase only rule 8 or a stop on request (3 rule 1) sets a stop reason: then nothing more is spent.
  const allowance = job.stopReason === null ? budget.spendable : 0;
  const toSteps = (keys: string[]) => keys.map((k) => wants.steps.get(k)!);
  let queue: ScanStep[];
  let later: ScanStep[];
  let serpDeferred: boolean;
  if (keepaInPlay(run)) {
    // Step 15, decision 1: Keepa's tokens above the reserve first, then SerpApi's searches, then the rest waits.
    const scale = run.keepaScale!;
    const work = workOf(wants);
    // A per-scan cap counts what this run has spent already (the second pass); 0 is automatic.
    const capLeft = scale.tokensPerRun > 0 ? scale.tokensPerRun - (run.keepaBudget?.spentThisRun ?? 0) : 0;
    const tokens = job.stopReason === null && !(scale.tokensPerRun > 0 && capLeft <= 0)
      ? keepaTokensForScan({ tokensLeft: run.keepaBudget?.knownBalance ?? scale.tokensLeft, reserve: scale.reserve, tokensPerScan: capLeft })
      : 0;
    const plan = routeAmazonWork(work, { tokens, trackingDepth: scale.trackingDepth, lookups: Boolean(run.keepaLookup) }, { spendable: allowance, blockReason: (n) => budget.blockReason(n) });
    const via = new Map<string, 'keepa' | 'serpapi'>([...plan.keepaLookups.map((k) => [k, 'keepa'] as const), ...plan.serpLookups.map((k) => [k, 'serpapi'] as const)]);
    const routed = (k: string): ScanStep => {
      const step = wants.steps.get(k)!;
      const v = via.get(k);
      return step.kind === 'lookup' && v ? { ...step, via: v } : step;
    };
    queue = [...work.lookups.filter((k) => via.has(k)).map(routed), ...toSteps(plan.keepaIdentifies), ...toSteps(plan.keepaRefreshes)];
    later = toSteps([...plan.deferredLookups, ...plan.deferredIdentifies, ...plan.deferredRefreshes]);
    const pull = productTokenEstimate(scale.trackingDepth, 1);
    const before = only ? job.keepaPlan : undefined;
    job.keepaPlan = {
      discoveryTokens: (before?.discoveryTokens ?? 0) + plan.keepaLookups.length * KEEPA_LOOKUP_TOKEN_ESTIMATE + plan.keepaIdentifies.length * pull,
      trackingTokens: (before?.trackingTokens ?? 0) + plan.keepaRefreshes.length * pull,
      lookups: (before?.lookups ?? 0) + plan.keepaLookups.length,
      refreshes: (before?.refreshes ?? 0) + plan.keepaRefreshes.length,
    };
    job.lookupsBlockedBy = plan.blockedBy ?? (only ? job.lookupsBlockedBy ?? null : null);
    serpDeferred = false;
  } else {
    const plan = planScan(allowance, { hdPagesWanted: 0, pendingLookups: wants.lookups, staleRefreshes: wants.refreshes });
    // Step 6: kit items from SerpApi headroom.
    const room = Math.max(0, Math.floor(allowance) - plan.searches);
    const items = wants.items.slice(0, room);
    const deferredItems = wants.items.slice(items.length);
    queue = [...toSteps(plan.lookups), ...toSteps(plan.refreshes), ...toSteps(items)];
    later = [...toSteps(plan.deferredLookups), ...toSteps(plan.deferredRefreshes), ...toSteps(deferredItems)];
    serpDeferred = later.length > 0;
    const block = later.some((s) => s.kind === 'lookup') ? lookupBlockOf(budget.blockReason(Math.floor(allowance) + 1) ?? 'run_cap') : null;
    job.lookupsBlockedBy = block ?? (only ? job.lookupsBlockedBy ?? null : null);
  }
  // Ruling 57: a failing part no longer wanted (matched since, decided, or in no bundle) is dropped.
  keepFailing(job, (k) => wants.steps.has(k));
  for (const step of later) if (step.kind === 'lookup') await markWaiting(run, step);
  job.queue = queue;
  job.deferred.push(...later);
  // Ruling 48: from now on only the parts phase's own deferred steps may move into the queue.
  run.movable = only ? [...run.movable, ...later] : [...later];
  // Names the limit that made work wait. It does not stop the queue just planned.
  if (job.deferred.length > 0 && job.stopReason === null) {
    if (serpDeferred || job.deferred.some((s) => s.kind === 'listing' || s.kind === 'catalog')) job.stopReason = budget.blockReason(budget.spendable + 1);
    else if (job.lookupsBlockedBy) job.stopReason = stopOfBlock(job.lookupsBlockedBy);
    else job.stopReason = 'keepa_tokens';
  }
  job.phase = 'parts';
  await run.store.putScan(job);
}

/** Step 15: the lookup block a stop reason names, for lookups left waiting by a halt. */
function blockOfStop(r: StopReason | null): LookupBlock | null {
  switch (r) {
    case 'run_cap': return 'search_cap';
    case 'reserve': return 'reserve';
    case 'hourly_limit': return 'hourly_limit';
    case 'keepa_tokens': case 'no_tokens': return 'keepa_tokens';
    default: return null;
  }
}

/** Step 15: the Amazon step's figure says what paid and what waits ("4 Keepa, 14 searches, 2 wait"). */
function noteAmazon(job: ScanJob): void {
  const s = job.pipeline?.find((p) => p.id === 'amazon');
  if (!s || s.state === 'skipped') return;
  const via = job.lookupsVia ?? { keepa: 0, serpapi: 0 };
  const parts = [
    ...(via.keepa > 0 ? [`${via.keepa} Keepa`] : []),
    ...(via.serpapi > 0 ? [`${via.serpapi} ${via.serpapi === 1 ? 'search' : 'searches'}`] : []),
    ...((job.lookupsWaiting ?? 0) > 0 ? [`${job.lookupsWaiting} wait`] : []),
  ];
  if (parts.length > 0) s.note = parts.join(', ');
}

/** Step 15: the stop reason a lookup block gives the job. */
const stopOfBlock = (b: LookupBlock): StopReason => (b === 'search_cap' ? 'run_cap' : b);

/**
 * Ruling 70: the match a RYOBI part takes from its twin, its other written form (PCL515 for PCL515B, or
 * the reverse, by sameModel), which is the same product. `own` is the part's own record.
 * - The twin's listing, matched automatically or chosen by the owner, or the owner's "none": always.
 * - The twin's automatic "review" or "none" (fix round 1, Important 2): only while the part has no
 *   result of its own (lookupWanted), so it is not searched for again; a part with its own automatic
 *   result keeps it.
 * Null otherwise, and always for DEWALT. `matchOf` reads a stored match by part key.
 */
export function sharedMatch(
  part: Pick<Part, 'key' | 'brand' | 'model'>, matchOf: (key: string) => MatchRecord | undefined, own: MatchRecord | undefined,
): MatchRecord | null {
  for (const key of twinKeys(part.brand, part.model)) {
    const m = matchOf(key);
    if (!m) continue;
    if ((m.status === 'matched' && m.asin !== null) || (m.decidedBy === 'user' && m.status === 'none')) return m;
    if (m.decidedBy === 'auto' && (m.status === 'review' || m.status === 'none') && lookupWanted(own)) return m;
  }
  return null;
}

/** The reason of the match question a Verify opens (paid.ts). Fix round 3 reads it to know a Verify's review. */
export const NOT_CONFIRMED = "The listing's Amazon page does not confirm the part";

/**
 * Fix rounds 2 and 3: whether a record's result came from a listing's detail page, and the listings
 * pages rejected for it. A record Verify wrote since fix round 2 says so (`source`, `rejectedAsins`).
 * One written before it is read the same way, without being rewritten: an automatic review whose open
 * match question has Verify's reason (NOT_CONFIRMED), and that question's listings as the rejected ones.
 */
export async function pageEvidence(store: ScanStore, rec: MatchRecord | undefined): Promise<{ page: boolean; rejected: string[] }> {
  const rejected = rejectedOf(rec);
  if (!rec) return { page: false, rejected };
  if (rec.source === 'page') return { page: true, rejected };
  if (rec.decidedBy !== 'auto' || rec.status !== 'review') return { page: false, rejected };
  const q = await store.getReview(`match:${rec.key}`);
  if (!q || q.answer !== null || q.reason !== NOT_CONFIRMED) return { page: false, rejected };
  return { page: true, rejected: [...new Set([...rejected, ...q.candidates.map((c) => c.asin)])] };
}

/** The part's open match question is closed, as a scan closes a question the data settled. */
async function closeQuestion(ctx: Pick<PartContext, 'store' | 'now'>, key: string): Promise<void> {
  const q = await ctx.store.getReview(`match:${key}`);
  if (q && q.answer === null) await ctx.store.putReview({ ...q, answer: RESOLVED_BY_SCAN, answeredAt: ctx.now() });
}

/**
 * 2c rule 5: the saved listings that carry the part's model, judged by pick() exactly as a
 * lookup's results are. A chosen listing is saved as a lookup saves it, priced from the
 * saved listings. Otherwise null: the part is left to a paid lookup, which alone may open a
 * review item. Before the listings, Ruling 70: a match the part's twin holds (sharedMatch) is saved
 * as the part's own, decided by whoever decided it, and no lookup is wanted. Ruling 73: a scan also
 * judges an automatic "none" or "review" again here; a listing or a twin's settled match then closes
 * the part's open question. The owner's own answer is never touched (null).
 *
 * Fix round 2, a detail page beats a search row: a result Verify wrote from a listing's page
 * (`source: 'page'`) is never judged again here (null), and no listing a page rejected for the part or
 * its twin (`rejectedAsins`) is chosen, from saved listings or by an automatic twin's match.
 */
export async function matchFromListings(ctx: PartContext, listings: ListingRecord[], part: Part): Promise<MatchRecord | null> {
  const { store, job } = ctx;
  const own = await store.getMatch(part.key);
  if (own?.decidedBy === 'user') return null;
  const mine = await pageEvidence(store, own);
  if (mine.page && own!.status !== 'waiting') return null;
  const twins = new Map<string, MatchRecord | undefined>();
  const rejectedSet = new Set(mine.rejected);
  for (const key of twinKeys(part.brand, part.model)) {
    const twin = await store.getMatch(key);
    twins.set(key, twin);
    for (const a of (await pageEvidence(store, twin)).rejected) rejectedSet.add(a);
  }
  const rejected = [...rejectedSet];
  const keep = rejected.length > 0 ? { rejectedAsins: rejected } : {};
  // An automatic twin's match on a rejected listing does not stand for the part; the owner's choice does.
  const twinOf = (key: string): MatchRecord | undefined => {
    const m = twins.get(key);
    return m && m.decidedBy === 'auto' && m.asin !== null && rejected.includes(m.asin) ? undefined : m;
  };
  const shared = sharedMatch(part, twinOf, own);
  if (shared) {
    const copy: MatchRecord = { ...shared, key: part.key, brand: part.brand, model: part.model, updatedAt: ctx.now(), waitingSince: null, ...keep };
    await store.putMatch(copy);
    if (copy.status === 'matched') job.counts.partsMatched += 1;
    if (copy.status === 'matched' || copy.decidedBy === 'user') await closeQuestion(ctx, part.key);
    return copy;
  }
  const picked = pickFromListings(part, ctx.catalog, rejected.length > 0 ? listings.filter((l) => !rejected.includes(l.asin)) : listings);
  if (!picked.chosen) return null;
  const asin = picked.chosen.asin;
  const alternatives = unique(picked.alternatives.map((g) => g.asin)).filter((a) => a !== asin);
  for (const a of [asin, ...alternatives]) {
    const l = listings.find((x) => x.asin === a)!;
    // A saved listing never overwrites a price that was checked later than the listing was.
    const old = await store.getPrice(a);
    if (old && old.checkedAt >= l.checkedAt) continue;
    await store.putPrice({ asin: a, price: l.price, reviews: l.reviews, seenAt: l.seenAt, checkedAt: l.checkedAt });
  }
  const match: MatchRecord = {
    key: part.key, brand: part.brand, model: part.model, status: 'matched', asin, grade: picked.chosen.grade, alternatives,
    decidedBy: 'auto', updatedAt: ctx.now(), waitingSince: null, ...keep,
  };
  await store.putMatch(match);
  await closeQuestion(ctx, part.key);
  job.counts.partsFromCatalog += 1;
  job.counts.partsMatched += 1;
  return match;
}

/**
 * 2c rule 5 for one part, as a scan plans its parts: a part that would need a lookup (lookupWanted),
 * or whose automatic "none" or "review" is judged again (Ruling 73), is tried against the saved
 * listings (matchFromListings). The part's match after that, or the stored one. A product page the
 * owner has open matches its bundle's parts with it too (pageView.ts). Never a search.
 */
export async function savedMatch(ctx: PartContext, listings: ListingRecord[], part: Part): Promise<MatchRecord | undefined> {
  const match = await ctx.store.getMatch(part.key);
  // Ruling 73: an automatic "none" or "review" is judged again too, as saved listings grow and rules change.
  const again = match?.decidedBy === 'auto' && (match.status === 'none' || match.status === 'review');
  if (!lookupWanted(match) && !again) return match;
  return (await matchFromListings(ctx, listings, part)) ?? match;
}

/** 2c rule 5's judgement, writing nothing: a listing is chosen when matchFromListings would match the part. */
export const pickFromListings = (part: Pick<Part, 'brand' | 'model'>, catalog: Catalog, listings: ListingRecord[]): Picked =>
  pick(wantedFor(part.brand, part.model, catalog), candidatesFor(part.brand, part.model, listings));

/** A lookup that did not run: the part goes first next scan. Keeps the first waitingSince. */
export async function markWaiting(ctx: Pick<PartContext, 'store' | 'now'>, step: LookupStep): Promise<void> {
  const key = partKey(step.brand, step.model);
  const old = await ctx.store.getMatch(key);
  // Fix round 3: nor a result a Verify wrote from the listing's page, whose evidence a waiting record would drop.
  if (old?.decidedBy === 'user' || (await pageEvidence(ctx.store, old)).page) return;
  const now = ctx.now();
  await ctx.store.putMatch({
    key, brand: step.brand, model: step.model, status: 'waiting', asin: null, grade: null, alternatives: [],
    decidedBy: 'auto', updatedAt: now, waitingSince: old?.waitingSince ?? now,
  });
}

// ---------------------------------------------------------------- rule 10: finish

/**
 * A stop asked for at any point of the run ends it stopped by the user, also one that came during
 * the last search, when the queue emptied as usual (QA M7). A failed search keeps its own reason
 * ('error', 'rate_limited'), which says more: its message is the job's.
 */
async function finish(run: Run): Promise<ScanJob> {
  const { job } = run;
  if (run.shouldStop() && job.stopReason !== 'error' && job.stopReason !== 'rate_limited') job.stopReason = 'user';
  // Planning named the limit that made work wait (planParts); when every deferred step has
  // since moved into the queue (Ruling 48), nothing waits and no limit stopped the job. A
  // budget refusal at a search always defers that step (halt), so it never ends here.
  if (job.deferred.length === 0 && (job.stopReason === 'run_cap' || job.stopReason === 'reserve' || job.stopReason === 'hourly_limit' || job.stopReason === 'keepa_tokens')) job.stopReason = null;
  // Step 15: the lookups left waiting, and the one cause the owner reads for them.
  const waiting = job.deferred.filter((s) => s.kind === 'lookup').length;
  if (job.phase === 'parts' || job.lookupsVia !== undefined || waiting > 0) {
    job.lookupsWaiting = waiting;
    job.lookupsVia ??= { keepa: 0, serpapi: 0 };
    if (waiting === 0) job.lookupsBlockedBy = null;
    else job.lookupsBlockedBy ??= blockOfStop(job.stopReason);
    if (waiting > 0 && job.lookupsBlockedBy === 'keepa_tokens' && job.stopReason === null) job.stopReason = 'keepa_tokens';
    noteAmazon(job);
  }
  // Step 11: whatever did not run says why; the last step is the save itself.
  closeRest(job, whyNot(job.stopReason), run.now());
  startStep(job, 'finish', { remaining: 1, now: run.now() });
  finishUnit(job, 'finish', { ms: null, remaining: 0 });
  endStep(job, 'finish', run.now());
  job.phase = 'finish';
  job.status = job.stopReason !== null || job.deferred.length > 0 ? 'stopped' : 'done';
  job.finishedAt = run.now();
  await run.store.putScan(job);
  return job;
}

// ---------------------------------------------------------------- step 15: one lookup between scans (the drip)

export interface KeepaOneDeps {
  store: ScanStore;
  settings: ScanSettings;
  now: () => number;
  keepaBudget: Pick<TokenBudget, 'blockReason'>;
  keepaLookup: NonNullable<ScanDeps['keepaLookup']>;
  keepaProduct: NonNullable<ScanDeps['keepaProduct']>;
  /** The models the splitter knows (knownModels), read once for a round of lookups. */
  catalog: Catalog;
  /** First part of every ledger label. Default 'drip'. */
  prefix?: string;
}

/** What one lookup did: matched (and priced), sent to Review, no Amazon listing, or refused before anything was sent. */
export type KeepaOneOutcome = { status: 'matched' | 'review' | 'none' | 'refused'; tokens: number };

/** A search client that refuses: the drip never searches SerpApi. */
const NO_SEARCH: SearchClient = { search: () => Promise.reject(new Error('The drip makes no SerpApi search.')) };

/**
 * Step 15, decision 2: one waiting part looked up on Keepa, outside a scan, exactly as a scan's Keepa lookup is: the
 * search (applyLookup, so the same match rules and questions), then the matched listing's price pulled (applyRefresh), as
 * the recorded search rows carry no price. A product page the lookup could not name is owed to the next scan
 * (notePageDue). Never a SerpApi search. Throws what Keepa throws (a network error, a 429): the part keeps waiting.
 */
export async function keepaLookupOne(d: KeepaOneDeps, step: LookupStep): Promise<KeepaOneOutcome> {
  if (d.keepaBudget.blockReason(KEEPA_LOOKUP_TOKEN_ESTIMATE) !== null) return { status: 'refused', tokens: 0 };
  const prefix = d.prefix ?? 'drip';
  const counts: ScanJob['counts'] = {
    pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0, catalogPages: 0,
    listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0,
  };
  const ctx: PartContext = { client: NO_SEARCH, store: d.store, settings: d.settings, now: d.now, prefix, catalog: d.catalog, job: { counts } };
  const plain: LookupStep = { kind: 'lookup', brand: step.brand, model: step.model };
  const result = await d.keepaLookup(plain.brand, plain.model, `${prefix}:lookup:${plain.model}`);
  let tokens = result.source === 'network' ? (result.keepaTokens ?? 0) : 0;
  const follow = await applyLookup(ctx, plain, result.data, result.at);
  const match = await d.store.getMatch(partKey(plain.brand, plain.model));
  if (match?.status === 'matched' && match.asin !== null) {
    tokens += await pullMatchedPrice(ctx, plain, d.keepaProduct, d.keepaBudget);
    return { status: 'matched', tokens };
  }
  if (follow) await notePageDue(ctx, plain, follow);
  return { status: match?.status === 'review' ? 'review' : 'none', tokens };
}

/**
 * Step 15: a Keepa lookup's search rows carry no price (fixtures/keepa/search-RYOBI-PCL235B.json: no stats, no csv), so
 * the listing it matched is pulled once with stats (1 token, part of KEEPA_LOOKUP_TOKEN_ESTIMATE) and saved as a refresh.
 * Nothing when the part is not matched, its listing already has a price, or the budget refuses. Returns the tokens spent.
 * The drip and the panel's Look up call it; a scan queues the same pull as a refresh step (schedulePricePull).
 */
export async function pullMatchedPrice(
  ctx: PartContext, step: Pick<LookupStep, 'brand' | 'model'>, keepaProduct: NonNullable<ScanDeps['keepaProduct']>, keepaBudget: Pick<TokenBudget, 'blockReason'>,
): Promise<number> {
  const match = await ctx.store.getMatch(partKey(step.brand, step.model));
  if (match?.status !== 'matched' || match.asin === null) return 0;
  const price = await ctx.store.getPrice(match.asin);
  if (price && price.price !== null) return 0;
  if (keepaBudget.blockReason(productTokenEstimate(ctx.settings.keepaTrackingDepth, 1)) !== null) return 0;
  const pulled = await keepaProduct(match.asin, `${ctx.prefix}:refresh:${step.model}`, ctx.settings.freshnessMs);
  await applyRefresh(ctx, { kind: 'refresh', brand: step.brand, model: step.model, asin: match.asin }, pulled.data, pulled.at);
  return pulled.source === 'network' ? (pulled.keepaTokens ?? 0) : 0;
}
