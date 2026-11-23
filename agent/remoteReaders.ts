// Home Depot reads for scans and research, made by the paired Chrome extension as worker jobs (step 13, W4,
// Decision 4). Each reader queues one job, waits for its result with a timeout, and checks the result's shape: a
// result that is not what core expects is a failed read, never data (rule 4). A reader that throws is noted on the
// scan's job by the runner ("Reading Home Depot pages failed: ..."), which then reads nothing more that run; the
// pages stay unread and the next scan asks for them again. Whether to read at all (the helper is connected) is the
// caller's choice: with no helper the scan gets no reader, and its rows say "Chrome closed".

import type { WorkerJob, WorkerJobInputs, WorkerJobKind } from '../core/src/api/contract';
import { sameModel } from '../core/src/match';
import type { CatalogEntry, CatalogLookup, HomeDepotPage, HomeDepotSearch, ResearchTools, ToolError } from '../core/src/research/types';
import type { PageOutcome, PartPriceReading, ReadPages, ReadPartPrices, ScanStore } from '../core/src/scan/types';
import { type ListingSample, type PagePromotion, type PromoPage, SAMPLE_CHARS, SAMPLE_KINDS } from '../core/src/hdPage';
import { isBundleListingPath } from '../core/src/scan/listingSource';
import type { ListedItem, PromoPageOutcome } from '../core/src/tracking/bogoPairs';
import type { ListingPage } from '../core/src/scan/listingSource';
import type { WorkerJobs } from './workerJobs';

export interface ReaderTimeouts {
  /** A page or part-price job: this long, plus perItemMs for each page or part asked. */
  pageMs: number;
  perItemMs: number;
  /** One research tool call. */
  toolMs: number;
}

/** A batch of pages is read one after another with a pause between (hdReader.ts), so it gets time per page. */
export const DEFAULT_TIMEOUTS: ReaderTimeouts = { pageMs: 90_000, perItemMs: 20_000, toolMs: 90_000 };
/** Never longer than this for one job, however many pages it asks for. */
const MAX_WAIT_MS = 15 * 60_000;
/** As extension/lib/researchTools.ts: page reads plus searches one question may make. */
export const QUESTION_TOOL_LIMIT = 6;

export const NO_ANSWER = 'Chrome did not answer in time.';
const STOPPED = 'stopped';
const HOME_DEPOT = 'https://www.homedepot.com';
const ITEM_ID = /^\d{9}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const textOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
const numOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));
const onHomeDepot = (url: unknown): boolean => isText(url) && (url === HOME_DEPOT || url.startsWith(`${HOME_DEPOT}/`));

/** What came back instead of a page (its title), as the worker said it: plain text of at most 80 characters, or nothing. */
function noteOf(v: Record<string, unknown>): { note?: string } {
  if (!isText(v.note)) return {};
  const note = v.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return note === '' ? {} : { note };
}

/** A not-read outcome (unreadable, skipped, refused) in core's shape, keeping the status and the note; null for any other kind. */
function notReadOutcome(v: Record<string, unknown> & { itemId: string }): Exclude<PageOutcome, { kind: 'read' }> | null {
  if (v.kind === 'skipped') return { itemId: v.itemId, kind: 'skipped' };
  if (v.kind === 'unreadable') return { itemId: v.itemId, kind: 'unreadable', ...noteOf(v) };
  if (v.kind === 'refused') return { itemId: v.itemId, kind: 'refused', ...(typeof v.status === 'number' ? { status: v.status } : {}), ...noteOf(v) };
  return null;
}

function pageOutcome(v: unknown): PageOutcome | null {
  if (!isRecord(v) || !isText(v.itemId)) return null;
  if (v.kind === 'read') return isRecord(v.content) ? (v as unknown as PageOutcome) : null;
  return notReadOutcome(v as Record<string, unknown> & { itemId: string });
}

function partPriceReading(v: unknown): PartPriceReading | null {
  if (!isRecord(v) || !isText(v.brand) || !isText(v.model)) return null;
  if (v.status !== 'found' && v.status !== 'not_found' && v.status !== 'not_read') return null;
  if (!textOrNull(v.itemId) || !textOrNull(v.matchedModel) || !numOrNull(v.price) || !textOrNull(v.title) || !textOrNull(v.link)) return null;
  if (v.link !== null && !onHomeDepot(v.link)) return null;
  return v as unknown as PartPriceReading;
}

