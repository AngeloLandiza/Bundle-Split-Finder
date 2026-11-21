// npm run validate: acceptance criterion 6 over the validation set (fixtures/validation/).
//
//   --dry-run   free: opens no client. Answers only from the disk cache (cache/), and lists every
//               search the run needs that is not cached, and the inputs it still wants.
//   --max N     spends up to N searches (1 to 42) from the validation bucket, through openDevClient.
//               Writes the results and every response the run used.
//   --replay    no network at all: answers only from fixtures/validation/responses/. Rewrites the
//               results. The test (core/test/validation.test.ts) runs the same pipeline this way.
//
// Every argument is checked before a client is opened, so a typo can never spend.
//
// The pipeline is the tool's own code, nothing else decides a split or a match:
//   1. The brands' Amazon pages, by the scan's own catalog step (runScan with no Home Depot query),
//      read only from what is already cached: never paid for here.
//   2. Kit pages from kit-pages-<date>.json, stored as a scan stores a kit's catalog entry and its page.
//   3. Each pass: every bundle page through notePage (stored, split, matched from saved listings, as
//      a page visit does); the owner's split answers through applyReviewAnswer; then the side
//      panel's Look up (runPaid, lookUp) for every part still waiting, kit items included, in one
//      press, which orders them by lookupOrder. Passes go on while a pass gets a new answer.
//      Before each Look up, as a scan reads them before its lookups (step 9), Home Depot's own prices
//      for the parts sold alone, from hd-part-prices-<date>.json through the scan's own savePartPrices.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { catalogEntry } from '../core/src/decompose';
import type { ProductPage } from '../core/src/hdPage';
import { kitPageStored, kitRecords } from '../core/src/kitContents';
import { type Candidate, type Grade, kitKey } from '../core/src/match';
import { AnswerRefused, applyReviewAnswer, reviewSignature } from '../core/src/scan/answers';
import { candidatesFor } from '../core/src/scan/listings';
import { MemoryScanStore } from '../core/src/scan/memoryStore';
import { notePage } from '../core/src/scan/pageView';
import { PaidProblem, runPaid } from '../core/src/scan/paid';
import { notLookedUp } from '../core/src/scan/report';
import { buildReport } from '../core/src/scan/report';
import { bundleParts, knownModels, partPricesWanted, runScan, savePartPrices } from '../core/src/scan/runner';
import { twinKeys } from '../core/src/scan/twins';
import {
  type BudgetView, type BundleRecord, type BundleRow, bundleKey, DEFAULT_SCAN_SETTINGS, type MatchRecord, type MatchStatus, type PartPriceReading, partKey, resolvedParts,
  type ScanReport, type ScanSettings, type ScanStore, type SearchClient,
} from '../core/src/scan/types';
import { SearchBudget } from '../core/src/serpapi/budget';
import { BudgetExceededError, type Cache, RateLimitedError, type CacheEntry, cacheKey, type Params, type SearchOptions, type SearchResult } from '../core/src/serpapi/client';
import { parseAmazonSearch } from '../core/src/serpapi/parsers';
import { DEV_ALLOCATION } from './dev-budget';
import { NoKeyError, type openDevClient } from './dev-client';
import { SpendLockError } from './node-store';

// ---------------------------------------------------------------- the set

/** The day the validation set's pages were read; every file of the set carries it. */
export const VALIDATION_DATE = '2026-11-18';
/**
 * The pipeline's clock: fixed, so a replay decides exactly as the paid run did. Every time read from a
 * response is the response's own (when SerpApi answered), as in a scan.
 */
export const VALIDATION_NOW = Date.UTC(2026, 10, 18, 12);
/**
 * Brand pages read in the catalog step, from the cache only: DEWALT 1 to 3 and RYOBI 1 and 2 were paid
 * for by earlier scans. Never paid for here: the validation bucket is for part lookups.
 */
export const CATALOG_PAGES = 5;
/** A safety stop: passes go on only while a pass gets a new answer, and it takes two or three. */
const MAX_PASSES = 8;
/** Ledger labels of the paid run start with this, so the validation bucket's cap counts them. */
const BUCKET = 'validation';

export function validationFiles(dir: string) {
  return {
    pages: join(dir, `pages-${VALIDATION_DATE}.json`),
    kitPages: join(dir, `kit-pages-${VALIDATION_DATE}.json`),
    answers: join(dir, `answers-${VALIDATION_DATE}.json`),
    partPrices: join(dir, `hd-part-prices-${VALIDATION_DATE}.json`),
    labels: join(dir, `labels-${VALIDATION_DATE}.json`),
    results: join(dir, `results-${VALIDATION_DATE}.json`),
    responses: join(dir, 'responses'),
  };
}

/** A kit's own Home Depot page, as the bundle pages are exported (ProductPage). */
export interface KitPageInput {
  brand: string;
  model: string;
  title: string;
  bullets: string[];
  description: string | null;
}

/** A split only a person can settle: the bundle's parts, or 'none', with one line of evidence. */
export interface AnswerInput {
  parts: string[] | 'none';
  note: string;
}

