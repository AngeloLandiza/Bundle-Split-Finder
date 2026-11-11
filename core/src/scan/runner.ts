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

import { type Catalog, catalogEntry } from '../decompose';
import { kitIndex, kitItemParts, kitKey, kitPageStored, kitRecords } from '../kitContents';
import { BRAND_NOT_CONFIRMED, type Candidate, type Grade, type Graded, maySparePart, modelForms, pick, type Picked } from '../match';
import { planScan } from '../scanPlan';
import { BudgetExceededError, RateLimitedError, type SearchResult } from '../serpapi/client';
import { amazonHasNextPage, parseAmazonSearch, parseHomeDepotSearch } from '../serpapi/parsers';
import { choicesOf, NONE, notKnown, ownerSplit, RESOLVED_BY_SCAN, sameChoices, splitChoices } from './answers';
import { looksLikeBundle, wantedFor } from './classify';
import { candidatesFor, listingFrom } from './listings';
import { knownModels, readSplit } from './split';
import { bundleKey, partKey, priceActive, resolvedParts } from './types';
import type {
  BudgetView, BundleRecord, CatalogCursor, CatalogRecord, ListingRecord, MatchRecord, PageOutcome, PageReading, PriceRecord, ReadPages, ReviewCandidate,
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
}

type CatalogStep = Extract<ScanStep, { kind: 'catalog' }>;
type Listing = Extract<ScanStep, { kind: 'listing' }>;
export type LookupStep = Extract<ScanStep, { kind: 'lookup' }>;
type Lookup = LookupStep;
type Refresh = Extract<ScanStep, { kind: 'refresh' }>;

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
}