function toolError(v: unknown): ToolError | null {
  return isRecord(v) && isText(v.error) ? { error: v.error.slice(0, 500) } : null;
}

function researchPage(v: unknown): HomeDepotPage | ToolError {
  const err = toolError(v);
  if (err) return err;
  if (!isRecord(v) || !isText(v.sourceId) || !isText(v.label) || !onHomeDepot(v.url) || !isRecord(v.sections)) return { error: 'The Home Depot page came back in a form that could not be read.' };
  const s = v.sections;
  if (!isText(s.title) || !isText(s.model) || !Array.isArray(s.bullets) || !s.bullets.every(isText) || !isText(s.description) || !Array.isArray(s.specifications)) {
    return { error: 'The Home Depot page came back in a form that could not be read.' };
  }
  return v as unknown as HomeDepotPage;
}

function researchSearch(v: unknown): HomeDepotSearch | ToolError {
  const err = toolError(v);
  if (err) return err;
  const bad = { error: 'The Home Depot search came back in a form that could not be read.' };
  if (!isRecord(v) || !isText(v.sourceId) || !isText(v.label) || !onHomeDepot(v.url) || !Array.isArray(v.results)) return bad;
  const rows = v.results.filter((r) => isRecord(r) && isText(r.title) && isText(r.brand) && isText(r.model) && isText(r.itemId) && onHomeDepot(r.url));
  if (rows.length !== v.results.length) return bad;
  return { sourceId: v.sourceId, label: v.label, url: v.url as string, results: rows.slice(0, 10) as unknown as HomeDepotSearch['results'] };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function promotion(v: unknown): PagePromotion | null {
  if (!isRecord(v) || !isText(v.promotionId) || !/^\d{1,12}$/.test(v.promotionId) || !textOrNull(v.description)) return null;
  const date = (d: unknown) => d === null || (isText(d) && DAY.test(d));
  if (!date(v.startsAt) || !date(v.endsAt)) return null;
  return { promotionId: v.promotionId, startsAt: v.startsAt as string | null, endsAt: v.endsAt as string | null, description: v.description as string | null };
}

/** A promoPage outcome in core's shape, or null: a page whose fields are not all of the right kind is no page. */
function promoOutcome(v: unknown): PromoPageOutcome | null {
  if (!isRecord(v) || !isText(v.itemId) || !ITEM_ID.test(v.itemId)) return null;
  if (v.kind !== 'read') return notReadOutcome(v as Record<string, unknown> & { itemId: string });
  if (!isRecord(v.page)) return null;
  const p = v.page;
  if (p.itemId !== v.itemId || !isText(p.brand) || !isText(p.model) || !isText(p.title) || !numOrNull(p.price) || !numOrNull(p.wasPrice)) return null;
  if (!Array.isArray(p.bullets) || !p.bullets.every(isText) || !textOrNull(p.description) || !Array.isArray(p.promotions)) return null;
  const promotions = p.promotions.map(promotion);
  if (promotions.some((x) => x === null)) return null;
  const page: PromoPage = {
    itemId: v.itemId, brand: p.brand, model: p.model, title: p.title, price: p.price as number | null, wasPrice: p.wasPrice as number | null,
    bullets: p.bullets as string[], description: p.description as string | null, promotions: promotions as PagePromotion[],
  };
  return { itemId: v.itemId, kind: 'read', page };
}

/** A listing sample (hdPage.ts ListingSample) as the helper sent it: counts and at most 3 entries of bounded text; else none. */
function sampleOf(v: unknown): ListingSample | undefined {
  if (!isRecord(v) || !isRecord(v.kinds) || !Array.isArray(v.entries)) return undefined;
  const kinds = Object.entries(v.kinds).slice(0, 200);
  if (!kinds.every(([k, n]) => k.length <= 60 && typeof n === 'number' && Number.isInteger(n) && n >= 0)) return undefined;
  const entries = v.entries.slice(0, SAMPLE_KINDS);
  if (!entries.every((e) => isRecord(e) && isText(e.kind) && e.kind.length <= 60 && isText(e.key) && e.key.length <= 200 && isText(e.text) && e.text.length <= SAMPLE_CHARS)) return undefined;
  return { kinds: Object.fromEntries(kinds) as Record<string, number>, entries: entries.map((e) => ({ kind: e.kind as string, key: e.key as string, text: e.text as string })) };
}

function listedItems(v: unknown): ListedItem[] | null {
  if (!isRecord(v) || !Array.isArray(v.products)) return null;
  const out: ListedItem[] = [];
  for (const r of v.products) {
    if (!isRecord(r) || !isText(r.itemId) || !ITEM_ID.test(r.itemId) || !isText(r.brand) || !isText(r.model) || !isText(r.title) || !onHomeDepot(r.url)) return null;
    const item: ListedItem = { itemId: r.itemId, brand: r.brand, model: r.model, title: r.title, url: r.url as string };
    // Fix round: a listing entry's own pricing, checked as a promoPage's is; a malformed one makes the answer no answer.
    if ('price' in r || 'wasPrice' in r || 'promotions' in r) {
      if (!numOrNull(r.price) || !numOrNull(r.wasPrice ?? null) || !Array.isArray(r.promotions ?? [])) return null;
      const promotions = ((r.promotions ?? []) as unknown[]).map(promotion);
      if (promotions.some((p) => p === null)) return null;
      Object.assign(item, { price: r.price as number | null, wasPrice: (r.wasPrice ?? null) as number | null, promotions: promotions as PagePromotion[] });
    }
    // Fix round 3: a set's own list of items (item ids and quantities) and its listed saving; a malformed one is no answer.
    if ('set' in r) {
      const s = r.set;
      if (!isRecord(s) || !Array.isArray(s.items) || s.items.length === 0 || s.items.length > 20 || !numOrNull(s.dollarOff ?? null) || !numOrNull(s.percentageOff ?? null)) return null;
      const items = s.items.map((x) => (isRecord(x) && isText(x.itemId) && ITEM_ID.test(x.itemId) && typeof x.quantity === 'number' && Number.isInteger(x.quantity) && x.quantity >= 1 && x.quantity <= 20 ? { itemId: x.itemId, quantity: x.quantity } : null));
      if (items.some((x) => x === null)) return null;
      item.set = { items: items as { itemId: string; quantity: number }[], dollarOff: (s.dollarOff ?? null) as number | null, percentageOff: (s.percentageOff ?? null) as number | null };
    }
    out.push(item);
  }
  return out;
}

export interface RemoteReaders {
  /** One page of a Featured BOGO listing. Throws when Chrome could not read it or Home Depot refused it. */
  readBogoListing(path: string): Promise<ListedItem[]>;
  /** Free scan: one page of a brand's Bundle listing, with what its state held when it had no product. Throws when Chrome could not read it or Home Depot refused it. */
  readBundleListing(path: string): Promise<ListingPage>;
  /** Product pages with their BOGO promotions, one outcome per id. Throws as readPages. */
  readPromoPages(itemIds: string[]): Promise<PromoPageOutcome[]>;
  readPages: ReadPages;
  readPartPrices: ReadPartPrices;
  /** The research agent's tools for one question: the two Home Depot ones are worker jobs, the catalog is local. */
  researchTools(store: ScanStore): ResearchTools;
}

export function remoteReaders(deps: { jobs: WorkerJobs; timeouts?: Partial<ReaderTimeouts>; signal?: () => AbortSignal | undefined }): RemoteReaders {
  const t = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };

  /** Queues a job and resolves with its result; rejects on a timeout, a Stop, or a job the worker failed. */
  function run<K extends WorkerJobKind>(kind: K, input: WorkerJobInputs[K], waitMs: number, signal?: AbortSignal): Promise<unknown> {
    const job: WorkerJob = deps.jobs.enqueue(kind, input);
    const stop = signal ?? deps.signal?.();
    return new Promise((resolve, reject) => {
      let settled = false;
      const end = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop?.removeEventListener('abort', onAbort);
        fn();
      };
      const timer = setTimeout(() => end(() => {
        deps.jobs.cancel(job.id, NO_ANSWER);
        reject(new Error(NO_ANSWER));
      }), Math.min(waitMs, MAX_WAIT_MS));
      timer.unref?.();
      const onAbort = () => end(() => {
        deps.jobs.cancel(job.id, 'The scan was stopped.');
        reject(new Error(STOPPED));
      });
      if (stop?.aborted) return onAbort();
      stop?.addEventListener('abort', onAbort, { once: true });
      void deps.jobs.whenFinished(job.id).then((done) =>
        end(() => (done.status === 'done' ? resolve(done.result) : reject(new Error(done.error ?? 'Chrome could not read the page.')))),
      );
    });
  }

  const readPages: ReadPages = async (itemIds) => {
    const result = await run('page', { itemIds: [...itemIds] }, t.pageMs + t.perItemMs * itemIds.length);
    if (!Array.isArray(result)) throw new Error('The pages Chrome read could not be read.');
    return result.flatMap((r) => pageOutcome(r) ?? []);
  };

  /**
   * Step 9's reading of a part sold alone, with the jobs the extension runs (W5): Home Depot's search for the part, the
   * one result whose own model field is the part's (sameModel, RYOBI's B twin included), then that product's page by
   * item id (`partPrice`), whose reading must name the part's brand. No such result: not_found. A search or page Chrome
   * could not make (Home Depot refused, Chrome went away): this part and every one after it is not_read, and nothing more
   * is asked this run, as the extension's own reader stops at a refusal. Never an id guessed.
   */
  const readPartPrices: ReadPartPrices = async (parts) => {
    const out: PartPriceReading[] = [];
    const empty = (p: { brand: string; model: string }, status: 'not_found' | 'not_read'): PartPriceReading => ({
      brand: p.brand, model: p.model, status, itemId: null, matchedModel: null, price: null, title: null, link: null,
    });
    let stopped = false;
    for (const part of parts) {
      if (stopped) {
        out.push(empty(part, 'not_read'));
        continue;
      }
      let found: HomeDepotSearch | ToolError;
      try {
        found = researchSearch(await run('search', { query: `${part.brand} ${part.model}`, page: 1 }, t.toolMs));
      } catch {
        stopped = true;
        out.push(empty(part, 'not_read'));
        continue;
      }
      if ('error' in found) {
        stopped = true;
        out.push(empty(part, 'not_read'));
        continue;
      }
      const brand = part.brand.trim().toUpperCase();
      const exact = found.results.find((r) => r.brand.trim().toUpperCase() === brand && r.model.trim().toUpperCase() === part.model.trim().toUpperCase());
      const pick = exact ?? found.results.find((r) => r.brand.trim().toUpperCase() === brand && sameModel(part.brand, r.model, part.model));
      if (!pick || !ITEM_ID.test(pick.itemId)) {
        out.push(empty(part, 'not_found'));
        continue;
      }
      let raw: unknown;
      try {
        raw = await run('partPrice', { itemId: pick.itemId, model: part.model, brand: part.brand }, t.pageMs);
      } catch {
        stopped = true;
        out.push(empty(part, 'not_read'));
        continue;
      }
      const reading = partPriceReading(raw);
      if (!reading) throw new Error('The part price Chrome read could not be read.');
      if (reading.status === 'not_read') stopped = true;
      // The page is not this part's (another brand, another model): Home Depot showed no product for it.
      const samePart = reading.brand.trim().toUpperCase() === brand && (reading.matchedModel === null || sameModel(part.brand, reading.matchedModel, part.model));
      out.push(reading.status === 'found' && !samePart ? empty(part, 'not_found') : { ...reading, brand: part.brand, model: part.model });
    }
    return out;
  };

  const readBogoListing = async (path: string): Promise<ListedItem[]> => {
    const result = await run('bogoListing', { path }, t.pageMs);
    const err = toolError(result);
    if (err) throw new Error(err.error);
    const items = listedItems(result);
    if (items === null) throw new Error('The BOGO listing Chrome read could not be read.');
    return items;
  };

  const readBundleListing = async (path: string): Promise<ListingPage> => {
    const result = await run('bundleListing', { path }, t.pageMs);
    const err = toolError(result);
    if (err) throw new Error(err.error);
    const items = listedItems(result);
    if (items === null) throw new Error('The bundle list Chrome read could not be read.');
    const r = result as Record<string, unknown>;
    const note = noteOf(r).note;
    // Fix round 2: the redirect's final address only when it is a Bundle list path too (paged on next); the list's total;
    // an empty state's sample, kept only in its checked shape.
    const finalPath = isText(r.finalPath) && isBundleListingPath(r.finalPath) ? r.finalPath : undefined;
    const total = typeof r.total === 'number' && Number.isInteger(r.total) && r.total >= 0 && r.total < 1_000_000 ? r.total : undefined;
    const sample = sampleOf(r.sample);
    return { products: items, ...(note ? { note } : {}), ...(finalPath ? { finalPath } : {}), ...(total !== undefined ? { total } : {}), ...(sample ? { sample } : {}) };
  };

  const readPromoPages = async (itemIds: string[]): Promise<PromoPageOutcome[]> => {
    const result = await run('promoPage', { itemIds: [...itemIds] }, t.pageMs + t.perItemMs * itemIds.length);
    if (!Array.isArray(result)) throw new Error('The BOGO pages Chrome read could not be read.');
    return result.flatMap((r) => promoOutcome(r) ?? []);
  };

  function researchTools(store: ScanStore): ResearchTools {
    let used = 0;
    let refused = false;
    const REFUSED_BEFORE = 'Home Depot refused an earlier request; no more are made for this question.';
    const call = async <R>(kind: 'researchPage' | 'search', input: WorkerJobInputs['researchPage'] | WorkerJobInputs['search'], check: (v: unknown) => R | ToolError, signal?: AbortSignal): Promise<R | ToolError> => {
      if (signal?.aborted) return { error: STOPPED };
      if (refused) return { error: REFUSED_BEFORE };
      if (used >= QUESTION_TOOL_LIMIT) return { error: 'limit' };
      used += 1;
      try {
        const out = check(await run(kind, input as never, t.toolMs, signal));
        const err = toolError(out);
        if (err && /refused/i.test(err.error)) refused = true;
        return out;
      } catch (e) {
        return { error: e instanceof Error ? e.message : 'Chrome could not read Home Depot.' };
      }
    };
    return {
      readHomeDepotPage: async (input, signal) => {
        const itemId = homeDepotItemId(input);
        if (itemId === null) return { error: 'Give a 9-digit Home Depot item id or a https://www.homedepot.com/p/... address. Only homedepot.com pages can be read.' };
        return call<HomeDepotPage>('researchPage', { itemId }, researchPage, signal);
      },
      searchHomeDepot: async (input, signal) => {
        const query = typeof input.query === 'string' ? input.query.trim().replace(/\s+/g, ' ') : '';
        if (query === '' || query.length > 200) return { error: 'Give a search of 1 to 200 characters.' };
        return call<HomeDepotSearch>('search', { query, page: 1 }, researchSearch, signal);
      },
      catalogLookup: async (input): Promise<CatalogLookup> => {
        const model = typeof input.model === 'string' ? input.model.trim() : '';
        const words = (typeof input.query === 'string' ? input.query : '').toLowerCase().split(/\s+/).filter((w) => w !== '');
        const entries: CatalogEntry[] = [];
        if (model !== '' || words.length > 0) {
          for (const r of await store.listCatalog()) {
            if (model !== '' && !sameModel(r.brand, r.model, model)) continue;
            const text = `${r.brand} ${r.model} ${r.title}`.toLowerCase();
            if (!words.every((w) => text.includes(w))) continue;
            entries.push({ brand: r.brand, model: r.model, title: r.title, kind: r.isKit ? 'kit' : 'part' });
            if (entries.length >= 20) break;
          }
        }
        const slug = (model || words.join(' ')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        return { sourceId: `catalog:${slug || 'none'}`, entries };
      },
    };
  }

  return { readPages, readPartPrices, readBogoListing, readBundleListing, readPromoPages, researchTools };
}

/** As extension/lib/researchTools.ts homeDepotItemId: a 9-digit id, or the last segment of a homedepot.com /p/ address. */
export function homeDepotItemId(input: { itemId?: string; url?: string }): string | null {
  if (typeof input.itemId === 'string' && input.itemId.trim() !== '') return ITEM_ID.test(input.itemId.trim()) ? input.itemId.trim() : null;
  if (typeof input.url !== 'string' || input.url.trim() === '') return null;
  let u: URL;
  try {
    u = new URL(input.url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || (host !== 'homedepot.com' && host !== 'www.homedepot.com')) return null;
  const parts = u.pathname.split('/').filter((s) => s !== '');
  const last = parts[parts.length - 1] ?? '';
  return parts[0] === 'p' && parts.length >= 2 && ITEM_ID.test(last) ? last : null;
}
