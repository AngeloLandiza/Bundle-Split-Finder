// The scan runner: Home Depot listing pages, then splits (free), then one Amazon lookup
// per new part and a refresh per stale price. Rule numbers refer to the step 2 plan,
// Task 4 ("The scan runner").

import { type Catalog, catalogEntry, decompose } from '../decompose';
import { type Candidate, pick } from '../match';
import { planScan } from '../scanPlan';
import { BudgetExceededError, RateLimitedError, SerpApiError, type SearchResult } from '../serpapi/client';
import { parseAmazonSearch, parseHomeDepotSearch } from '../serpapi/parsers';
import { looksLikeBundle, wantedFor } from './classify';
import { bundleKey, partKey } from './types';
import type { BudgetView, MatchRecord, PriceRecord, ScanJob, ScanSettings, ScanStep, ScanStore, SearchClient, StopReason } from './types';

export interface ScanDeps {
  client: SearchClient;
  budget: BudgetView;
  store: ScanStore;
  settings: ScanSettings;
  /** Clock, in epoch ms. Default Date.now. */
  now?: () => number;
  /** First part of every ledger label. Default 'scan'. The command line passes 'demo'. */
  labelPrefix?: string;
}

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
  job: ScanJob;
  /** Built from the store when the parts phase starts. */
  catalog: Catalog;
  /** Set by rule 8: no further search in this run. */
  halted: boolean;
}

/** Start a scan, or continue the newest one whose status is "running". Resolves with the finished job. */
export async function runScan(deps: ScanDeps): Promise<ScanJob> {
  const run = await startJob(deps);
  if (run.job.phase === 'listing') {
    await runQueue(run);
    await splitBundles(run);
    await planParts(run);
  }
  if (run.job.phase === 'parts') {
    run.catalog = await catalogOf(run.store);
    await runQueue(run);
  }
  return finish(run);
}

// ---------------------------------------------------------------- rule 1: start

async function startJob(deps: ScanDeps): Promise<Run> {
  const now = deps.now ?? Date.now;
  const { store, settings, budget } = deps;
  const run = (job: ScanJob): Run => ({ client: deps.client, budget, store, settings, now, prefix: deps.labelPrefix ?? 'scan', job, catalog: new Map(), halted: false });

  // An interrupted job is continued as saved: no new plan, whatever budget this run has.
  const newest = (await store.listScans())[0];
  if (newest?.status === 'running') return run(newest);

  const startedAt = now();
  // Page 1 of every query in settings order, then page 2 of every query, and so on.
  const pages: Listing[] = [];
  for (let page = 1; page <= settings.pagesPerQuery; page++) {
    for (const q of settings.queries) {
      pages.push({ kind: 'listing', q: q.q, page, filterTokens: q.filterTokens ?? null, bundlesOnly: q.bundlesOnly ?? false });
    }
  }
  const wants = await wantedParts(store, settings, startedAt);
  const plan = planScan(budget.spendable, { hdPagesWanted: pages.length, pendingLookups: wants.lookups, staleRefreshes: wants.refreshes });
  const job: ScanJob = {
    id: String(startedAt), startedAt, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'listing',
    queue: pages.slice(0, plan.hdPages), deferred: pages.slice(plan.hdPages), searchesUsed: 0,
    counts: { pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0 },
  };
  await store.putScan(job);
  return run(job);
}

// ---------------------------------------------------------------- rules 2, 3, 6, 7: paid steps

async function runQueue(run: Run): Promise<void> {
  const { job } = run;
  while (!run.halted && job.queue.length > 0) {
    const step = job.queue[0]!;
    let result: SearchResult;
    try {
      result = await send(run, step);
    } catch (err) {
      const stop = stopFor(err);
      // Anything else is not caught: the job stays "running" and the next runScan continues it.
      if (!stop) throw err;
      await halt(run, stop.reason, stop.message);
      return;
    }
    // Rule 3: the store first, then the job.
    if (step.kind === 'listing') await applyListing(run, step, result.data);
    else if (step.kind === 'lookup') await applyLookup(run, step, result.data);
    else await applyRefresh(run, step, result.data);
    // searchesUsed counts the paid steps this job saved. A search in flight when the worker
    // was interrupted was paid (the ledger has it) but its step was never saved, so it is
    // not counted; the continued job answers that step from the cache, which is free.
    if (result.source === 'network') job.searchesUsed += 1;
    job.queue.shift();
    await run.store.putScan(job);
  }
}

// ---------------------------------------------------------------- rule 8: stopping

function stopFor(err: unknown): { reason: StopReason; message: string | null } | null {
  if (err instanceof BudgetExceededError) return { reason: err.reason, message: null };
  // RateLimitedError extends SerpApiError, so it is checked first.
  if (err instanceof RateLimitedError) return { reason: 'rate_limited', message: err.message };
  if (err instanceof SerpApiError) return { reason: 'error', message: err.message };
  return null;
}

/** The failed step and the rest of the queue are deferred; no further search in this run. */
async function halt(run: Run, reason: StopReason, message: string | null): Promise<void> {
  const { job } = run;
  for (const step of job.queue) if (step.kind === 'lookup') await markWaiting(run, step);
  job.stopReason = reason;
  job.stopMessage = message;
  job.deferred.push(...job.queue);
  job.queue = [];
  run.halted = true;
  await run.store.putScan(job);
}

