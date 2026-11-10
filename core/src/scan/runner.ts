// The scan runner: a few pages of the brands' own Amazon listings, then Home Depot listing
// pages, then splits (free), then one Amazon lookup per new part that no saved listing
// answers and a refresh per stale price. "Rule n" refers to the step 2 plan, Task 4 ("The
// scan runner"); "2c rule n" to the step 2c plan, Task 2 ("The catalog phase"); "3 rule n"
// to the step 3 plan, Task 3 ("Runner: stop on request, and one failed lookup does not end a scan").

import { type Catalog, catalogEntry, type Decomposition, decompose, kindsFromTitle } from '../decompose';
import { type Candidate, pick } from '../match';
import { planScan } from '../scanPlan';
import { BudgetExceededError, RateLimitedError, type SearchResult } from '../serpapi/client';
import { amazonHasNextPage, parseAmazonSearch, parseHomeDepotSearch } from '../serpapi/parsers';
import { looksLikeBundle, wantedFor } from './classify';
import { candidatesFor, listingFrom } from './listings';
import { bundleKey, partKey } from './types';
import type {
  BudgetView, BundleRecord, CatalogCursor, ListingRecord, MatchRecord, PriceRecord, ScanJob, ScanSettings, ScanStep, ScanStore, SearchClient, StopReason,
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
}

type CatalogStep = Extract<ScanStep, { kind: 'catalog' }>;
type Listing = Extract<ScanStep, { kind: 'listing' }>;
type Lookup = Extract<ScanStep, { kind: 'lookup' }>;
type Refresh = Extract<ScanStep, { kind: 'refresh' }>;

interface Run {
  client: SearchClient;
  budget: BudgetView;
  store: ScanStore;
  settings: ScanSettings;
  now: () => number;
  prefix: string;
  shouldStop: () => boolean;
  job: ScanJob;
  /** The models the splitter and wantedFor know (2c rule 4). Built when the listing queue is empty, or when a continued job starts in the parts phase. */
  catalog: Catalog;
  /** Set by rule 8 and 3 rules 1 and 2: no further search in this run. */
  halted: boolean;
  /** 3 rule 2: the last lookup or refresh of this run failed, and no paid step has succeeded since. */
  lastFailed: boolean;
  /** 3 rule 2: steps this run set aside after a failure. They lead `deferred`, in the order they failed. */
  setAside: number;
}

/** Start a scan, or continue the newest one whose status is "running". Resolves with the finished job. */
export async function runScan(deps: ScanDeps): Promise<ScanJob> {
  const run = await startJob(deps);
  if (run.job.phase === 'listing') {
    // Amazon brand pages, then Home Depot pages: one queue.
    await runQueue(run);
    // Read once for the split and the planning pass that follows it.
    const known = await knownModels(run.store);
    run.catalog = known.catalog;
    await splitBundles(run, known.stored);
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
  const run = (job: ScanJob): Run => ({
    client: deps.client, budget, store, settings, now, prefix: deps.labelPrefix ?? 'scan', shouldStop: deps.shouldStop ?? (() => false),
    job, catalog: new Map(), halted: false, lastFailed: false, setAside: 0,
  });

  // An interrupted job is continued as saved: no new plan, whatever budget this run has.
  const newest = (await store.listScans())[0];
  if (newest?.status === 'running') return run(newest);

  const startedAt = now();
  // 2c rule 1: brand pages first, from at most a fifth of the allowance, measured before
  // anything is spent. Pages that do not fit are dropped, not deferred: the cursor keeps the place.
  const catalog = await catalogWanted(store, settings);
  const catalogPages = Math.min(catalog.length, Math.floor(budget.spendable * 0.2));
  // Page 1 of every query in settings order, then page 2 of every query, and so on.
  const pages: Listing[] = [];
  for (let page = 1; page <= settings.pagesPerQuery; page++) {
    for (const q of settings.queries) {
      pages.push({ kind: 'listing', q: q.q, page, filterTokens: q.filterTokens ?? null, bundlesOnly: q.bundlesOnly ?? false });
    }
  }
  const wants = await wantedParts(store, settings, startedAt);
  const plan = planScan(budget.spendable - catalogPages, { hdPagesWanted: pages.length, pendingLookups: wants.lookups, staleRefreshes: wants.refreshes });
  const job: ScanJob = {
    id: String(startedAt), startedAt, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'listing',
    queue: [...catalog.slice(0, catalogPages), ...pages.slice(0, plan.hdPages)], deferred: pages.slice(plan.hdPages), searchesUsed: 0,
    counts: {
      pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
      catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0,
    },
  };
  await store.putScan(job);
  return run(job);
}

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
    // searchesUsed counts the paid steps this job saved. A search in flight when the worker
    // was interrupted was paid (the ledger has it) but its step was never saved, so it is
    // not counted; the continued job answers that step from the cache, which is free.
    if (result.source === 'network') job.searchesUsed += 1;
    job.queue.shift();
    await run.store.putScan(job);
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
  if (run.setAside === 0) job.stopMessage = job.stopMessage === null ? message : `${job.stopMessage} ${message}`;
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
      // No maxAgeMs on a lookup: a part is paid for once.
      return run.client.search(amazonPart(run, step), { label: `${prefix}:lookup:${step.model}` });
    case 'refresh':
      return run.client.search(amazonPart(run, step), { label: `${prefix}:refresh:${step.model}`, maxAgeMs: settings.freshnessMs });
    default:
      return unknownStep(step);
  }
}

