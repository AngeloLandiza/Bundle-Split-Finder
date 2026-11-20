// The free research tools of step 12's AI loop: read a Home Depot page, search Home Depot, look in the catalog.
// They never spend a SerpApi search and never touch Amazon. The two Home Depot tools read through the doorway tab
// (hdReader.ts), with its settle, pause and refusal rule; every Chrome call goes through ReaderEnv, so this file
// touches no chrome.* and is tested with fakes.
//
// Result shapes are the contract the loop in core/src/research is written against. If core/src/research/types.ts
// ever defines them, import them from there and delete the copies below.

import { parsePageSections, type PageSections } from '@core/hdPage';
import { sameModel } from '@core/match';
import type { ScanStore } from '@core/scan/types';
import { fetchPagesInTab, type ReaderEnv } from './hdReader';

export type ToolError = { error: string };

export interface HdPageResult {
  sourceId: string;
  label: 'Home Depot page';
  url: string;
  sections: PageSections;
}

export interface HdSearchResult {
  sourceId: string;
  label: 'Home Depot search';
  url: string;
  results: { title: string; brand: string; model: string; itemId: string; url: string }[];
}

export interface CatalogResult {
  sourceId: string;
  label: 'Catalog';
  entries: { brand: string; model: string; title: string; kind: string }[];
}

/** One product of a Home Depot search page, as the parser reads it. */
export interface SearchRow { title: string; brand: string; model: string; itemId: string }

/** What the in-tab search fetch brings back: the HTTP status and, for a 200, the page text. */
export interface SearchPageResult { status: number; text: string | null }

/** The most page reads plus searches one question may make; the catalog is local and not counted. */
export const QUESTION_TOOL_LIMIT = 6;
const SEARCH_RESULTS_MAX = 10;
const CATALOG_ENTRIES_MAX = 20;
const QUERY_MAX = 200;
const LOAD_TIMEOUT_MS = 30_000;

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

export interface QuestionTools {
  budget: QuestionBudget;
  readHomeDepotPage(input: { itemId?: string; url?: string }): Promise<HdPageResult | ToolError>;
  searchHomeDepot(input: { query: string }): Promise<HdSearchResult | ToolError>;
  catalogLookup(input: { model?: string; query?: string }): Promise<CatalogResult>;
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
 * variables). Fetches Home Depot's own `/s/<query>` same-origin and returns the status and, for a 200, the page text.
 * A fetch that throws gives status 0.
 */
export async function fetchSearchPageInTab(query: string): Promise<SearchPageResult> {
  try {
    const res = await fetch(`/s/${encodeURIComponent(query)}`, { credentials: 'include' });
    const body = await res.text();
    return { status: res.status, text: res.status === 200 ? body : null };
  } catch {
    return { status: 0, text: null };
  }
}