export interface Inputs {
  /** The bundle pages, by item id order. */
  pages: ProductPage[];
  /** Kit pages by Home Depot item id. */
  kitPages: Map<string, KitPageInput>;
  /** Split answers by bundle model, upper case. */
  answers: Map<string, AnswerInput>;
  /**
   * Step 9: Home Depot's prices for parts sold alone, read in the owner's Chrome, by partKey. Empty when
   * the file is absent: then no part has a Home Depot price.
   */
  partPrices: Map<string, PartPriceReading>;
  /** Problems reading the optional files: each one is reported, never guessed around. */
  problems: string[];
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The set's inputs. The bundle pages are required; the kit pages and the answers are read when present. */
export function loadInputs(dir: string): Inputs {
  const files = validationFiles(dir);
  const problems: string[] = [];
  const pagesFile = readJson(files.pages) as { pages?: Record<string, ProductPage> };
  const pages = Object.values(pagesFile.pages ?? {}).sort((a, b) => a.itemId.localeCompare(b.itemId, 'en', { numeric: true }));

  const kitPages = new Map<string, KitPageInput>();
  if (existsSync(files.kitPages)) {
    const raw = (readJson(files.kitPages) as { pages?: unknown }).pages;
    for (const [itemId, v] of Object.entries(isObject(raw) ? raw : {})) {
      if (!/^\d+$/.test(itemId) || !isObject(v) || !isText(v.brand) || !isText(v.model) || typeof v.title !== 'string'
        || !Array.isArray(v.bullets) || !v.bullets.every((b) => typeof b === 'string') || !(v.description === null || typeof v.description === 'string')) {
        problems.push(`kit page ${itemId}: not used; it needs brand, model, title, bullets and description, as the bundle pages are exported`);
        continue;
      }
      kitPages.set(itemId, { brand: v.brand.trim(), model: v.model.trim(), title: v.title, bullets: v.bullets as string[], description: v.description as string | null });
    }
  }

  const answers = new Map<string, AnswerInput>();
  if (existsSync(files.answers)) {
    const raw = (readJson(files.answers) as { answers?: unknown }).answers;
    for (const [model, v] of Object.entries(isObject(raw) ? raw : {})) {
      const parts = isObject(v) ? v.parts : undefined;
      const ok = isObject(v) && isText(v.note) && (parts === 'none' || (Array.isArray(parts) && parts.length > 0 && parts.every(isText)));
      if (!ok) {
        problems.push(`answer for ${model}: not used; it needs parts (model numbers, or "none") and a note`);
        continue;
      }
      answers.set(model.trim().toUpperCase(), { parts: parts as string[] | 'none', note: (v as { note: string }).note });
    }
  }
  const partPrices = new Map<string, PartPriceReading>();
  if (existsSync(files.partPrices)) {
    const raw = (readJson(files.partPrices) as { prices?: unknown }).prices;
    const textOrNull = (v: unknown): v is string | null | undefined => v === undefined || v === null || typeof v === 'string';
    for (const [model, v] of Object.entries(isObject(raw) ? raw : {})) {
      if (!isObject(v) || !isText(v.brand) || !isText(v.model) || v.model.trim().toUpperCase() !== model.trim().toUpperCase()
        || !(v.price === null || typeof v.price === 'number') || !textOrNull(v.itemId) || !textOrNull(v.title)) {
        problems.push(`Home Depot price for ${model}: not used; it needs brand, model, itemId, price and title`);
        continue;
      }
      const itemId = (v.itemId ?? null) as string | null;
      const price = v.price as number | null;
      // The owner's browser read every model in the file: a product and a price is found, anything else not found.
      const found = itemId !== null && price !== null;
      partPrices.set(partKey(v.brand, v.model), {
        brand: v.brand.trim(), model: v.model.trim(), status: found ? 'found' : 'not_found', itemId: found ? itemId : null,
        matchedModel: found && isText(v.matchedModel) ? v.matchedModel.trim() : null,
        price: found ? price : null, title: found ? ((v.title ?? null) as string | null) : null,
        // The file keeps the item id; the link is Home Depot's address for it.
        link: found ? `https://www.homedepot.com/p/${itemId}` : null,
      });
    }
  }
  return { pages, kitPages, answers, partPrices, problems };
}

// ---------------------------------------------------------------- clients

/** A search no cached or recorded response answers. Nothing was sent. */
export class NotCached extends Error {
  constructor(readonly key: string, readonly label: string) {
    super(`No cached response for ${key}`);
    this.name = 'NotCached';
  }
}

/**
 * A SearchClient that answers only from a cache, judged as SerpApiClient judges a cached answer, and
 * never sends a request: there is no fetch in it. What it answered and what it could not are kept.
 */
export class CacheOnlyClient implements SearchClient {
  readonly used = new Map<string, CacheEntry>();
  /** Searches it could not answer, by cache key, with the label of the first asker. */
  readonly missed = new Map<string, string>();
  constructor(private readonly cache: Pick<Cache, 'get'>, private readonly now: () => number = () => VALIDATION_NOW) {}

  async search(params: Params, options: SearchOptions = {}): Promise<SearchResult> {
    const key = cacheKey(params);
    const hit = await this.cache.get(key);
    if (hit && (options.maxAgeMs === undefined || this.now() - hit.at <= options.maxAgeMs)) {
      this.used.set(key, { at: hit.at, data: hit.data });
      return { data: hit.data, source: 'cache', at: hit.at };
    }
    if (!this.missed.has(key)) this.missed.set(key, options.label ?? '');
    throw new NotCached(key, options.label ?? '');
  }
}

/** The paid client, with every label put under the validation bucket and every answer kept for the responses. */
export class BucketClient implements SearchClient {
  readonly used = new Map<string, CacheEntry>();
  spent = 0;
  constructor(private readonly inner: SearchClient) {}

  async search(params: Params, options: SearchOptions = {}): Promise<SearchResult> {
    const result = await this.inner.search(params, { ...options, label: `${BUCKET}:${options.label ?? 'unlabelled'}` });
    this.used.set(cacheKey(params), { at: result.at, data: result.data });
    if (result.source === 'network') this.spent += 1;
    return result;
  }
}

/** Recorded responses (fixtures/validation/responses/), read once: { key, at, data } per file. */
export class ResponsesCache implements Pick<Cache, 'get'> {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(dir: string) {
    if (!existsSync(dir)) return;
    for (const engine of readdirSync(dir, { withFileTypes: true })) {
      if (!engine.isDirectory()) continue;
      for (const f of readdirSync(join(dir, engine.name))) {
        if (!f.endsWith('.json')) continue;
        const text = readFileSync(join(dir, engine.name, f), 'utf8');
        if (/api_key/i.test(text)) throw new Error(`${engine.name}/${f} names api_key: a recorded response must be key-free`);
        const e = JSON.parse(text) as { key: string; at: number; data: unknown };
        this.entries.set(e.key, { at: e.at, data: e.data });
      }
    }
  }
  get size(): number {
    return this.entries.size;
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    return this.entries.get(key);
  }
}

/** A budget view that never caps a press: the paid client's own budget is the guard, search by search. */
const OPEN_BUDGET: BudgetView = {
  spendable: 10_000, leftThisRun: 10_000, leftAboveReserve: 10_000, hourlyLimit: null, blockReason: () => null,
};

/** Counts the Home Depot pages asked for, answered or not, so the scan can be stopped after them. */
class CountingClient implements SearchClient {
  homeDepotAsked = 0;
  constructor(private readonly inner: SearchClient) {}
  async search(params: Params, options: SearchOptions = {}): Promise<SearchResult> {
    try {
      return await this.inner.search(params, options);
    } finally {
      if (params.engine === 'home_depot') this.homeDepotAsked += 1;
    }
  }
}

/** The listing phase's budget: room for its pages, which only the cache answers. */
const scanBudget = () => new SearchBudget(
  { planName: 'Validation', status: 'Active', searchesPerMonth: 250, totalSearchesLeft: 250, thisMonthUsage: 0, thisHourSearches: 0, rateLimitPerHour: 250, renewalDate: null },
  { reserve: 0, maxPerRun: 250 },
);

// ---------------------------------------------------------------- watching the decisions

/** A listing as a decision saw it. */
export interface CandidateRow {
  asin: string;
  title: string;
  brand: string | null;
  price: number | null;
  reviews: number | null;
  sponsored?: true;
}

/** Where a part's automatic match came from. */
export type MatchSource = 'lookup' | 'saved listings' | 'twin' | 'answer';

interface Decision {
  source: MatchSource;
  /** The part's other written form whose match it took (Ruling 70). */
  twin?: string;
  candidates: CandidateRow[];
}

const row = (c: Candidate): CandidateRow => ({
  asin: c.asin, title: c.title, brand: c.brand ?? null, price: c.price ?? null, reviews: c.reviews ?? null, ...(c.sponsored ? { sponsored: true as const } : {}),
});

/**
 * A ScanStore that writes through to another and notes, for every match written, where it came from
 * and the listings it was judged among. It changes nothing the pipeline reads.
 */
export class WatchedStore implements ScanStore {
  readonly decisions = new Map<string, Decision>();
  /** Set by WatchedClient when a lookup's answer arrives: the next match written for that part is its result. */
  pending: { key: string; candidates: CandidateRow[] } | null = null;
  constructor(readonly inner: ScanStore = new MemoryScanStore()) {}