const amazonPart = (run: Run, step: Lookup | Refresh) => ({ engine: 'amazon', k: `${step.brand} ${step.model}`, amazon_domain: run.settings.amazonDomain });

/** Rule 3 and 2c rule 2: what a step's response changes in the store. */
async function apply(run: Run, step: ScanStep, result: SearchResult): Promise<void> {
  const { data, source } = result;
  switch (step.kind) {
    case 'catalog':
      return applyCatalog(run, step, data, source);
    case 'listing':
      return applyListing(run, step, data);
    case 'lookup':
      return applyLookup(run, step, data, source);
    case 'refresh':
      return applyRefresh(run, step, data, source);
    default:
      return unknownStep(step);
  }
}

/** Every step kind is handled above: a new kind does not compile until it is. */
function unknownStep(step: never): never {
  throw new Error(`Unknown scan step: ${JSON.stringify(step)}`);
}

/** 2c rule 2: save every row of a brand page, then move the brand's cursor on from this page. */
async function applyCatalog(run: Run, step: CatalogStep, data: unknown, source: Source): Promise<void> {
  const { store, job } = run;
  const now = run.now();
  await saveListings(run, parseAmazonSearch(data), now, source);
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

async function applyListing(run: Run, step: Listing, data: unknown): Promise<void> {
  const { store, job } = run;
  const now = run.now();
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
      await store.putBundle({
        key, retailer: 'homedepot', itemId: row.itemId, title: row.title, brand, model: row.model, upc: known?.upc ?? null,
        price: row.price, regularPrice: row.regularPrice, percentOff: row.percentOff, link: row.link, seenAt: now,
        split: known?.split ?? null,
      });
      job.counts.bundlesSeen += 1;
    } else {
      const entry = catalogEntry(brand, row.model, row.title);
      const key = partKey(entry.brand, entry.model);
      const known = await store.getCatalogEntry(key);
      await store.putCatalogEntry({
        key, brand: entry.brand, model: entry.model, title: row.title,
        kinds: entry.kinds, isKit: entry.isKit ?? false, upc: known?.upc ?? null, seenAt: now,
      });
    }
  }
  if (!hasNextPage) {
    // Later pages of this query do not exist: dropped, not deferred.
    job.queue = job.queue.filter((s) => !(s.kind === 'listing' && s.q === step.q && s.filterTokens === step.filterTokens && s.page > step.page));
  }
  job.counts.pagesFetched += 1;
}