export interface ResearchToolsDeps {
  env: ReaderEnv;
  /** Only the catalog is read. */
  store: Pick<ScanStore, 'listCatalog'>;
  /**
   * Reads the products of a Home Depot search page; null when the page is not a search page it understands. Not wired
   * yet: no search page has been recorded to write it against (see docs/decisions.md), and without it every search
   * answers that the page could not be read.
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

  /** One doorway at a time; a failure of one call never blocks the next. */
  const inDoorway = <T>(startUrl: string, run: (tabId: number) => Promise<T>): Promise<T> => {
    const job = queue.then(async () => {
      if (lastEnded !== null) {
        const left = pauseMs - (now() - lastEnded);
        if (left > 0) await env.sleep(left);
      }
      const stale = await env.remembered();
      if (stale !== null) {
        await env.closeTab(stale).catch(() => undefined);
        await env.remember(null);
      }
      const tabId = await env.openTab(startUrl);
      try {
        await env.remember(tabId);
        try {
          await env.waitForLoad(tabId, LOAD_TIMEOUT_MS);
        } catch {
          throw new Error('The Home Depot tab did not load.');
        }
        if (settleMs > 0) await env.sleep(settleMs);
        return await run(tabId);
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

      const readHomeDepotPage: QuestionTools['readHomeDepotPage'] = async (input) => {
        const itemId = homeDepotItemId(input);
        if (itemId === null) return { error: 'Give a 9-digit Home Depot item id or a https://www.homedepot.com/p/... address. Only homedepot.com pages can be read.' };
        if (refused) return { error: REFUSED_BEFORE };
        if (!budget.take()) return { error: 'limit' };
        try {
          const answered = await inDoorway(`${env.origin}/p/${itemId}`, (tabId) => env.runInTab(tabId, fetchPagesInTab, [[itemId], 1]));
          const got = Array.isArray(answered) ? answered.find((r) => r.itemId === itemId) : undefined;
          if (got && got.status === 404) return { error: `Home Depot has no page for item ${itemId}.` };
          if (!got || got.status !== 200 || got.text === null) {
            refused = true;
            return { error: `Home Depot refused the page (${statusNote(got ? got.status : 0)}); no more are read for this question.` };
          }
          const sections = parsePageSections(got.text, itemId);
          if (sections === null) return { error: `The page for item ${itemId} could not be read.` };
          return { sourceId: `hd-page-${itemId}`, label: 'Home Depot page', url: `${env.origin}/p/${itemId}`, sections };
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'The Home Depot page could not be read.' };
        }
      };

      const searchHomeDepot: QuestionTools['searchHomeDepot'] = async (input) => {
        const query = typeof input.query === 'string' ? input.query.trim().replace(/\s+/g, ' ') : '';
        if (query === '' || query.length > QUERY_MAX) return { error: `Give a search of 1 to ${QUERY_MAX} characters.` };
        if (refused) return { error: REFUSED_BEFORE };
        if (!budget.take()) return { error: 'limit' };
        const url = `${env.origin}/s/${encodeURIComponent(query)}`;
        try {
          const answered = await inDoorway(url, (tabId) => env.runInTab(tabId, fetchSearchPageInTab, [query]));
          if (!answered || answered.status !== 200 || answered.text === null) {
            refused = true;
            return { error: `Home Depot refused the search (${statusNote(answered ? answered.status : 0)}); no more are made for this question.` };
          }
          const rows = deps.parseSearch ? deps.parseSearch(answered.text) : null;
          if (rows === null) return { error: 'The search page could not be read.' };
          return {
            sourceId: `hd-search-${slug(query)}`,
            label: 'Home Depot search',
            url,
            results: rows.slice(0, SEARCH_RESULTS_MAX).map((r) => ({ title: r.title, brand: r.brand, model: r.model, itemId: r.itemId, url: `${env.origin}/p/${r.itemId}` })),
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'The Home Depot search could not be read.' };
        }
      };

      const catalogLookup: QuestionTools['catalogLookup'] = async (input) => {
        const model = typeof input.model === 'string' ? input.model.trim() : '';
        const words = (typeof input.query === 'string' ? input.query : '').toLowerCase().split(/\s+/).filter((w) => w !== '');
        const sourceId = `catalog-${slug(model || words.join(' ')) || 'none'}`;
        const entries: CatalogResult['entries'] = [];
        if (model !== '' || words.length > 0) {
          for (const r of await store.listCatalog()) {
            if (model !== '' && !sameModel(r.brand, r.model, model)) continue;
            const text = `${r.brand} ${r.model} ${r.title}`.toLowerCase();
            if (!words.every((w) => text.includes(w))) continue;
            entries.push({ brand: r.brand, model: r.model, title: r.title, kind: r.isKit ? 'kit' : r.kinds.join(', ') || 'unknown' });
            if (entries.length >= CATALOG_ENTRIES_MAX) break;
          }
        }
        return { sourceId, label: 'Catalog', entries };
      };

      return { budget, readHomeDepotPage, searchHomeDepot, catalogLookup };
    },
  };
}