  async putMatch(r: MatchRecord): Promise<void> {
    await this.inner.putMatch(r);
    if (this.pending?.key === r.key && r.status !== 'waiting') {
      this.decisions.set(r.key, { source: 'lookup', candidates: this.pending.candidates });
      this.pending = null;
      return;
    }
    if (r.status === 'waiting') {
      this.decisions.delete(r.key);
      return;
    }
    if (r.decidedBy === 'user') {
      this.decisions.set(r.key, { source: 'answer', candidates: [] });
      return;
    }
    // matchFromListings: the twin's match copied (Ruling 70), or a saved listing chosen.
    for (const key of twinKeys(r.brand, r.model)) {
      const t = await this.inner.getMatch(key);
      if (t && t.status === r.status && t.asin === r.asin && t.grade === r.grade && t.decidedBy === r.decidedBy) {
        this.decisions.set(r.key, { source: 'twin', twin: t.model, candidates: this.decisions.get(key)?.candidates ?? [] });
        return;
      }
    }
    const rejected = new Set(r.rejectedAsins ?? []);
    const seen = candidatesFor(r.brand, r.model, await this.inner.listListings()).filter((c) => !rejected.has(c.asin));
    this.decisions.set(r.key, { source: 'saved listings', candidates: seen.map(row) });
  }