async function applyLookup(run: Run, step: Lookup, data: unknown, source: Source): Promise<void> {
  const { store, job } = run;
  const now = run.now();
  const key = partKey(step.brand, step.model);
  job.counts.lookupsDone += 1;
  const candidates = parseAmazonSearch(data);
  await saveListings(run, candidates, now, source);
  // A saved queue can outlive the plan: the user may have decided this part since.
  if ((await store.getMatch(key))?.decidedBy === 'user') return;
  const picked = pick(wantedFor(step.brand, step.model, run.catalog), candidates);
  const base = { key, brand: step.brand, model: step.model, decidedBy: 'auto' as const, updatedAt: now, waitingSince: null };
  let match: MatchRecord;
  if (picked.chosen) {
    const asin = picked.chosen.asin;
    const alternatives = unique(picked.alternatives.map((g) => g.asin)).filter((a) => a !== asin);
    match = { ...base, status: 'matched', asin, grade: picked.chosen.grade, alternatives };
    for (const a of [asin, ...alternatives]) await store.putPrice(priceSeen(a, await store.getPrice(a), firstWith(candidates, a), now));
    job.counts.partsMatched += 1;
  } else if (picked.review.length > 0) {
    match = { ...base, status: 'review', asin: null, grade: null, alternatives: [] };
    const id = `match:${key}`;
    if (!(await store.getReview(id))) {
      // One candidate per ASIN: a search can list the same ASIN twice.
      const listed = unique(picked.review.map((g) => g.asin)).map((a) => {
        const c = firstWith(candidates, a)!;
        return { asin: a, title: c.title, price: c.price ?? null, reviews: c.reviews ?? null, reasons: picked.review.find((g) => g.asin === a)!.reasons };
      });
      await store.putReview({
        id, kind: 'match', subject: key, brand: step.brand, model: step.model, title: (await store.getCatalogEntry(key))?.title ?? null,
        reason: `${listed.length} listing(s) show the model number, but the brand is not confirmed`,
        candidates: listed, openedAt: now, answer: null, answeredAt: null,
      });
      job.counts.reviewsOpened += 1;
    }
  } else {
    match = { ...base, status: 'none', asin: null, grade: null, alternatives: [] };
  }
  await store.putMatch(match);
}

async function applyRefresh(run: Run, step: Refresh, data: unknown, source: Source): Promise<void> {
  const { store } = run;
  const now = run.now();
  const candidates = parseAmazonSearch(data);
  await saveListings(run, candidates, now, source);
  // A listing missing from the results keeps its old price; the check is still recorded,
  // so the part is not paid for again until it is stale once more.
  const cand = firstWith(candidates, step.asin);
  await store.putPrice(priceSeen(step.asin, await store.getPrice(step.asin), cand, now));
  run.job.counts.refreshesDone += 1;
}

type Source = SearchResult['source'];

/**
 * Rules 6 and 7: every row of an Amazon response whose brand is scanned is saved as a listing.
 * A response from the cache may be days old, and how old is not known here: a listing already
 * stored keeps its price, seenAt and checkedAt, so an old price never looks fresh. A listing
 * not stored yet is saved as from the network.
 */
async function saveListings(run: Run, candidates: Candidate[], now: number, source: Source): Promise<void> {
  const { store, settings, job } = run;
  for (const c of candidates) {
    const old = await store.getListing(c.asin);
    let record = listingFrom(c, settings.brands, now, old);
    if (record === null) continue;
    if (source === 'cache' && old) record = { ...record, price: old.price, seenAt: old.seenAt, checkedAt: old.checkedAt };
    await store.putListing(record);
    // A row seen in two responses is counted twice; the store holds one record per ASIN.
    job.counts.listingsSaved += 1;
  }
}

/** A price record after a response was read: `cand` is the ASIN's row in it, if it was there. */
function priceSeen(asin: string, old: PriceRecord | undefined, cand: Candidate | undefined, now: number): PriceRecord {
  if (!cand) return { asin, price: old?.price ?? null, reviews: old?.reviews ?? null, seenAt: old?.seenAt ?? null, checkedAt: now };
  const price = cand.price ?? null;
  return { asin, price, reviews: cand.reviews ?? null, seenAt: price === null ? (old?.seenAt ?? null) : now, checkedAt: now };
}

const firstWith = (candidates: Candidate[], asin: string): Candidate | undefined => candidates.find((c) => c.asin === asin);
const unique = (xs: string[]): string[] => [...new Set(xs)];

// ---------------------------------------------------------------- rule 4 and 2c rule 4: split (free)

interface KnownModels {
  /** The stored catalog alone: the models Home Depot's own rows showed. */
  stored: Catalog;
  /** The stored catalog plus an entry for every model in a saved listing's title (2c rule 4). */
  catalog: Catalog;
  listings: ListingRecord[];
}

/**
 * 2c rule 4: the stored catalog, plus an entry for every model in a saved listing's title.
 * A stored entry wins over one read from a listing. A DEWALT model read from a listing that
 * starts with DCK is a kit, whatever its Amazon title says, so the splitter never offers it as
 * a bonus tool. The one source of the catalog for the split and for the parts phase.
 */