function send(run: Run, step: ScanStep): Promise<SearchResult> {
  const { settings, prefix, job } = run;
  if (step.kind === 'listing') {
    return run.client.search(
      { engine: 'home_depot', q: step.q, page: step.page, hd_filter_tokens: step.filterTokens ?? undefined },
      // Always reuse a page fetched earlier in the same job.
      { label: `${prefix}:listing:${step.q}:p${step.page}`, maxAgeMs: Math.max(settings.listingMaxAgeMs, run.now() - job.startedAt) },
    );
  }
  const params = { engine: 'amazon', k: `${step.brand} ${step.model}`, amazon_domain: settings.amazonDomain };
  // No maxAgeMs on a lookup: a part is paid for once.
  if (step.kind === 'lookup') return run.client.search(params, { label: `${prefix}:lookup:${step.model}` });
  return run.client.search(params, { label: `${prefix}:refresh:${step.model}`, maxAgeMs: settings.freshnessMs });
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
    if (step.bundlesOnly || looksLikeBundle(brand, row.model)) {
      const key = bundleKey(row.itemId);
      const known = await store.getBundle(key);
      await store.putBundle({
        key, retailer: 'homedepot', itemId: row.itemId, title: row.title, brand, model: row.model, upc: null,
        price: row.price, regularPrice: row.regularPrice, percentOff: row.percentOff, link: row.link, seenAt: now,
        split: known?.split ?? null,
      });
      job.counts.bundlesSeen += 1;
    } else {
      const entry = catalogEntry(brand, row.model, row.title);
      await store.putCatalogEntry({
        key: partKey(entry.brand, entry.model), brand: entry.brand, model: entry.model, title: row.title,
        kinds: entry.kinds, isKit: entry.isKit ?? false, upc: null, seenAt: now,
      });
    }
  }
  if (!hasNextPage) {
    // Later pages of this query do not exist: dropped, not deferred.
    job.queue = job.queue.filter((s) => !(s.kind === 'listing' && s.q === step.q && s.filterTokens === step.filterTokens && s.page > step.page));
  }
  job.counts.pagesFetched += 1;
}

async function applyLookup(run: Run, step: Lookup, data: unknown): Promise<void> {
  const { store, job } = run;
  const now = run.now();
  const key = partKey(step.brand, step.model);
  job.counts.lookupsDone += 1;
  // A saved queue can outlive the plan: the user may have decided this part since.
  if ((await store.getMatch(key))?.decidedBy === 'user') return;
  const candidates = parseAmazonSearch(data);
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

async function applyRefresh(run: Run, step: Refresh, data: unknown): Promise<void> {
  const { store } = run;
  // A listing missing from the results keeps its old price; the check is still recorded,
  // so the part is not paid for again until it is stale once more.
  const cand = firstWith(parseAmazonSearch(data), step.asin);
  await store.putPrice(priceSeen(step.asin, await store.getPrice(step.asin), cand, run.now()));
  run.job.counts.refreshesDone += 1;
}

/** A price record after a response was read: `cand` is the ASIN's row in it, if it was there. */
function priceSeen(asin: string, old: PriceRecord | undefined, cand: Candidate | undefined, now: number): PriceRecord {
  if (!cand) return { asin, price: old?.price ?? null, reviews: old?.reviews ?? null, seenAt: old?.seenAt ?? null, checkedAt: now };
  const price = cand.price ?? null;
  return { asin, price, reviews: cand.reviews ?? null, seenAt: price === null ? (old?.seenAt ?? null) : now, checkedAt: now };
}

const firstWith = (candidates: Candidate[], asin: string): Candidate | undefined => candidates.find((c) => c.asin === asin);
const unique = (xs: string[]): string[] => [...new Set(xs)];

// ---------------------------------------------------------------- rule 4: split (free)

async function catalogOf(store: ScanStore): Promise<Catalog> {
  const catalog: Catalog = new Map();
  for (const c of await store.listCatalog()) catalog.set(c.model, { model: c.model, brand: c.brand, kinds: c.kinds, isKit: c.isKit });
  return catalog;
}

async function splitBundles(run: Run): Promise<void> {
  const { store, job } = run;
  const now = run.now();
  const catalog = await catalogOf(store);
  let resolved = 0;
  for (const bundle of await store.listBundles()) {
    const split = decompose(bundle.brand, bundle.model, bundle.title, catalog);
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

/** The lookups and refreshes the store asks for right now, most valuable first. */
async function wantedParts(store: ScanStore, settings: ScanSettings, now: number): Promise<Wants> {
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
    const match = await store.getMatch(key);
    if (!match || match.status === 'waiting') {
      if (match) waitingSince.set(key, match.waitingSince ?? 0);
      lookups.push(key);
      steps.set(key, { kind: 'lookup', brand, model });
    } else if (match.status === 'matched' && match.asin !== null) {
      const price = await store.getPrice(match.asin);
      if (!price || now - price.checkedAt > settings.freshnessMs) {
        refreshes.push(key);
        steps.set(key, { kind: 'refresh', brand, model, asin: match.asin });
      }
    }
  }
  const bySaving = (a: string, b: string) => parts.get(b)!.saving - parts.get(a)!.saving || (a < b ? -1 : a > b ? 1 : 0);
  // Waiting parts first, oldest first; then by saving.
  const rank = (k: string) => waitingSince.get(k) ?? Infinity;
  lookups.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) || bySaving(a, b));
  refreshes.sort(bySaving);
  return { lookups, refreshes, steps };
}

async function planParts(run: Run): Promise<void> {
  const { job, budget } = run;
  const wants = await wantedParts(run.store, run.settings, run.now());
  // In the listing phase only rule 8 sets a stop reason: then nothing more is spent.
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
