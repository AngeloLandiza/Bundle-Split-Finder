// The free research tools of step 12's AI loop: read a Home Depot page, search Home Depot, look in the catalog.
// They never spend a SerpApi search and never touch Amazon. The two Home Depot tools read through the doorway tab
// (hdReader.ts), with its settle, pause and refusal rule; every Chrome call goes through ReaderEnv, so this file
// touches no chrome.* and is tested with fakes.
//
// Result shapes are the contract in core/src/research/types.ts (ResearchTools); nothing is defined twice.

import { parsePageSections, parseSearchText } from '@core/hdPage';
import { sameModel } from '@core/match';
import type { CatalogEntry, CatalogLookup, ResearchTools } from '@core/research/types';
import type { ScanStore } from '@core/scan/types';
import { fetchPagesInTab, type ReaderEnv } from './hdReader';

/** One product of a Home Depot search page, as the parser reads it. */
export interface SearchRow { title: string; brand: string; model: string; itemId: string }

/** What the in-tab search fetch brings back: the HTTP status and, for a 200, the page text. */
export interface SearchPageResult { status: number; text: string | null }

/** The most page reads plus searches one question may make; the catalog is local and not counted. */
export const QUESTION_TOOL_LIMIT = 6;
const SEARCH_RESULTS_MAX = 10;
const CATALOG_ENTRIES_MAX = 20;
const QUERY_MAX = 200;
const HOME_DEPOT = 'https://www.homedepot.com';
const LOAD_TIMEOUT_MS = 30_000;
/** What a call ended by the research's signal says; the tools turn it into their `stopped` answer. */
const STOPPED = 'stopped';

/** `work`'s result, or a rejection the moment `signal` fires. `work` is left to end on its own; its late result or failure is dropped. */
function untilStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new Error(STOPPED));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(STOPPED));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Shared by every tool of one question: `take()` is true while page reads and searches are left. */
export interface QuestionBudget {
  readonly limit: number;
  take(): boolean;
  used(): number;
}

export function createQuestionBudget(limit: number = QUESTION_TOOL_LIMIT): QuestionBudget {
  let used = 0;
  return {
    limit,
    take() {
      if (used >= limit) return false;
      used++;
      return true;
    },
    used: () => used,
  };
}

/** The research contract's tools, and the budget they share. */
export interface QuestionTools extends ResearchTools {
  budget: QuestionBudget;
  /** The local catalog never fails: narrower than the contract's `CatalogLookup | ToolError`. */
  catalogLookup(input: { model?: string; query?: string }): Promise<CatalogLookup>;
}

const ITEM_ID = /^\d{9}$/;

/**
 * The 9-digit Home Depot item id a tool call names: `itemId` itself, or the last path segment of a
 * `https://www.homedepot.com/p/<slug>/<id>` (or `/p/<id>`) address. Null for anything else, in particular any other host.
 */
export function homeDepotItemId(input: { itemId?: string; url?: string }): string | null {
  if (typeof input.itemId === 'string' && input.itemId.trim() !== '') {
    const id = input.itemId.trim();
    return ITEM_ID.test(id) ? id : null;
  }
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
  if (parts[0] !== 'p') return null;
  const last = parts[parts.length - 1] as string;
  return parts.length >= 2 && ITEM_ID.test(last) ? last : null;
}

/**
 * Runs inside the tab. Self-contained, like fetchPagesInTab (serialised by its source: no imports, no outside
 * variables). Fetches Home Depot's own `/s/<query>` same-origin and returns the status and, for a 200, the text from
 * `window.__APOLLO_STATE__=` to the next `</script>` (null when the page has none). A fetch that throws gives status 0.
 */
export async function fetchSearchPageInTab(query: string): Promise<SearchPageResult> {
  try {
    const res = await fetch(`/s/${encodeURIComponent(query)}`, { credentials: 'include' });
    const body = await res.text();
    let text: string | null = null;
    const mark = body.indexOf('window.__APOLLO_STATE__=');
    if (res.status === 200 && mark >= 0) {
      const end = body.indexOf('</script>', mark);
      text = end >= 0 ? body.slice(mark, end) : body.slice(mark);
    }
    return { status: res.status, text };
  } catch {
    return { status: 0, text: null };
  }
}