async function knownModels(store: ScanStore): Promise<KnownModels> {
  const listings = await store.listListings();
  const stored: Catalog = new Map();
  for (const c of await store.listCatalog()) stored.set(c.model, { model: c.model, brand: c.brand, kinds: c.kinds, isKit: c.isKit });
  const catalog: Catalog = new Map();
  // Listings come sorted by ASIN: when two titles name the same model, the first ASIN's is kept.
  for (const l of listings) {
    for (const model of l.models) {
      if (catalog.has(model)) continue;
      const isKit = (l.brand === 'DEWALT' && model.startsWith('DCK')) || (catalogEntry(l.brand, model, l.title).isKit ?? false);
      catalog.set(model, { model, brand: l.brand, kinds: kindsFromTitle(l.title), isKit });
    }
  }
  for (const [model, entry] of stored) catalog.set(model, entry);
  return { stored, catalog, listings };
}

/**
 * The split of one bundle. Models read from Amazon titles may not make a DEWALT short code
 * resolve by guesswork: the stored catalog is tried alone first, and a resolved split stands.
 * Otherwise the split with the listings' models is taken only for RYOBI, whose patterns spell
 * every part out, or for DEWALT when it names exactly two parts (the kit and one bonus item, so
 * no short code was glued together from pieces). In every other case the first result stands.
 */
function splitBundle(bundle: BundleRecord, stored: Catalog, catalog: Catalog): Decomposition {
  const first = decompose(bundle.brand, bundle.model, bundle.title, stored);
  if (first.status === 'resolved') return first;
  const second = decompose(bundle.brand, bundle.model, bundle.title, catalog);
  if (second.status !== 'resolved') return first;
  const brand = bundle.brand.trim().toUpperCase();
  return brand === 'RYOBI' || (brand === 'DEWALT' && second.components.length === 2) ? second : first;
}

/** `stored`: the stored catalog alone; `run.catalog` adds the listings' models. */
async function splitBundles(run: Run, stored: Catalog): Promise<void> {
  const { store, job, catalog } = run;
  const now = run.now();
  let resolved = 0;
  for (const bundle of await store.listBundles()) {
    const split = splitBundle(bundle, stored, catalog);
    await store.putBundle({ ...bundle, split });
    const id = `split:${bundle.key}`;
    const item = await store.getReview(id);
    if (split.status === 'resolved') {
      resolved += 1;
      if (item && item.answer === null) await store.putReview({ ...item, answer: 'resolved by a later scan', answeredAt: now });
    } else if (!item) {
      await store.putReview({
        id, kind: 'split', subject: bundle.key, brand: bundle.brand, model: bundle.model, title: bundle.title,
        reason: split.notes.join('; '), candidates: [], openedAt: now, answer: null, answeredAt: null,
      });
      job.counts.reviewsOpened += 1;
    }
  }
  job.counts.bundlesResolved = resolved;
}

// ---------------------------------------------------------------- rule 5: plan the parts

interface Wants {
  /** Part keys, in the order they should be paid for. */
  lookups: string[];
  refreshes: string[];
  steps: Map<string, Lookup | Refresh>;
}

interface Part {
  key: string;
  brand: string;
  model: string;
}

/** Rule 5: a lookup is wanted for a part with no match, or one left waiting, never for a user's decision. */
const lookupWanted = (match: MatchRecord | undefined): boolean => !match || (match.status === 'waiting' && match.decidedBy !== 'user');

/**
 * The lookups and refreshes the store asks for right now, most valuable first.
 * `fromListings` (2c rule 5) is tried first for every part that would need a lookup; the
 * match it returns, if any, stands in for one.
 */
