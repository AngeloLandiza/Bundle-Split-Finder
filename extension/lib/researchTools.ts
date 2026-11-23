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
import {
  createUnreadableRun, DOORWAY_STATE_MS, fetchPagesInTab, fetchPathInTab, STOPPED, titled, untilStopped, withDoorway, type DoorwayRun, type PathInTab, type ReaderEnv,
} from './hdReader';

/** One product of a Home Depot search page, as the parser reads it. */
export interface SearchRow { title: string; brand: string; model: string; itemId: string }

/** What the in-tab search fetch brings back: the HTTP status and, for a 200, the page text (hdReader's fetchPathInTab). */
export type SearchPageResult = PathInTab;

/** The most page reads plus searches one question may make; the catalog is local and not counted. */
export const QUESTION_TOOL_LIMIT = 6;
const SEARCH_RESULTS_MAX = 10;
const CATALOG_ENTRIES_MAX = 20;
const QUERY_MAX = 200;
const HOME_DEPOT = 'https://www.homedepot.com';

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
  /** How long the doorway's own page may take to show its state (hdReader's DOORWAY_STATE_MS). */
  doorwayStateMs?: number;
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
  const doorwayStateMs = deps.doorwayStateMs ?? DOORWAY_STATE_MS;
  const now = deps.now ?? Date.now;
  let lastEnded: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * One doorway at a time; a failure of one call never blocks the next. `signal` is the research's: the owner's Stop or the question's
   * time limit. When it fires, the call in flight ends at once (the pause, the load, the settle or the read), the doorway tab is closed
   * and no tab is left open, and a call still waiting its turn opens none. The call then throws STOPPED.
   */
  const inDoorway = <T>(startUrl: string, run: (tabId: number) => Promise<T>, signal?: AbortSignal): Promise<DoorwayRun<T>> => {
    const job = queue.then(async () => {
      if (signal?.aborted) throw new Error(STOPPED);
      if (lastEnded !== null) {
        const left = pauseMs - (now() - lastEnded);
        if (left > 0) await untilStopped(env.sleep(left), signal);
      }
      try {
        // Nov 23: nothing is read until the doorway's own page shows its state (hdReader's withDoorway).
        return await withDoorway(env, startUrl, { settleMs, doorwayStateMs, ...(signal ? { signal } : {}) }, run);
      } finally {
        lastEnded = now();
      }
    });
    queue = job.catch(() => undefined);
    return job;
  };

  return {
    forQuestion(given) {
      const budget = given ?? createQuestionBudget();
      // Why no more Home Depot calls are made for this question: a real refusal (403, 429, 5xx, a failed fetch, a doorway that
      // never showed its page's state), or two pages in a row that came back without their data. Null until one happens.
      const stop: { said: string | null } = { said: null };
      const unreadableRun = createUnreadableRun();
      const REFUSED_BEFORE = 'Home Depot refused an earlier request; no more are made for this question.';
      const UNREADABLE_BEFORE = 'Home Depot answered two requests in a row without their data; no more are made for this question.';
      const refuse = (): void => {
        stop.said = REFUSED_BEFORE;
      };
      // A 200 without the page's state: not a refusal. Said in words with the page's title; two in a row end the question's reads.
      const unreadable = (what: string, note: string | undefined): { error: string } => {
        if (unreadableRun.unreadable()) stop.said = UNREADABLE_BEFORE;
        return { error: `${what} came back without its data${titled(note ?? '')}.` };
      };
      const doorwayNever = (what: string, title: string): { error: string } => {
        refuse();
        return { error: `Home Depot refused the ${what} (its own page never showed its data${titled(title)}); no more are ${what === 'page' ? 'read' : 'made'} for this question.` };
      };

      const readHomeDepotPage: QuestionTools['readHomeDepotPage'] = async (input, signal) => {
        const itemId = homeDepotItemId(input);
        if (itemId === null) return { error: 'Give a 9-digit Home Depot item id or a https://www.homedepot.com/p/... address. Only homedepot.com pages can be read.' };
        if (signal?.aborted) return { error: 'stopped' };
        if (stop.said !== null) return { error: stop.said };
        if (!budget.take()) return { error: 'limit' };
        try {
          const door = await inDoorway(`${env.origin}/p/${itemId}`, (tabId) => env.runInTab(tabId, fetchPagesInTab, [[itemId], 1]), signal);
          if (!door.shown) return doorwayNever('page', door.title);
          const answered = door.value;
          const got = Array.isArray(answered) ? answered.find((r) => r.itemId === itemId) : undefined;
          if (got && got.status === 404) return { error: `Home Depot has no page for item ${itemId}.` };
          if (got && got.status === 200 && got.text === null) return unreadable(`The page for item ${itemId}`, got.note);
          if (!got || got.status !== 200 || got.text === null) {
            refuse();
            return { error: `Home Depot refused the page (${statusNote(got ? got.status : 0)}); no more are read for this question.` };
          }
          unreadableRun.read();
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
        if (stop.said !== null) return { error: stop.said };
        if (!budget.take()) return { error: 'limit' };
        const url = `${env.origin}/s/${encodeURIComponent(query)}`;
        // The address a quote's source link shows is Home Depot's own, whatever origin the doorway read it from (the end-to-end build reads a local replay).
        const shownUrl = `${HOME_DEPOT}/s/${encodeURIComponent(query)}`;
        try {
          const door = await inDoorway(url, (tabId) => env.runInTab(tabId, fetchPathInTab, [`/s/${encodeURIComponent(query)}`]), signal);
          if (!door.shown) return doorwayNever('search', door.title);
          const answered = door.value;
          if (answered && answered.status === 200 && answered.text === null) return unreadable('The search', answered.note);
          if (!answered || answered.status !== 200 || answered.text === null) {
            refuse();
            return { error: `Home Depot refused the search (${statusNote(answered ? answered.status : 0)}); no more are made for this question.` };
          }
          unreadableRun.read();
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