export interface ResearchToolsDeps {
  env: ReaderEnv;
  /** Only the catalog is read. */
  store: Pick<ScanStore, 'listCatalog'>;
  /**
   * Reads the products of the search page text fetchSearchPageInTab returns; null when it does not parse. By default
   * core's parseSearchText (the `base-searchNav-<id>` entries of the page's state, in page order).
   */
  parseSearch?: (pageText: string) => SearchRow[] | null;
  /** As createPageReader: waited once after the doorway tab loads, and between two doorways. */
  settleMs?: number;
  pauseMs?: number;
  now?: () => number;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const statusNote = (status: number): string => (status === 0 ? 'no answer' : `HTTP ${status}`);

/**
 * The tools one research loop may call. One set serves every question: a doorway is opened per Home Depot call, one at a
 * time, with the pause and settle the scan's readers keep. `forQuestion()` returns the tools bound to one question's
 * budget (a fresh one, or the one handed in); after Home Depot refuses a request, the rest of that question's Home Depot
 * calls answer so and make none, because a refusal is not retried.
 */
export function createResearchTools(deps: ResearchToolsDeps): { forQuestion(budget?: QuestionBudget): QuestionTools } {
  const { env, store } = deps;
  const settleMs = deps.settleMs ?? 2500;
  const pauseMs = deps.pauseMs ?? 1000;
  const now = deps.now ?? Date.now;
  let lastEnded: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * One doorway at a time; a failure of one call never blocks the next. `signal` is the research's: the owner's Stop or the question's
   * time limit. When it fires, the call in flight ends at once (the pause, the load, the settle or the read), the doorway tab is closed
   * and no tab is left open, and a call still waiting its turn opens none. The call then throws STOPPED.
   */
  const inDoorway = <T>(startUrl: string, run: (tabId: number) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const job = queue.then(async () => {
      if (signal?.aborted) throw new Error(STOPPED);
      if (lastEnded !== null) {
        const left = pauseMs - (now() - lastEnded);
        if (left > 0) await untilStopped(env.sleep(left), signal);
      }
      const stale = await env.remembered();
      if (stale !== null) {
        await env.closeTab(stale).catch(() => undefined);
        await env.remember(null);
      }
      if (signal?.aborted) throw new Error(STOPPED);
      const tabId = await env.openTab(startUrl);
      try {
        await env.remember(tabId);
        // Stopped while the tab was opening: the tab is known now, and closed below.
        if (signal?.aborted) throw new Error(STOPPED);
        try {
          await untilStopped(env.waitForLoad(tabId, LOAD_TIMEOUT_MS), signal);
        } catch (e) {
          if (signal?.aborted) throw new Error(STOPPED);
          throw new Error('The Home Depot tab did not load.');
        }
        if (settleMs > 0) await untilStopped(env.sleep(settleMs), signal);
        return await untilStopped(run(tabId), signal);
      } finally {
        await env.closeTab(tabId).catch(() => undefined);
        await env.remember(null).catch(() => undefined);
        lastEnded = now();
      }
    });
    queue = job.catch(() => undefined);
    return job;
  };

  return {
    forQuestion(given) {
      const budget = given ?? createQuestionBudget();
      let refused = false;
      const REFUSED_BEFORE = 'Home Depot refused an earlier request; no more are made for this question.';

      const readHomeDepotPage: QuestionTools['readHomeDepotPage'] = async (input, signal) => {
        const itemId = homeDepotItemId(input);
        if (itemId === null) return { error: 'Give a 9-digit Home Depot item id or a https://www.homedepot.com/p/... address. Only homedepot.com pages can be read.' };
        if (signal?.aborted) return { error: 'stopped' };
        if (refused) return { error: REFUSED_BEFORE };
        if (!budget.take()) return { error: 'limit' };
        try {
          const answered = await inDoorway(`${env.origin}/p/${itemId}`, (tabId) => env.runInTab(tabId, fetchPagesInTab, [[itemId], 1]), signal);
          const got = Array.isArray(answered) ? answered.find((r) => r.itemId === itemId) : undefined;
          if (got && got.status === 404) return { error: `Home Depot has no page for item ${itemId}.` };
          if (!got || got.status !== 200 || got.text === null) {
            refused = true;
            return { error: `Home Depot refused the page (${statusNote(got ? got.status : 0)}); no more are read for this question.` };
          }
          const sections = parsePageSections(got.text, itemId);
          if (sections === null) return { error: `The page for item ${itemId} could not be read.` };
          return { sourceId: `hd-page:${itemId}`, label: 'Home Depot page', url: `${HOME_DEPOT}/p/${itemId}`, sections };
        } catch (e) {
          if (signal?.aborted) return { error: STOPPED };
          return { error: e instanceof Error ? e.message : 'The Home Depot page could not be read.' };
        }
      };

      const searchHomeDepot: QuestionTools['searchHomeDepot'] = async (input, signal) => {
        const query = typeof input.query === 'string' ? input.query.trim().replace(/\s+/g, ' ') : '';
        if (query === '' || query.length > QUERY_MAX) return { error: `Give a search of 1 to ${QUERY_MAX} characters.` };
        if (signal?.aborted) return { error: 'stopped' };
        if (refused) return { error: REFUSED_BEFORE };
        if (!budget.take()) return { error: 'limit' };
        const url = `${env.origin}/s/${encodeURIComponent(query)}`;
        // The address a quote's source link shows is Home Depot's own, whatever origin the doorway read it from (the end-to-end build reads a local replay).
        const shownUrl = `${HOME_DEPOT}/s/${encodeURIComponent(query)}`;
        try {
          const answered = await inDoorway(url, (tabId) => env.runInTab(tabId, fetchSearchPageInTab, [query]), signal);
          if (!answered || answered.status !== 200 || answered.text === null) {
            refused = true;
            return { error: `Home Depot refused the search (${statusNote(answered ? answered.status : 0)}); no more are made for this question.` };
          }
          const rows = (deps.parseSearch ?? parseSearchText)(answered.text);
          if (rows === null) return { error: 'The search page could not be read.' };
          return {
            sourceId: `hd-search:${slug(query)}`,
            label: 'Home Depot search',
            url: shownUrl,
            results: rows.slice(0, SEARCH_RESULTS_MAX).map((r) => ({ title: r.title, brand: r.brand, model: r.model, itemId: r.itemId, url: `${HOME_DEPOT}/p/${r.itemId}` })),
          };
        } catch (e) {
          if (signal?.aborted) return { error: STOPPED };
          return { error: e instanceof Error ? e.message : 'The Home Depot search could not be read.' };
        }
      };

      const catalogLookup: QuestionTools['catalogLookup'] = async (input) => {
        const model = typeof input.model === 'string' ? input.model.trim() : '';
        const words = (typeof input.query === 'string' ? input.query : '').toLowerCase().split(/\s+/).filter((w) => w !== '');
        const sourceId = `catalog:${slug(model || words.join(' ')) || 'none'}`;
        const entries: CatalogEntry[] = [];
        if (model !== '' || words.length > 0) {
          for (const r of await store.listCatalog()) {
            if (model !== '' && !sameModel(r.brand, r.model, model)) continue;
            const text = `${r.brand} ${r.model} ${r.title}`.toLowerCase();
            if (!words.every((w) => text.includes(w))) continue;
            entries.push({ brand: r.brand, model: r.model, title: r.title, kind: r.isKit ? 'kit' : 'part' });
            if (entries.length >= CATALOG_ENTRIES_MAX) break;
          }
        }
        return { sourceId, entries };
      };

      return { budget, readHomeDepotPage, searchHomeDepot, catalogLookup };
    },
  };
}