async function wantedParts(
  store: ScanStore, settings: ScanSettings, now: number, fromListings?: (part: Part) => Promise<MatchRecord | null>,
): Promise<Wants> {
  // The parts of every resolved bundle, each with the largest saving among its bundles.
  const parts = new Map<string, { brand: string; model: string; saving: number }>();
  for (const b of await store.listBundles()) {
    if (b.split?.status !== 'resolved') continue;
    const saving = (b.regularPrice ?? b.price ?? 0) - (b.price ?? 0);
    for (const component of b.split.components) {
      const key = partKey(b.brand, component);
      const seen = parts.get(key);
      if (!seen) parts.set(key, { brand: b.brand.trim().toUpperCase(), model: component.trim().toUpperCase(), saving });
      else seen.saving = Math.max(seen.saving, saving);
    }
  }
  const lookups: string[] = [];
  const refreshes: string[] = [];
  const waitingSince = new Map<string, number>();
  const steps = new Map<string, Lookup | Refresh>();
  for (const [key, { brand, model }] of parts) {
    let match = await store.getMatch(key);
    if (fromListings && lookupWanted(match)) match = (await fromListings({ key, brand, model })) ?? match;
    // Never a lookup for a match the user decided, even one left waiting.
    if (lookupWanted(match)) {
      if (match) waitingSince.set(key, match.waitingSince ?? 0);
      lookups.push(key);
      steps.set(key, { kind: 'lookup', brand, model });
    } else if (match?.status === 'matched' && match.asin !== null) {
      // Also a part just matched from a saved listing: its price is the listing's, as old as that.
      const price = await store.getPrice(match.asin);
      if (!price || now - price.checkedAt > settings.freshnessMs) {
        refreshes.push(key);
        steps.set(key, { kind: 'refresh', brand, model, asin: match.asin });
      }
    }
  }
  const bySaving = (a: string, b: string) => parts.get(b)!.saving - parts.get(a)!.saving || (a < b ? -1 : a > b ? 1 : 0);
  // Waiting parts first, oldest first; then by saving. A part whose lookup failed last scan
  // takes its place like any other: it was set aside then, so it blocks nothing (3 rule 4).
  const rank = (k: string) => waitingSince.get(k) ?? Infinity;
  lookups.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) || bySaving(a, b));
  refreshes.sort(bySaving);
  return { lookups, refreshes, steps };
}

/** `listings`: the saved listings, read once for this planning pass. */
async function planParts(run: Run, listings: ListingRecord[]): Promise<void> {
  const { job, budget } = run;
  // 2c rule 5 runs even when the listing phase stopped: it spends nothing.
  const wants = await wantedParts(run.store, run.settings, run.now(), (part) => matchFromListings(run, listings, part));
  // In the listing phase only rule 8 or a stop on request (3 rule 1) sets a stop reason: then nothing more is spent.
  const allowance = job.stopReason === null ? budget.spendable : 0;
  const plan = planScan(allowance, { hdPagesWanted: 0, pendingLookups: wants.lookups, staleRefreshes: wants.refreshes });
  const toSteps = (keys: string[]) => keys.map((k) => wants.steps.get(k)!);
  const later = [...toSteps(plan.deferredLookups), ...toSteps(plan.deferredRefreshes)];
  for (const step of later) if (step.kind === 'lookup') await markWaiting(run, step);
  job.queue = [...toSteps(plan.lookups), ...toSteps(plan.refreshes)];
  job.deferred.push(...later);
  // Names the limit that made work wait. It does not stop the queue just planned.
  if (job.deferred.length > 0 && job.stopReason === null) job.stopReason = budget.blockReason(budget.spendable + 1);
  job.phase = 'parts';
  await run.store.putScan(job);
}

/**
 * 2c rule 5: the saved listings that carry the part's model, judged by pick() exactly as a
 * lookup's results are. A chosen listing is saved as a lookup saves it, priced from the
 * saved listings. Otherwise null: the part is left to a paid lookup, which alone may open a
 * review item.
 */
async function matchFromListings(run: Run, listings: ListingRecord[], part: Part): Promise<MatchRecord | null> {
  const { store, job } = run;
  const picked = pick(wantedFor(part.brand, part.model, run.catalog), candidatesFor(part.brand, part.model, listings));
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
    decidedBy: 'auto', updatedAt: run.now(), waitingSince: null,
  };
  await store.putMatch(match);
  job.counts.partsFromCatalog += 1;
  job.counts.partsMatched += 1;
  return match;
}

/** A lookup that did not run: the part goes first next scan. Keeps the first waitingSince. */
async function markWaiting(run: Run, step: Lookup): Promise<void> {
  const key = partKey(step.brand, step.model);
  const old = await run.store.getMatch(key);
  if (old?.decidedBy === 'user') return;
  const now = run.now();
  await run.store.putMatch({
    key, brand: step.brand, model: step.model, status: 'waiting', asin: null, grade: null, alternatives: [],
    decidedBy: 'auto', updatedAt: now, waitingSince: old?.waitingSince ?? now,
  });
}

// ---------------------------------------------------------------- rule 10: finish

async function finish(run: Run): Promise<ScanJob> {
  const { job } = run;
  job.phase = 'finish';
  job.status = job.stopReason !== null || job.deferred.length > 0 ? 'stopped' : 'done';
  job.finishedAt = run.now();
  await run.store.putScan(job);
  return job;
}