  getBundle = (key: string) => this.inner.getBundle(key);
  putBundle = (r: BundleRecord) => this.inner.putBundle(r);
  listBundles = () => this.inner.listBundles();
  getCatalogEntry: ScanStore['getCatalogEntry'] = (key) => this.inner.getCatalogEntry(key);
  putCatalogEntry: ScanStore['putCatalogEntry'] = (r) => this.inner.putCatalogEntry(r);
  listCatalog: ScanStore['listCatalog'] = () => this.inner.listCatalog();
  getMatch: ScanStore['getMatch'] = (key) => this.inner.getMatch(key);
  listMatches: ScanStore['listMatches'] = () => this.inner.listMatches();
  getPrice: ScanStore['getPrice'] = (asin) => this.inner.getPrice(asin);
  putPrice: ScanStore['putPrice'] = (r) => this.inner.putPrice(r);
  getListing: ScanStore['getListing'] = (asin) => this.inner.getListing(asin);
  putListing: ScanStore['putListing'] = (r) => this.inner.putListing(r);
  listListings: ScanStore['listListings'] = () => this.inner.listListings();
  getCursor: ScanStore['getCursor'] = (brand) => this.inner.getCursor(brand);
  putCursor: ScanStore['putCursor'] = (c) => this.inner.putCursor(c);
  getReview: ScanStore['getReview'] = (id) => this.inner.getReview(id);
  putReview: ScanStore['putReview'] = (item) => this.inner.putReview(item);
  listReview: ScanStore['listReview'] = () => this.inner.listReview();
  getPartPrice: ScanStore['getPartPrice'] = (key) => this.inner.getPartPrice(key);
  putPartPrice: ScanStore['putPartPrice'] = (r) => this.inner.putPartPrice(r);
  listPartPrices: ScanStore['listPartPrices'] = () => this.inner.listPartPrices();
  getConfirmedPrice: ScanStore['getConfirmedPrice'] = (key) => this.inner.getConfirmedPrice(key);
  putConfirmedPrice: ScanStore['putConfirmedPrice'] = (r) => this.inner.putConfirmedPrice(r);
  deleteConfirmedPrice: ScanStore['deleteConfirmedPrice'] = (key) => this.inner.deleteConfirmedPrice(key);
  listConfirmedPrices: ScanStore['listConfirmedPrices'] = () => this.inner.listConfirmedPrices();
  getEbayValue: ScanStore['getEbayValue'] = (key) => this.inner.getEbayValue(key);
  putEbayValue: ScanStore['putEbayValue'] = (r) => this.inner.putEbayValue(r);
  listEbayValues: ScanStore['listEbayValues'] = () => this.inner.listEbayValues();
  putEbayAnswer: ScanStore['putEbayAnswer'] = (r) => this.inner.putEbayAnswer(r);
  listEbayAnswers: ScanStore['listEbayAnswers'] = () => this.inner.listEbayAnswers();
  getJudgement: ScanStore['getJudgement'] = (key) => this.inner.getJudgement(key);
  putJudgement: ScanStore['putJudgement'] = (r) => this.inner.putJudgement(r);
  getScan: ScanStore['getScan'] = (id) => this.inner.getScan(id);
  putScan: ScanStore['putScan'] = (job) => this.inner.putScan(job);
  listScans: ScanStore['listScans'] = () => this.inner.listScans();
  clearAll: ScanStore['clearAll'] = async () => {
    this.decisions.clear();
    this.pending = null;
    await this.inner.clearAll();
  };
}

/** The part a lookup search is for, from its query (`k` is the brand, a space, the model). */
function lookupPart(params: Params): { brand: string; model: string } | null {
  if (params.engine !== 'amazon' || typeof params.k !== 'string' || params.rh !== undefined) return null;
  const at = params.k.indexOf(' ');
  return at < 0 ? null : { brand: params.k.slice(0, at), model: params.k.slice(at + 1) };
}

/** Tells the store when a lookup's answer arrives, so its match is noted with that answer's listings. */
class WatchedClient implements SearchClient {
  /** Lookups answered. */
  lookups = 0;
  /** The last lookup asked for, answered or not, with its cache key. */
  lastAsked: { key: string; brand: string; model: string } | null = null;
  constructor(private readonly inner: SearchClient, private readonly store: WatchedStore) {}
  async search(params: Params, options: SearchOptions = {}): Promise<SearchResult> {
    const part = lookupPart(params);
    const isLookup = part !== null && (options.label ?? '').includes(':lookup:');
    if (isLookup) this.lastAsked = { key: cacheKey(params), ...part };
    const result = await this.inner.search(params, options);
    if (isLookup) {
      this.lookups += 1;
      this.store.pending = { key: partKey(part.brand, part.model), candidates: parseAmazonSearch(result.data).map(row) };
    }
    return result;
  }
}

// ---------------------------------------------------------------- the pipeline

export interface PipelineDeps {
  inputs: Inputs;
  /** Answers the listing phase (brand pages, Home Depot pages); it must never pay (a CacheOnlyClient). */
  scanClient: SearchClient;
  /** Answers the lookups. */
  lookupClient: SearchClient;
  /**
   * True (dry run, replay): a lookup no cached or recorded response answers (NotCached) leaves its part
   * waiting, and the run goes on without it. False (the paid run): any failed search ends the run, never retried.
   */
  continuePastMisses: boolean;
}

export interface PipelineRun {
  store: WatchedStore;
  report: ScanReport;
  passes: number;
  /** Why the paid run ended early, or null. */
  stop: string | null;
  /** The budget's limit that refused a search (run_cap, reserve, hourly_limit); the run then went on with cached answers only. */
  capReached: string | null;
  /** Lookups the cap refused (never sent): their parts wait. */
  refusedLookups: Map<string, { brand: string; model: string }>;
  /** Lookups no cached or recorded response answered (dry run, replay), by cache key, with the part. */
  missedLookups: Map<string, { brand: string; model: string }>;
  /** Paid lookups SerpApi answered with an error (not charged), by cache key: set aside, never retried. */
  failedLookups: Map<string, { brand: string; model: string; message: string }>;
  /** Bundle keys whose split question an answer from the answers file closed. */
  answered: Map<string, AnswerInput>;
  problems: string[];
  /** Kit records stored from the kit pages: kitKey -> item id. */
  kitsStored: Map<string, string>;
  /** Bundle keys of the validation set. The store also holds the bundles the listing pages showed. */
  validation: Set<string>;
  /** Pages notePage does not read as a bundle (its model has no bundle shape): nothing is stored for them. */
  notBundles: { itemId: string; brand: string; model: string; title: string }[];
}

const SETTINGS: ScanSettings = DEFAULT_SCAN_SETTINGS;

export async function runValidationPipeline(deps: PipelineDeps): Promise<PipelineRun> {
  const now = VALIDATION_NOW;
  const store = new WatchedStore();
  const problems = [...deps.inputs.problems];
  const lookups = new WatchedClient(deps.lookupClient, store);

  // 1. The scan's listing phase with the default settings, answered only by the cache: the brands' Amazon
  // pages (the catalog step), then the default queries' Home Depot pages, which store the catalog the
  // splitter knows and the kits' item ids. It is stopped, as by the owner, once those pages are answered,
  // so it plans no lookup (planParts): every lookup below goes through the panel's Look up.
  const listingPages = SETTINGS.queries.length * SETTINGS.pagesPerQuery;
  const scanClient = new CountingClient(deps.scanClient);
  await runScan({
    client: scanClient, budget: scanBudget(), store,
    // Whatever the cache holds is read, however old: these pages are the store's past, not today's prices.
    settings: { ...SETTINGS, catalogPagesPerScan: CATALOG_PAGES, listingMaxAgeMs: Infinity, freshnessMs: Infinity }, labelPrefix: BUCKET, now: () => now,
    shouldStop: () => scanClient.homeDepotAsked >= listingPages,
  });

  // 2. Kit pages, saved on the kit's catalog entry by its item id, as readKitPages saves a page it read.
  // A kit no listing row stored is stored first as applyListing would store its row.
  const kitsStored = new Map<string, string>();
  const catalog = await store.listCatalog();
  for (const [itemId, kit] of deps.inputs.kitPages) {
    const entry = catalogEntry(kit.brand, kit.model, kit.title);
    const page = { bullets: [...kit.bullets], description: kit.description, readAt: now };
    const known = catalog.find((c) => c.itemId === itemId);
    if (known && partKey(known.brand, known.model) !== partKey(entry.brand, entry.model)) {
      problems.push(`kit page ${itemId}: the page is ${entry.brand} ${entry.model}, the listing row ${known.brand} ${known.model}; not used`);
      continue;
    }
    if (!(known?.isKit ?? entry.isKit)) problems.push(`kit page ${itemId} (${entry.brand} ${entry.model}): not marked a kit, so a scan would not split it`);
    await store.putCatalogEntry(known ? { ...known, page } : {
      key: partKey(entry.brand, entry.model), brand: entry.brand, model: entry.model, title: kit.title, kinds: entry.kinds,
      isKit: entry.isKit ?? false, upc: null, seenAt: now, itemId, page,
    });
    kitsStored.set(kitKey(entry.brand, entry.model), itemId);
  }
  const validation = new Set(deps.inputs.pages.map((p) => bundleKey(p.itemId)));

  const notBundles = new Map<string, { itemId: string; brand: string; model: string; title: string }>();
  const visitAll = async () => {
    for (const page of deps.inputs.pages) {
      const view = await notePage(store, SETTINGS, page, now);
      if (view.kind === 'none') notBundles.set(page.itemId, { itemId: page.itemId, brand: page.brand, model: page.model, title: page.title });
      else notBundles.delete(page.itemId);
    }
  };

  // The owner's answers, to the split questions still open. A bundle the tool resolved keeps its own split.
  const answered = new Map<string, AnswerInput>();
  const byModel = new Map(deps.inputs.pages.map((p) => [p.model.trim().toUpperCase(), p]));
  for (const model of deps.inputs.answers.keys()) if (!byModel.has(model)) problems.push(`answer for ${model}: no such bundle in the set`);
  const applyAnswers = async (): Promise<number> => {
    let applied = 0;
    for (const [model, answer] of deps.inputs.answers) {
      const page = byModel.get(model);
      if (!page) continue;
      const item = await store.getReview(`split:${bundleKey(page.itemId)}`);
      if (!item || item.answer !== null) continue;
      const seen = reviewSignature(item);
      try {
        await applyReviewAnswer(store, item.id, answer.parts === 'none' ? { none: true, seen } : { parts: answer.parts, seen }, now);
        answered.set(bundleKey(page.itemId), answer);
        applied += 1;
      } catch (err) {
        if (!(err instanceof AnswerRefused)) throw err;
        problems.push(`answer for ${model}: refused: ${err.message}`);
      }
    }
    return applied;
  };

  // Step 9: Home Depot's prices for the parts sold alone, as a scan reads them after its pages and before
  // its lookups: the parts it would ask for (partPricesWanted), answered from the file as the owner's
  // browser read them, each saved by the scan's own savePartPrices. A part the file does not hold is not
  // answered, as a reader that did not get to it.
  const readPrices = async () => {
    const asked = await partPricesWanted(store, SETTINGS, now);
    await savePartPrices(store, asked, asked.flatMap((p) => deps.inputs.partPrices.get(p.key) ?? []), now);
  };

  // 3. Passes: the pages, the answers, Home Depot's prices, then one Look up press for every part still waiting.
  const missedLookups = new Map<string, { brand: string; model: string }>();
  const failedLookups = new Map<string, { brand: string; model: string; message: string }>();
  /** kitKey of every part whose lookup was not answered: its other written form would ask the same. */
  const missedProducts = new Set<string>();
  // As a scan's 3 rule 2: a failed lookup is set aside and the run goes on, but two in a row end it.
  let failedInARow = 0;
  let answeredAtFailure = -1;
  let stop: string | null = null;
  let capReached: string | null = null;
  /** Lookups the paid client's budget refused, never sent. */
  const refusedLookups = new Map<string, { brand: string; model: string }>();
  let passes = 0;
  for (let pass = 1; pass <= MAX_PASSES && stop === null; pass++) {
    passes = pass;
    await visitAll();
    if ((await applyAnswers()) > 0) await visitAll();
    await readPrices();
    const waiting = (await waitingParts(store, validation)).filter((p) => !missedProducts.has(kitKey(p.brand, p.model)));
    if (waiting.length === 0) break;
    const before = lookups.lookups;
    let left = waiting;
    while (left.length > 0) {
      try {
        await runPaid({ client: lookups, budget: OPEN_BUDGET, store, now: () => now, settings: SETTINGS }, { kind: 'lookUp', parts: left });
        break;
      } catch (err) {
        const asked = lookups.lastAsked;
        const message = (err instanceof Error && err.message) || String(err);
        if (err instanceof RateLimitedError || err instanceof PaidProblem || asked === null) {
          stop = message;
          break;
        }
        if (err instanceof BudgetExceededError) {
          // The cap refused the search before sending it. Nothing more is paid for in this run, but what
          // the cache already holds still answers the parts after it, for nothing.
          capReached ??= err.reason;
          refusedLookups.set(asked.key, { brand: asked.brand, model: asked.model });
        } else if (err instanceof NotCached) {
          if (!deps.continuePastMisses) {
            stop = message;
            break;
          }
          missedLookups.set(err.key, { brand: asked.brand, model: asked.model });
        } else {
          if (lookups.lookups > answeredAtFailure) failedInARow = 0;
          failedInARow += 1;
          answeredAtFailure = lookups.lookups;
          failedLookups.set(asked.key, { brand: asked.brand, model: asked.model, message });
          if (failedInARow >= 2) {
            stop = `two lookups in a row failed; the last: ${message}`;
            break;
          }
        }
        missedProducts.add(kitKey(asked.brand, asked.model));
        left = left.filter((p) => !missedProducts.has(kitKey(p.brand, p.model)));
      }
    }
    if (lookups.lookups === before) break;
  }
  // The pages once more, so every split and saved-listing match reads the last answers.
  await visitAll();
  if ((await applyAnswers()) > 0) await visitAll();
  await readPrices();
  return { store, report: await buildReport(store, SETTINGS), passes, stop, capReached, missedLookups, failedLookups, refusedLookups, answered, problems, kitsStored, validation, notBundles: [...notBundles.values()] };
}

/**
 * Every part of a validation bundle that its report row shows not looked up, in any way to sell (kit
 * items included), each once. The other bundles the listing pages stored are never looked up here.
 */
async function waitingParts(store: ScanStore, validation: Set<string>): Promise<{ brand: string; model: string }[]> {
  const report = await buildReport(store, SETTINGS);
  const seen = new Map<string, { brand: string; model: string }>();
  for (const b of report.bundles) {
    if (!validation.has(b.key)) continue;
    for (const option of b.options) {
      for (const p of option.parts) if (notLookedUp(p)) seen.set(partKey(b.brand, p.model), { brand: b.brand, model: p.model });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- what the run still wants

export interface WantedKit {
  brand: string;
  model: string;
  /** The validation bundles that hold it. */
  bundles: string[];
  /** Home Depot item ids of the kit: its catalog entry's (from a listing row), else a cached row's. */
  itemIds: string[];
}

export interface WantedAnswer {
  itemId: string;
  brand: string;
  model: string;
  reason: string;
  choices: string[][];
}

// The model half of catalogEntry's kit test (decompose.ts): a model that may be a kit. Its title decides,
// once its page is read; asking for a page that turns out not to be a kit costs nothing.
const KIT_SHAPE = /^(DCK|PCL\d+K|P\d+K)/;

/**
 * Kit pages the run would use: for each part of a validation bundle's resolved split that the known
 * models mark a kit, or whose model has a kit's shape, with no page stored for it. Item ids come from
 * the kit's catalog entry, as readKitPages reads them, else from `hdRows` (cached listing rows).
 */
export async function wantedKitPages(run: PipelineRun, hdRows: { itemId: string; brand: string; model: string }[] = []): Promise<WantedKit[]> {
  const { store } = run;
  const known = await knownModels(store);
  const catalog = await store.listCatalog();
  const records = kitRecords(await store.listBundles(), catalog);
  const wanted = new Map<string, WantedKit>();
  for (const b of await store.listBundles()) {
    if (!run.validation.has(b.key)) continue;
    for (const part of resolvedParts(b)) {
      const kit = known.catalog.get(part.model)?.isKit === true || KIT_SHAPE.test(part.model);
      if (!kit || kitPageStored(records, part.brand, part.model)) continue;
      const id = kitKey(part.brand, part.model);
      const w = wanted.get(id) ?? { brand: part.brand, model: part.model, bundles: [], itemIds: [] };
      if (!w.bundles.includes(b.model)) w.bundles.push(b.model);
      wanted.set(id, w);
    }
  }
  const same = (w: WantedKit, r: { brand: string; model: string }) => r.brand.toUpperCase() === w.brand && kitKey(w.brand, r.model) === kitKey(w.brand, w.model);
  for (const w of wanted.values()) {
    const own = catalog.filter((c) => same(w, c) && typeof c.itemId === 'string').map((c) => c.itemId!);
    w.itemIds = [...new Set(own.length > 0 ? own : hdRows.filter((r) => same(w, r)).map((r) => r.itemId))];
  }
  return [...wanted.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
}

/** Split questions still open: only a person can answer them. */
export async function wantedAnswers(run: PipelineRun): Promise<WantedAnswer[]> {
  const out: WantedAnswer[] = [];
  for (const b of await run.store.listBundles()) {
    if (!run.validation.has(b.key) || b.split?.status === 'resolved') continue;
    const q = await run.store.getReview(`split:${b.key}`);
    if (!q || q.answer !== null) continue;
    out.push({ itemId: b.itemId, brand: b.brand, model: b.model, reason: q.reason, choices: q.choices });
  }
  return out;
}

// ---------------------------------------------------------------- results

export interface PartResult {
  model: string;
  qty: number;
  /** The kit this part is an item of, when only a split kit holds it; null for a part of the bundle's own split. */
  kit: string | null;
  /** The ways to sell that hold it. */
  options: string[];
  status: MatchStatus | 'unmatched';
  asin: string | null;
  grade: Grade | null;
  listingTitle: string | null;
  price: number | null;
  /** Where the match came from; null while the part waits. */
  source: MatchSource | null;
  twin?: string;
  /** The listings the decision saw: the lookup's results, or the saved listings that carry the model. */
  candidates: CandidateRow[];
  /** Step 9: Home Depot's price for the part sold alone (reference only, never in an ROI); null when none is stored. */
  hdPrice: number | null;
}

export interface BundleResult {
  itemId: string;
  brand: string;
  model: string;
  title: string;
  link: string | null;
  price: number | null;
  wasPrice: number | null;
  section: BundleRow['section'];
  split: {
    status: 'resolved' | 'needs_review';
    parts: { model: string; qty: number }[];
    notes: string[];
    /** 'answer' when the answers file decided it. */
    by: 'tool' | 'answer';
    answerNote?: string;
  };
  /** True when the bundle's split question is open in the review queue, or was (an answer closed it). */
  inReviewQueue: boolean;
  options: { id: string; label: string; profit: number | null; roi: number | null; leftovers: string[]; parts: string[] }[];
  kitsNotRead: string[];
  parts: PartResult[];
  /** Step 9: the row's ROI at each end of its primary way to sell's range (BundleRow.range); amazonNew is its estimate's. */
  roiRange: { lowest: number | null; amazonNew: number | null; highest: number | null };
}

export interface ValidationResults {
  about: string;
  date: string;
  now: string;
  catalogPages: string[];
  summary: {
    pages: number;
    bundles: number;
    splitResolved: number;
    splitByAnswer: number;
    splitInReview: number;
    parts: number;
    byGrade: Record<string, number>;
    notLookedUp: number;
    /** Step 9: bundles whose ROI is above 0 at each end of the range (estimates from fee settings). */
    positive: { lowest: number; amazonNew: number; highest: number };
    /** Step 9: parts with a Home Depot price stored (reference only). */
    hdPrices: number;
  };
  bundles: BundleResult[];
  /**
   * Pages of the set the tool does not read as a bundle (notePage: the model has no bundle shape,
   * looksLikeBundle). Nothing is split or looked up for them, and no question is asked.
   */
  notReadAsBundle: { itemId: string; brand: string; model: string; title: string }[];
  reviewQueue: { id: string; kind: 'split' | 'match'; brand: string; model: string; reason: string }[];
}

const qtyOf = (models: string[]): { model: string; qty: number }[] => {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts].map(([model, qty]) => ({ model, qty }));
};

export async function buildResults(run: PipelineRun): Promise<ValidationResults> {
  const { store, report } = run;
  const cursors = await Promise.all(['DEWALT', 'RYOBI'].map((b) => store.getCursor(b)));
  const catalogPages = cursors.flatMap((c) => (c ? [`${c.brand} up to page ${c.nextPage === 1 ? 'the last' : c.nextPage - 1}`] : []));
  const openQuestions = new Set(report.review.map((r) => r.id));
  const bundles: BundleResult[] = [];
  for (const b of report.bundles.filter((x) => run.validation.has(x.key)).sort((x, y) => x.itemId.localeCompare(y.itemId, 'en', { numeric: true }))) {
    const record = (await store.getBundle(b.key))!;
    const split = record.split!;
    const answer = run.answered.get(b.key);
    const items = await bundleParts(store, (x) => x.key === b.key);
    const whole = b.options.find((o) => o.id === 'whole');
    const parts = new Map<string, PartResult>();
    for (const option of [...(whole ? [whole] : []), ...b.options.filter((o) => o !== whole)]) {
      for (const p of option.parts) {
        const known = parts.get(p.model);
        if (known) {
          known.options.push(option.id);
          continue;
        }
        const key = partKey(b.brand, p.model);
        const decision = store.decisions.get(key);
        const kits = items.get(key)?.kits ?? [];
        parts.set(p.model, {
          model: p.model, qty: p.qty, kit: kits.length > 0 ? kits.map((k) => k.slice(k.indexOf(':') + 1)).join(', ') : null, options: [option.id],
          status: p.status, asin: p.asin, grade: p.grade, listingTitle: p.title, price: p.price,
          source: p.status === 'waiting' || p.status === 'unmatched' ? null : (decision?.source ?? null),
          ...(decision?.twin ? { twin: decision.twin } : {}),
          candidates: decision?.candidates ?? [],
          hdPrice: p.prices.find((o) => o.kind === 'homedepot')?.price ?? null,
        });
      }
    }
    bundles.push({
      itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, link: b.link, price: b.price, wasPrice: b.regularPrice, section: b.section,
      split: {
        status: split.status, parts: qtyOf(split.components), notes: split.notes, by: answer ? 'answer' : 'tool',
        ...(answer ? { answerNote: answer.note } : {}),
      },
      inReviewQueue: openQuestions.has(`split:${b.key}`) || answer !== undefined,
      options: b.options.map((o) => ({
        id: o.id, label: o.label, profit: o.estimate?.profit ?? null, roi: o.estimate?.roi ?? null, leftovers: o.leftovers, parts: o.parts.map((p) => p.model),
      })),
      kitsNotRead: b.kitsNotRead,
      parts: [...parts.values()],
      roiRange: { lowest: b.range.lowest?.roi ?? null, amazonNew: b.range.amazonNew?.roi ?? null, highest: b.range.highest?.roi ?? null },
    });
  }
  const all = bundles.flatMap((b) => b.parts);
  const byGrade: Record<string, number> = {};
  for (const p of all) {
    const k = p.status === 'matched' ? (p.grade ?? 'chosen') : p.status;
    byGrade[k] = (byGrade[k] ?? 0) + 1;
  }
  return {
    about: `The tool's own pipeline over the validation set's ${bundles.length} Home Depot bundles (pages-${VALIDATION_DATE}.json), `
      + 'written by npm run validate. Per part: the Amazon listing chosen, its grade, where the match came from, and the listings the '
      + 'decision saw. Profit figures are estimates from fee settings, not real Amazon fees.',
    date: VALIDATION_DATE,
    now: new Date(VALIDATION_NOW).toISOString(),
    catalogPages,
    summary: {
      pages: bundles.length + run.notBundles.length,
      bundles: bundles.length,
      splitResolved: bundles.filter((b) => b.split.status === 'resolved').length,
      splitByAnswer: bundles.filter((b) => b.split.by === 'answer').length,
      splitInReview: bundles.filter((b) => b.split.status !== 'resolved').length,
      parts: all.length,
      byGrade,
      notLookedUp: all.filter((p) => p.status === 'waiting' || p.status === 'unmatched').length,
      positive: {
        lowest: bundles.filter((b) => (b.roiRange.lowest ?? 0) > 0).length,
        amazonNew: bundles.filter((b) => (b.roiRange.amazonNew ?? 0) > 0).length,
        highest: bundles.filter((b) => (b.roiRange.highest ?? 0) > 0).length,
      },
      hdPrices: all.filter((p) => p.hdPrice !== null).length,
    },
    bundles,
    notReadAsBundle: run.notBundles,
    // The open questions about the set: its bundles' splits, and the parts they hold.
    reviewQueue: report.review
      .filter((r) => (r.kind === 'split' ? run.validation.has(r.subject) : bundles.some((b) => b.brand === r.brand && b.parts.some((p) => p.model === r.model))))
      .map((r) => ({ id: r.id, kind: r.kind, brand: r.brand, model: r.model, reason: r.reason })),
  };
}

// ---------------------------------------------------------------- criterion 6

/** One part's label: the listings that are the part, or 'none' when Amazon has none. */
export interface PartLabel {
  correct: string[] | 'none';
  note: string;
}
/** bundle model -> part model -> label. */
export type Labels = Record<string, Record<string, PartLabel>>;

export interface Miss {
  bundle: string;
  part: string;
  grade: string;
  asin: string | null;
  correct: string;
  note: string;
}

export interface Criterion6 {
  /** Exact and strong matches: every one must be correct. */
  confident: { total: number; wrong: Miss[] };
  /** Probable matches: at least 95% correct. */
  probable: { total: number; correct: number; wrong: Miss[] };
  /** Matched parts with no label: the score is not complete until each has one. */
  unlabelled: { bundle: string; part: string }[];
  /** Parts not looked up in the recorded run. */
  notLookedUp: { bundle: string; part: string }[];
  /** Bundles whose split is not resolved and that are not in the review queue. */
  unresolvedNotQueued: string[];
  /** Not scored: parts left with no listing or in review that the label says Amazon has. */
  listingsMissed: Miss[];
  /** Not scored: pages of the set the tool does not read as a bundle, so the splitter never sees them. */
  notReadAsBundle: string[];
  pass: boolean;
}

export const PROBABLE_TARGET = 0.95;

export function scoreCriterion6(results: ValidationResults, labels: Labels): Criterion6 {
  const score: Criterion6 = {
    confident: { total: 0, wrong: [] }, probable: { total: 0, correct: 0, wrong: [] }, unlabelled: [], notLookedUp: [], unresolvedNotQueued: [], listingsMissed: [],
    notReadAsBundle: (results.notReadAsBundle ?? []).map((p) => p.model), pass: false,
  };
  for (const b of results.bundles) {
    if (b.split.status !== 'resolved' && !b.inReviewQueue) score.unresolvedNotQueued.push(b.model);
    for (const p of b.parts) {
      const label = labels[b.model]?.[p.model];
      const correctText = label ? (label.correct === 'none' ? 'none' : label.correct.join(' ')) : '';
      const miss = (): Miss => ({ bundle: b.model, part: p.model, grade: p.grade ?? p.status, asin: p.asin, correct: correctText, note: label?.note ?? '' });
      if (p.status === 'waiting' || p.status === 'unmatched') {
        score.notLookedUp.push({ bundle: b.model, part: p.model });
        continue;
      }
      if (p.status !== 'matched') {
        if (label && label.correct !== 'none' && label.correct.length > 0) score.listingsMissed.push(miss());
        continue;
      }
      if (!label) {
        score.unlabelled.push({ bundle: b.model, part: p.model });
        continue;
      }
      const right = label.correct !== 'none' && p.asin !== null && label.correct.includes(p.asin);
      if (p.grade === 'exact' || p.grade === 'strong') {
        score.confident.total += 1;
        if (!right) score.confident.wrong.push(miss());
      } else if (p.grade === 'probable') {
        score.probable.total += 1;
        if (right) score.probable.correct += 1;
        else score.probable.wrong.push(miss());
      }
    }
  }
  const probableOk = score.probable.total === 0 || score.probable.correct / score.probable.total >= PROBABLE_TARGET;
  score.pass = score.confident.wrong.length === 0 && probableOk && score.unresolvedNotQueued.length === 0
    && score.unlabelled.length === 0 && score.notLookedUp.length === 0;
  return score;
}

/** The score as lines: the counts, then a table of every miss. */
export function scoreLines(s: Criterion6): string[] {
  const pct = s.probable.total === 0 ? 'none' : `${((s.probable.correct / s.probable.total) * 100).toFixed(1)}%`;
  const lines = [
    `Exact and strong: ${s.confident.total}, wrong ${s.confident.wrong.length} (must be 0)`,
    `Probable: ${s.probable.correct} of ${s.probable.total} correct, ${pct} (at least ${PROBABLE_TARGET * 100}%)`,
    `Unresolved bundles not in the review queue: ${s.unresolvedNotQueued.length}${s.unresolvedNotQueued.length ? ` (${s.unresolvedNotQueued.join(', ')})` : ''}`,
    `Matched parts with no label: ${s.unlabelled.length}${s.unlabelled.length ? ` (${s.unlabelled.map((u) => `${u.bundle}/${u.part}`).join(', ')})` : ''}`,
    `Parts not looked up: ${s.notLookedUp.length}${s.notLookedUp.length ? ` (${s.notLookedUp.map((u) => `${u.bundle}/${u.part}`).join(', ')})` : ''}`,
    `Listings Amazon has that the tool left unmatched (not scored): ${s.listingsMissed.length}`,
    `Pages not read as a bundle (not scored, never in the review queue): ${s.notReadAsBundle.length}${s.notReadAsBundle.length ? ` (${s.notReadAsBundle.join(', ')})` : ''}`,
  ];
  const misses = [...s.confident.wrong, ...s.probable.wrong, ...s.listingsMissed];
  if (misses.length > 0) {
    lines.push('', 'bundle | part | grade | chosen | correct | note');
    for (const m of misses) lines.push(`${m.bundle} | ${m.part} | ${m.grade} | ${m.asin ?? '-'} | ${m.correct || '-'} | ${m.note}`);
  }
  return lines;
}

// ---------------------------------------------------------------- writing the files

const slug = (key: string): string => key.replace(/^amazon_domain=amazon\.com&/, '').replace(/[^A-Za-z0-9=._-]+/g, '_');

/**
 * Writes each response to responses/<engine>/<slug>.json as { key, at, data }. Refuses, writing nothing,
 * when any of them names api_key. Returns how many were written.
 */
export function writeResponses(dir: string, used: Map<string, CacheEntry>): number {
  const files = new Map<string, string>();
  const names = new Map<string, string>();
  for (const [key, entry] of used) {
    const engine = /(?:^|&)engine=([a-z_]+)/.exec(key)?.[1] ?? 'other';
    let name = `${engine}/${slug(key)}.json`;
    if (names.has(name) && names.get(name) !== key) name = `${engine}/${slug(key)}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}.json`;
    names.set(name, key);
    const text = `${JSON.stringify({ key, at: entry.at, data: entry.data }, null, 2)}\n`;
    if (/api_key/i.test(text)) throw new Error(`The response for ${key} names api_key; nothing was written.`);
    files.set(name, text);
  }
  for (const [name, text] of files) {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  return files.size;
}

export function writeResults(file: string, results: ValidationResults): void {
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
}

export function readLabels(file: string): Labels {
  if (!existsSync(file)) return {};
  const raw = (readJson(file) as { labels?: unknown }).labels;
  return isObject(raw) ? (raw as Labels) : {};
}

// ---------------------------------------------------------------- the command

export interface ValidateDeps {
  log: (line: string) => void;
  /** fixtures/validation in this checkout. */
  dir: string;
  /** The disk cache, read only: the dry run's answers, and the brand pages in every mode but replay. */
  cache: Pick<Cache, 'get'>;
  openClient: typeof openDevClient;
  /** Home Depot listing rows the cache holds, for item id hints in the dry run. */
  hdRows?: () => { itemId: string; brand: string; model: string }[];
}

type Mode = { kind: 'dry-run' } | { kind: 'replay' } | { kind: 'max'; n: number };

const USAGE = [
  'Usage:',
  '  npm run validate -- --dry-run     free: what a run needs that is not cached, and the inputs it still wants',
  `  npm run validate -- --max N       spends up to N searches (1 to ${DEV_ALLOCATION.validation}, validation bucket)`,
  '  npm run validate -- --replay      no network: the recorded responses only; rewrites the results',
];

/** Null when the arguments are not exactly one mode. */
export function parseValidateArgs(args: string[]): Mode | null {
  if (args.length === 1 && args[0] === '--dry-run') return { kind: 'dry-run' };
  if (args.length === 1 && args[0] === '--replay') return { kind: 'replay' };
  if (args.length === 2 && args[0] === '--max' && /^\d+$/.test(args[1]!)) {
    const n = Number(args[1]);
    if (n >= 1 && n <= DEV_ALLOCATION.validation) return { kind: 'max', n };
  }
  return null;
}

const missLine = (key: string, label: string) => {
  const params = Object.fromEntries(new URLSearchParams(key));
  const shown = Object.entries(params).filter(([k]) => k !== 'amazon_domain' && k !== 'engine').map(([k, v]) => `${k}=${v}`).join(' ');
  return `  ${params.engine ?? '?'}  ${shown}${label ? `  (${label})` : ''}`;
};

async function logWanted(log: (line: string) => void, run: PipelineRun, hdRows: { itemId: string; brand: string; model: string }[]): Promise<void> {
  const kits = await wantedKitPages(run, hdRows);
  log(`Kit pages wanted: ${kits.length}${kits.length ? ` (kit-pages-${VALIDATION_DATE}.json: { about, pages: { "<itemId>": ProductPage } }, exported as the bundle pages were)` : ''}`);
  for (const k of kits) log(`  ${k.brand} ${k.model}  in ${k.bundles.join(', ')}${k.itemIds.length ? `  item id ${k.itemIds.join(' or ')} (its Home Depot listing row)` : '  item id not in the cache'}`);
  const answers = await wantedAnswers(run);
  log(`Split answers wanted: ${answers.length}${answers.length ? ` (answers-${VALIDATION_DATE}.json: { about, answers: { "<bundle model>": { parts: [...] | "none", note } } })` : ''}`);
  for (const a of answers) {
    const choices = a.choices.length ? `; choices: ${a.choices.map((c) => c.join('+')).join(' | ')}` : '';
    log(`  ${a.brand} ${a.model}  item ${a.itemId}: ${a.reason || 'contents not known'}${choices}`);
  }
}

/** The listing phase's pages: all from the cache, and any the cache did not hold, which are never paid for. */
function logScanPages(log: (line: string) => void, scanClient: CacheOnlyClient): void {
  const engines = [...scanClient.used.keys()].map((k) => (/(?:^|&)engine=home_depot(?:&|$)/.test(k) ? 'home_depot' : 'amazon'));
  log(`Listing phase from the cache: ${engines.filter((e) => e === 'amazon').length} Amazon brand pages, ${engines.filter((e) => e === 'home_depot').length} Home Depot pages`);
  for (const [key, label] of scanClient.missed) log(`  not cached, so not read (never paid for here):${missLine(key, label).slice(1)}`);
}

function logSummary(log: (line: string) => void, results: ValidationResults): void {
  const s = results.summary;
  if (results.notReadAsBundle.length > 0) {
    log(`Pages not read as a bundle (no bundle shape; nothing stored, no question): ${results.notReadAsBundle.map((p) => `${p.model} (${p.itemId})`).join(', ')}`);
  }
  log(`Bundles ${s.bundles} of ${s.pages} pages: split resolved ${s.splitResolved} (by an answer ${s.splitByAnswer}), in review ${s.splitInReview}`);
  log(`Parts ${s.parts}: ${Object.entries(s.byGrade).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  log(`Positive ROI (estimates from fee settings): lowest ${s.positive.lowest}, Amazon New ${s.positive.amazonNew}, highest ${s.positive.highest} of ${s.bundles} bundles`);
  log(`Parts with a Home Depot price (reference only, never in an ROI): ${s.hdPrices} of ${s.parts}`);
}

export async function runValidateCli(args: string[], deps: ValidateDeps): Promise<number> {
  const { log } = deps;
  const mode = parseValidateArgs(args);
  if (!mode) {
    for (const line of USAGE) log(line);
    return 1;
  }
  const files = validationFiles(deps.dir);
  const inputs = loadInputs(deps.dir);

  if (mode.kind === 'dry-run') {
    const scanClient = new CacheOnlyClient(deps.cache);
    const lookupClient = new CacheOnlyClient(deps.cache);
    const run = await runValidationPipeline({ inputs, scanClient, lookupClient, continuePastMisses: true });
    log('Dry run: nothing was spent; only the disk cache answered.');
    logScanPages(log, scanClient);
    log(`Cached lookup responses used: ${lookupClient.used.size}`);
    log(`Uncached searches needed now: ${run.missedLookups.size}`);
    for (const [key] of run.missedLookups) log(missLine(key, lookupClient.missed.get(key) ?? ''));
    log(`Fits the validation bucket's ${DEV_ALLOCATION.validation}: ${run.missedLookups.size <= DEV_ALLOCATION.validation ? 'yes' : 'no'}.`);
    log('Their answers may resolve more splits or name more parts, which a paid run looks up in a later pass.');
    await logWanted(log, run, deps.hdRows?.() ?? []);
    for (const p of run.problems) log(`Problem: ${p}`);
    logSummary(log, await buildResults(run));
    return 0;
  }

  if (mode.kind === 'replay') {
    const recorded = new ResponsesCache(files.responses);
    const run = await runValidationPipeline({
      inputs, scanClient: new CacheOnlyClient(recorded), lookupClient: new CacheOnlyClient(recorded), continuePastMisses: true,
    });
    const results = await buildResults(run);
    writeResults(files.results, results);
    log(`Replay: ${recorded.size} recorded responses, no network.`);
    if (run.missedLookups.size > 0) log(`Lookups with no recorded response (their parts wait): ${run.missedLookups.size}`);
    for (const p of run.problems) log(`Problem: ${p}`);
    logSummary(log, results);
    log(`Results: ${files.results}`);
    const labels = readLabels(files.labels);
    if (Object.keys(labels).length > 0) for (const line of scoreLines(scoreCriterion6(results, labels))) log(line);
    return 0;
  }

  let dev: Awaited<ReturnType<typeof openDevClient>>;
  try {
    dev = await deps.openClient(BUCKET, mode.n);
  } catch (err) {
    if (err instanceof NoKeyError || err instanceof SpendLockError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  try {
    log(`May spend up to ${dev.allowance} searches from the validation bucket.`);
    const scanClient = new CacheOnlyClient(deps.cache);
    const paid = new BucketClient(dev.client);
    const run = await runValidationPipeline({ inputs, scanClient, lookupClient: paid, continuePastMisses: false });
    const results = await buildResults(run);
    logScanPages(log, scanClient);
    const written = writeResponses(files.responses, new Map([...scanClient.used, ...paid.used]));
    writeResults(files.results, results);
    log(`Searches spent: ${paid.spent} (passes ${run.passes})`);
    if (run.stop !== null) log(`Stopped: ${run.stop}`);
    if (run.capReached !== null) {
      log(`Spending stopped at a limit (${run.capReached}); cached answers went on. Not sent, so their parts wait: ${run.refusedLookups.size}`);
      for (const [key] of run.refusedLookups) log(missLine(key, ''));
    }
    log(`Responses written: ${written} to ${files.responses}`);
    log(`Results: ${files.results}`);
    for (const p of run.problems) log(`Problem: ${p}`);
    logSummary(log, results);
    await logWanted(log, run, deps.hdRows?.() ?? []);
    for (const [key, f] of run.failedLookups) log(`Lookup failed (not charged, not retried): ${missLine(key, '').trim()}: ${f.message}`);
    return 0;
  } finally {
    dev.release();
  }
}