/** Start a scan, or continue the newest one whose status is "running". Resolves with the finished job. */
export async function runScan(deps: ScanDeps): Promise<ScanJob> {
  const run = await startJob(deps);
  if (run.job.phase === 'listing') {
    // Amazon brand pages, then Home Depot pages: one queue.
    await runQueue(run);
    // P1: the bundles' own pages, free, once the queue is empty and before the split.
    const bundlePass = await readBundlePages(run);
    // Read once for the split and the planning pass that follows it.
    const known = await knownModels(run.store);
    run.catalog = known.catalog;
    await splitBundles(run, known.stored);
    // Step 6: then the pages of the plain kits the splits now hold, free, before the planning, which
    // looks up a kit's items only from its page. Not after Home Depot refused a page, or the reader failed.
    // The bundle pages asked for and not read still count: the two passes never ask for more than the cap.
    if (bundlePass.goOn) await readKitPages(run, bundlePass.notRead);
    await planParts(run, known.listings);
  } else if (run.job.phase === 'parts') {
    // A continued job: its lookups are judged with the models the split knew.
    run.catalog = (await knownModels(run.store)).catalog;
  }
  if (run.job.phase === 'parts') await runQueue(run);
  return finish(run);
}

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
    readPages: deps.readPages ?? null, job, catalog: new Map(), halted: false, lastFailed: false, setAside: 0, movable: [], failedBefore,
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
  const wants = await wantedParts(store, settings, startedAt, undefined, failedBefore);
  const plan = planScan(budget.spendable - catalogPages, { hdPagesWanted: pages.length, pendingLookups: wants.lookups, staleRefreshes: wants.refreshes });
  const deferred = pages.slice(plan.hdPages);
  // Ruling 52: a page that failed last job runs only if planning reaches it, never by a top-up:
  // once the other pages come from the cache, a top-up would reach it on every scan, and its
  // failure would end the scan before any lookup.
  const movable = deferred.filter((p) => !failedPages.has(pageKey(p)));
  const job: ScanJob = {
    id: String(startedAt), startedAt, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'listing',
    queue: [...catalog.slice(0, catalogPages), ...pages.slice(0, plan.hdPages)], deferred, searchesUsed: 0,
    counts: {
      pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
      catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0,
    },
  };
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
    try {
      result = await send(run, step);
    } catch (err) {
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
        await run.store.putScan(job);
        continue;
      }
      // 3 rule 2: a lookup or refresh that failed is set aside, unless the one before it failed too.
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
    await apply(run, step, result);
    // Ruling 57: a part answered is no longer failing.
    if (step.kind === 'lookup' || step.kind === 'refresh') {
      const answered = partKey(step.brand, step.model);
      keepFailing(job, (k) => k !== answered);
    }
    // searchesUsed counts the paid steps this job saved. A search in flight when the worker
    // was interrupted was paid (the ledger has it) but its step was never saved, so it is
    // not counted; the continued job answers that step from the cache, which is free.
    if (result.source === 'network') job.searchesUsed += 1;
    job.queue.shift();
    if (result.source === 'cache') topUp(run);
    await run.store.putScan(job);
  }
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
      return sendLookup(run, step);
    case 'refresh':
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
async function apply(run: Run, step: ScanStep, result: SearchResult): Promise<void> {
  const { data, at } = result;
  switch (step.kind) {
    case 'catalog':
      return applyCatalog(run, step, data, at);
    case 'listing':
      return applyListing(run, step, data, at);
    case 'lookup':
      return applyLookup(run, step, data, at);
    case 'refresh':
      return applyRefresh(run, step, data, at);
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
export async function applyLookup(ctx: PartContext, step: LookupStep, data: unknown, at: number): Promise<void> {
  const { store, job } = ctx;
  const now = ctx.now();
  const key = partKey(step.brand, step.model);
  job.counts.lookupsDone += 1;
  const candidates = parseAmazonSearch(data);
  await saveListings(ctx, candidates, at);
  // A saved queue can outlive the plan: the user may have decided this part since.
  if ((await store.getMatch(key))?.decidedBy === 'user') return;
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
 * how many of all the listings show the model with the brand not confirmed; SPARE_PART_NOTE when a
 * listing kept says "Replacement" or "OEM"; and how many were left out.
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
  if (listed.some((c) => maySparePart(c.title))) notes.push(SPARE_PART_NOTE);
  if (all.length > listed.length) notes.push(`${all.length - listed.length} more listing(s) not shown`);
  return { reason: notes.join('; '), listed };
}

/**
 * The match question for a part, opened at `now` and counted, unless the part already has one
 * (open or answered), which is left as it is. Its title is the catalog's.
 */
export async function openMatchReview(ctx: PartContext, part: Part, reason: string, candidates: ReviewCandidate[], now: number): Promise<void> {
  const { store, job } = ctx;
  const id = `match:${part.key}`;
  if (await store.getReview(id)) return;
  await store.putReview({
    id, kind: 'match', subject: part.key, brand: part.brand, model: part.model, title: (await store.getCatalogEntry(part.key))?.title ?? null,
    reason, candidates, choices: [], openedAt: now, answer: null, answeredAt: null,
  });
  job.counts.reviewsOpened += 1;
}

async function applyRefresh(run: Run, step: Refresh, data: unknown, at: number): Promise<void> {
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

/** Ids the reader is given: a Home Depot item id is digits. Stored data is untrusted, and the id goes into a page address. */
const ITEM_ID = /^\d+$/;

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
  if (unread.length === 0 || run.shouldStop()) return { goOn: true, notRead: 0 };
  return readInto(run, unread.map((b) => ({ itemId: b.itemId, save: (page) => store.putBundle({ ...b, page }) })));
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
async function readKitPages(run: Run, bundleNotRead: number): Promise<void> {
  const { store } = run;
  if (!run.readPages) return;
  const room = Math.max(0, pagesLeft(run) - bundleNotRead);
  if (room === 0 || run.shouldStop()) return;
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
    for (const part of resolvedParts(b)) {
      const kitId = kitKey(part.brand, part.model);
      if (judged.has(kitId)) continue;
      judged.add(kitId);
      if (bundlesOf(part.brand, part.model).length > 0 || kitPageStored(allOf(part.brand, part.model), part.brand, part.model)) continue;
      const kit = kitsOf(part.brand, part.model).find((k) => !k.page && typeof k.itemId === 'string' && ITEM_ID.test(k.itemId) && !asked.has(k.itemId));
      if (!kit) continue;
      asked.add(kit.itemId!);
      wanted.push(kit);
    }
  }
  if (wanted.length === 0) return;
  await readInto(run, wanted.slice(0, room).map((k) => ({ itemId: k.itemId!, save: (page) => store.putCatalogEntry({ ...k, page }) })));
}

const newestFirst = (a: BundleRecord, b: BundleRecord): number => b.seenAt - a.seenAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** P1 to P4 for one list of pages: one call to readPages, each page read saved and counted, problems noted, then the job saved. */
async function readInto(run: Run, targets: PageTarget[]): Promise<PassResult> {
  const { store, job, readPages } = run;
  // Only the reader is inside the try. An error from the store is not caught: the job stays
  // "running" and the next runScan continues it, reading only the pages still unread.
  let outcomes: PageOutcome[];
  try {
    outcomes = await readPages!(targets.map((t) => t.itemId));
  } catch (err) {
    noteProblem(job, `Reading Home Depot pages failed: ${(err instanceof Error && err.message) || String(err)}`);
    await store.putScan(job);
    return { goOn: false, notRead: targets.length };
  }
  const readAt = run.now();
  const asked = new Map(targets.map((t) => [t.itemId, t]));
  let refused = false;
  let unreadable = false;
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
      refused = true;
    } else if (outcome.kind === 'unreadable') {
      unreadable = true;
    }
  }
  if (refused) noteProblem(job, 'Home Depot refused a page; the rest are read next scan.');
  else if (unreadable) {
    noteProblem(job, anyRead ? 'A Home Depot page could not be read.' : 'No Home Depot page could be read.');
  }
  await store.putScan(job);
  return { goOn: !refused, notRead: targets.length - read };
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

/** `stored`: the stored catalog alone; `run.catalog` adds the listings' models. */
async function splitBundles(run: Run, stored: Catalog): Promise<void> {
  const { store, job, catalog } = run;
  const now = run.now();
  let resolved = 0;
  for (const bundle of await store.listBundles()) {
    const id = `split:${bundle.key}`;
    const item = await store.getReview(id);
    // The owner's answer comes first (step 5): parts the owner chose stand instead of any reading,
    // and "none" keeps the bundle in review whatever the readings now say. Otherwise P5: the
    // model number's split, then the bundle's own page, when it was read.
    const owner = ownerSplit(item);
    const read = () => readSplit(bundle, { stored, catalog });
    const split = owner === null ? read() : owner === NONE ? notKnown(read()) : owner;
    await store.putBundle({ ...bundle, split });
    if (split.status === 'resolved') {
      resolved += 1;
      if (item && item.answer === null) await store.putReview({ ...item, answer: RESOLVED_BY_SCAN, answeredAt: now });
      continue;
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
      job.counts.reviewsOpened += 1;
    } else if (item.answer === null && (item.reason !== reason || !sameChoices(choicesOf(item), choices))) {
      // Still open: a new reading, the same question, so openedAt stays.
      await store.putReview({ ...item, reason, choices });
    }
  }
  job.counts.bundlesResolved = resolved;
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
  steps: Map<string, Lookup | Refresh>;
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
}

/**
 * Rule 5: the parts of every resolved bundle, by part key, each with the largest saving among its
 * bundles; then (step 6) the items with a model number of every kit those bundles' options split,
 * that no split holds itself, with the kits that hold them. A kit item that is also a part of some
 * split is that part.
 */
export async function bundleParts(store: ScanStore): Promise<Map<string, BundlePart>> {
  const parts = new Map<string, BundlePart>();
  const items = new Map<string, BundlePart>();
  const bundles = await store.listBundles();
  // Step 6: a kit's page may be on a bundle record or on its catalog entry (kitRecords).
  const recordsOf = kitIndex(kitRecords(bundles, await store.listCatalog()));
  const add = (into: Map<string, BundlePart>, part: Part, saving: number, kit: string | null) => {
    const seen = into.get(part.key);
    if (!seen) into.set(part.key, { key: part.key, brand: part.brand, model: part.model, saving, kits: kit === null ? [] : [kit] });
    else {
      seen.saving = Math.max(seen.saving, saving);
      if (kit !== null && !seen.kits.includes(kit)) seen.kits.push(kit);
    }
  };
  for (const b of bundles) {
    const saving = (b.regularPrice ?? b.price ?? 0) - (b.price ?? 0);
    for (const part of resolvedParts(b)) add(parts, part, saving, null);
    for (const item of kitItemParts(b, recordsOf)) add(items, item, saving, item.kit);
  }
  for (const [key, item] of items) if (!parts.has(key)) parts.set(key, item);
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
 * `fromListings` (2c rule 5) is tried first for every part that would need a lookup; the
 * match it returns, if any, stands in for one.
 */
async function wantedParts(
  store: ScanStore, settings: ScanSettings, now: number, fromListings?: (part: Part) => Promise<MatchRecord | null>,
  failedBefore: string[] = [],
): Promise<Wants> {
  const parts = await bundleParts(store);
  const lookups: string[] = [];
  const refreshes: string[] = [];
  const itemLookups: string[] = [];
  const itemRefreshes: string[] = [];
  const waitingSince = new Map<string, number>();
  const steps = new Map<string, Lookup | Refresh>();
  // 2c rule 5 first, for every part, kit items too whatever their kit's state: a saved listing costs
  // nothing. The kits' own matches are final before any kit's items are judged below.
  const matches = new Map<string, MatchRecord | undefined>();
  for (const [key, { brand, model }] of parts) {
    let match = await store.getMatch(key);
    if (fromListings && lookupWanted(match)) match = (await fromListings({ key, brand, model })) ?? match;
    matches.set(key, match);
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

/** `listings`: the saved listings, read once for this planning pass. */
async function planParts(run: Run, listings: ListingRecord[]): Promise<void> {
  const { job, budget } = run;
  // 2c rule 5 runs even when the listing phase stopped: it spends nothing.
  const wants = await wantedParts(run.store, run.settings, run.now(), (part) => matchFromListings(run, listings, part), run.failedBefore);
  // A stop asked for during the last listing search, when the queue emptied as usual (QA M7), is a stop on request too.
  if (job.stopReason === null && run.shouldStop()) job.stopReason = 'user';
  // In the listing phase only rule 8 or a stop on request (3 rule 1) sets a stop reason: then nothing more is spent.
  const allowance = job.stopReason === null ? budget.spendable : 0;
  const plan = planScan(allowance, { hdPagesWanted: 0, pendingLookups: wants.lookups, staleRefreshes: wants.refreshes });
  // Step 6: kit items only from what every other lookup and refresh leaves.
  const room = Math.max(0, Math.floor(allowance) - plan.searches);
  const items = wants.items.slice(0, room);
  const toSteps = (keys: string[]) => keys.map((k) => wants.steps.get(k)!);
  const later = [...toSteps(plan.deferredLookups), ...toSteps(plan.deferredRefreshes), ...toSteps(wants.items.slice(items.length))];
  // Ruling 57: a failing part no longer wanted (matched since, decided, or in no bundle) is dropped.
  keepFailing(job, (k) => wants.steps.has(k));
  for (const step of later) if (step.kind === 'lookup') await markWaiting(run, step);
  job.queue = [...toSteps(plan.lookups), ...toSteps(plan.refreshes), ...toSteps(items)];
  job.deferred.push(...later);
  // Ruling 48: from now on only the parts phase's own deferred steps may move into the queue.
  run.movable = [...later];
  // Names the limit that made work wait. It does not stop the queue just planned.
  if (job.deferred.length > 0 && job.stopReason === null) job.stopReason = budget.blockReason(budget.spendable + 1);
  job.phase = 'parts';
  await run.store.putScan(job);
}

/**
 * Ruling 70: the match a RYOBI part takes from its other written form (PCL515 for PCL515B, or the
 * reverse, by sameModel), which is the same product: that form's record when it holds a listing,
 * matched automatically or chosen by the owner, or the owner's "none". Null otherwise, and always
 * for DEWALT. `matchOf` reads a stored match by part key.
 */
export function sharedMatch(part: Pick<Part, 'key' | 'brand' | 'model'>, matchOf: (key: string) => MatchRecord | undefined): MatchRecord | null {
  for (const form of modelForms(part.brand, part.model)) {
    const key = partKey(part.brand, form);
    if (key === part.key) continue;
    const m = matchOf(key);
    if (m && ((m.status === 'matched' && m.asin !== null) || (m.decidedBy === 'user' && m.status === 'none'))) return m;
  }
  return null;
}

/** The part keys of a RYOBI part's other written forms (Ruling 70); none for DEWALT. */
const otherFormKeys = (part: Pick<Part, 'key' | 'brand' | 'model'>): string[] =>
  modelForms(part.brand, part.model).map((f) => partKey(part.brand, f)).filter((k) => k !== part.key);

/**
 * 2c rule 5: the saved listings that carry the part's model, judged by pick() exactly as a
 * lookup's results are. A chosen listing is saved as a lookup saves it, priced from the
 * saved listings. Otherwise null: the part is left to a paid lookup, which alone may open a
 * review item. Before the listings, Ruling 70: a match the part's other written form holds
 * (sharedMatch) is saved as the part's own, decided by whoever decided it, and no lookup is wanted.
 */
export async function matchFromListings(ctx: PartContext, listings: ListingRecord[], part: Part): Promise<MatchRecord | null> {
  const { store, job } = ctx;
  const others = new Map<string, MatchRecord | undefined>();
  for (const key of otherFormKeys(part)) others.set(key, await store.getMatch(key));
  const shared = sharedMatch(part, (key) => others.get(key));
  if (shared) {
    const copy: MatchRecord = { ...shared, key: part.key, brand: part.brand, model: part.model, updatedAt: ctx.now(), waitingSince: null };
    await store.putMatch(copy);
    if (copy.status === 'matched') job.counts.partsMatched += 1;
    return copy;
  }
  const picked = pickFromListings(part, ctx.catalog, listings);
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
    decidedBy: 'auto', updatedAt: ctx.now(), waitingSince: null,
  };
  await store.putMatch(match);
  job.counts.partsFromCatalog += 1;
  job.counts.partsMatched += 1;
  return match;
}

/** 2c rule 5's judgement, writing nothing: a listing is chosen when matchFromListings would match the part. */
export const pickFromListings = (part: Pick<Part, 'brand' | 'model'>, catalog: Catalog, listings: ListingRecord[]): Picked =>
  pick(wantedFor(part.brand, part.model, catalog), candidatesFor(part.brand, part.model, listings));

/** A lookup that did not run: the part goes first next scan. Keeps the first waitingSince. */
export async function markWaiting(ctx: Pick<PartContext, 'store' | 'now'>, step: LookupStep): Promise<void> {
  const key = partKey(step.brand, step.model);
  const old = await ctx.store.getMatch(key);
  if (old?.decidedBy === 'user') return;
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
  if (job.deferred.length === 0 && (job.stopReason === 'run_cap' || job.stopReason === 'reserve' || job.stopReason === 'hourly_limit')) job.stopReason = null;
  job.phase = 'finish';
  job.status = job.stopReason !== null || job.deferred.length > 0 ? 'stopped' : 'done';
  job.finishedAt = run.now();
  await run.store.putScan(job);
  return job;
}
