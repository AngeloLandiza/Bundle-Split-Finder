// Research tools that answer only from recorded files (step 12, R1): for the tests and for
// `npm run research:eval`. Nothing here fetches. A page with no recording answers
// { error: 'not recorded' }, so a real model run with these tools never reaches Home Depot.
//
// Pages, in the order a page is looked for:
//   fixtures/research/tools/*.json              recordings made for research (format in about.json)
//   fixtures/homedepot-pages/research-*.json    Home Depot pages with specifications and free-text
//                                               searches, recorded in the owner's Chrome (Nov 20)
//   fixtures/validation/pages-*.json, kit-pages-*.json   the validation set's pages (Nov 18): title,
//                                               model and the Includes bullets only, no specifications
// Pages and searches of research-*.json are read with the extension's own readers (core/src/hdPage.ts:
// parsePageState, parseSearchState), so the eval sees what the extension would.
//
// Searches (fix round 1): a query recorded word for word answers as Home Depot did. Any other query
// answers from the recorded index: every product a recorded search or page shows (the Nov 20 searches
// and pages, the validation pages; the validation set's part price lookups only when asked for, fix round 3:
// they were searched by the true parts' numbers and favour them), ranked by a model number of the query
// matching the product's model as a whole token first, then by how many of the query's words its title
// holds; up to 10. The index is not Home Depot's ranking, and its results are labelled so.
// The catalog is the validation replay's catalog (the store the replay builds from recorded files).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePageState, parseSearchState } from '../core/src/hdPage';
import { hasModelToken, modelForms } from '../core/src/match';
import type {
  CatalogEntry, CatalogLookup, HomeDepotPage, HomeDepotSearch, HomeDepotSearchRow, PageSections, ResearchTools, ToolError,
} from '../core/src/research/types';

const HD = 'https://www.homedepot.com';
const NOT_RECORDED: ToolError = { error: 'not recorded' };
/** The label of a search answered from the recorded index, not by a recorded search. */
export const INDEX_LABEL = 'Home Depot search (recorded index)';
export const SEARCH_ROWS = 10;

/** A file in fixtures/research/tools/: pages by item id and searches by query, in the tools' own result shapes. */
export interface ResearchToolsFile {
  about: string;
  /** True when the results were put together by hand from recorded rows rather than recorded as they are. */
  constructed?: boolean;
  pages?: Record<string, HomeDepotPage>;
  searches?: Record<string, HomeDepotSearch>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A page of research-*.json as the read_homedepot_page result, read as the extension reads it. */
export function pageFromState(itemId: string, page: unknown): HomeDepotPage | null {
  const sections = parsePageState(page, itemId);
  if (!sections) return null;
  return { sourceId: `hd-page:${itemId}`, label: 'Home Depot page', url: `${HD}/p/${itemId}`, sections };
}

const queryKey = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');
const slug = (q: string): string => queryKey(q).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** A search of research-*.json as the search_homedepot result: the first 10 products in page order. */
export function searchFromState(query: string, search: unknown): HomeDepotSearch {
  const rows = parseSearchState(obj(search).state).slice(0, SEARCH_ROWS);
  return {
    sourceId: `hd-search:${slug(query)}`, label: 'Home Depot search', url: `${HD}/s/${encodeURIComponent(query)}`,
    results: rows.map((r) => ({ title: r.title, brand: r.brand, model: r.model, itemId: r.itemId, url: `${HD}/p/${r.itemId}` })),
  };
}

/** A validation-set page (ProductPage form: title, model, Includes bullets, description). */
function pageFromValidation(itemId: string, p: unknown): HomeDepotPage {
  const v = obj(p);
  const bullets = Array.isArray(v.bullets) ? v.bullets.map(text) : [];
  const sections: PageSections = { title: text(v.title), model: text(v.model), bullets, description: text(v.description), specifications: [] };
  return { sourceId: `hd-page:${itemId}`, label: 'Home Depot page', url: `${HD}/p/${itemId}`, sections };
}

export interface RecordedSources {
  pages: Map<string, HomeDepotPage>;
  searches: Map<string, HomeDepotSearch>;
  /** Every product a recorded search or page shows, once per item id, in the order first seen. */
  products: HomeDepotSearchRow[];
}

const jsonFiles = (dir: string, prefix = ''): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith(prefix)).sort().map((f) => join(dir, f)) : [];

/**
 * Every recorded page, search and product under `fixtures`, the more specific files first (a page found earlier wins).
 * `partPrices` (fix round 3, off by default): also index the validation set's part price lookups. They were searched
 * by the true parts' model numbers, so they hold the very products the key names and make the eval optimistic.
 */
export function loadRecordedSources(fixtures: string, opts: { partPrices?: boolean } = {}): RecordedSources {
  const pages = new Map<string, HomeDepotPage>();
  const searches = new Map<string, HomeDepotSearch>();
  const products = new Map<string, HomeDepotSearchRow>();
  const product = (r: { itemId: string; brand: string; model: string; title: string }) => {
    if (r.itemId && r.model && r.title && !products.has(r.itemId)) {
      products.set(r.itemId, { itemId: r.itemId, brand: r.brand, model: r.model, title: r.title, url: `${HD}/p/${r.itemId}` });
    }
  };
  const read = (f: string): Json => obj(JSON.parse(readFileSync(f, 'utf8')));
  for (const f of jsonFiles(join(fixtures, 'research', 'tools'))) {
    const doc = read(f) as unknown as ResearchToolsFile;
    for (const [id, p] of Object.entries(doc.pages ?? {})) if (!pages.has(id)) pages.set(id, p);
    for (const [q, s] of Object.entries(doc.searches ?? {})) {
      if (!searches.has(queryKey(q))) searches.set(queryKey(q), s);
      for (const r of s.results) product(r);
    }
  }
  for (const f of jsonFiles(join(fixtures, 'homedepot-pages'), 'research-')) {
    const doc = read(f);
    for (const [q, s] of Object.entries(obj(doc.searches))) {
      if (!searches.has(queryKey(q))) searches.set(queryKey(q), searchFromState(q, s));
      for (const r of parseSearchState(obj(s).state)) product(r);
    }
    for (const [id, p] of Object.entries(obj(doc.pages))) {
      const page = pageFromState(id, p);
      if (!page) continue;
      if (!pages.has(id)) pages.set(id, page);
      const brand = text(obj(obj(obj(p)[`base-catalog-${id}`]).identifiers).brandName);
      product({ itemId: id, brand, model: page.sections.model, title: page.sections.title });
    }
  }
  const vdir = join(fixtures, 'validation');
  for (const f of [...jsonFiles(vdir, 'pages-'), ...jsonFiles(vdir, 'kit-pages-')]) {
    for (const [id, p] of Object.entries(obj(read(f).pages))) {
      if (!pages.has(id)) pages.set(id, pageFromValidation(id, p));
      const v = obj(p);
      product({ itemId: id, brand: text(v.brand), model: text(v.model), title: text(v.title) });
    }
  }
  // The validation set's part searches (Nov 18): Home Depot's product for each part model, from its search and page.
  for (const f of opts.partPrices ? jsonFiles(vdir, 'hd-part-prices-') : []) {
    for (const r of Object.values(obj(read(f).prices)).map(obj)) {
      product({ itemId: text(r.itemId), brand: text(r.brand), model: text(r.matchedModel), title: text(r.title) });
    }
  }
  return { pages, searches, products: [...products.values()] };
}

// Words that say nothing about which product is meant.
const STOP = new Set(['ryobi', 'dewalt', 'the', 'and', 'with', 'for', 'of', 'a', 'in', 'w']);
const words = (s: string): string[] => [...new Set(s.toLowerCase().split(/[^a-z0-9+]+/).filter((w) => w.length > 0 && !STOP.has(w)))];

/**
 * The recorded index's answer to a query: products whose model the query names as a whole token (any
 * written form, modelForms) first, then products whose title holds the most of the query's words (at
 * least two, or all when the query has fewer), within the brand the query names, if it names one. Up to 10.
 */
export function searchIndex(products: HomeDepotSearchRow[], query: string): HomeDepotSearchRow[] {
  const q = query.toUpperCase();
  const brands = ['RYOBI', 'DEWALT'].filter((b) => new RegExp(`\\b${b}\\b`).test(q));
  const pool = brands.length > 0 ? products.filter((p) => brands.includes(p.brand.toUpperCase())) : products;
  const byModel = pool.filter((p) => modelForms(p.brand, p.model).some((f) => hasModelToken(q, f)));
  const qw = words(query);
  const need = Math.min(2, qw.length);
  const scored = pool
    .filter((p) => !byModel.includes(p))
    .map((p, i) => ({ p, i, n: (() => { const tw = new Set(words(p.title)); return qw.filter((w) => tw.has(w)).length; })() }))
    .filter((x) => need > 0 && x.n >= need)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.p);
  return [...byModel, ...scored].slice(0, SEARCH_ROWS);
}

export interface ToolCallLog {
  tool: 'readHomeDepotPage' | 'searchHomeDepot' | 'catalogLookup';
  input: unknown;
  recorded: boolean;
  /** Where the answer came from: a recording, the recorded index (searches), or nothing. */
  source: 'recorded' | 'recorded index' | 'not recorded';
  /** The result the tool gave, so a replay can give the model the same (fix round 1). */
  result?: unknown;
}

/**
 * Tools over recorded sources and a catalog. `log` receives every call. A page is found by item id, or
 * by the item id at the end of a homedepot.com address; a search by its words (case and spacing aside),
 * else from the recorded index.
 */
export function recordedTools(sources: RecordedSources, catalog: CatalogEntry[], log: ToolCallLog[] = []): ResearchTools {
  return {
    async readHomeDepotPage(input) {
      const id = input.itemId ?? /\/(\d{6,12})(?:[/?#]|$)/.exec(input.url ?? '')?.[1];
      const page = id ? sources.pages.get(id) : undefined;
      const result = page ?? NOT_RECORDED;
      log.push({ tool: 'readHomeDepotPage', input, recorded: !!page, source: page ? 'recorded' : 'not recorded', result });
      return result;
    },
    async searchHomeDepot(input) {
      const exact = sources.searches.get(queryKey(input.query));
      if (exact) {
        log.push({ tool: 'searchHomeDepot', input, recorded: true, source: 'recorded', result: exact });
        return exact;
      }
      const rows = searchIndex(sources.products, input.query);
      const result: HomeDepotSearch = {
        sourceId: `hd-search:index-${slug(input.query)}`, label: INDEX_LABEL, url: `${HD}/s/${encodeURIComponent(input.query)}`, results: rows,
      };
      log.push({ tool: 'searchHomeDepot', input, recorded: true, source: 'recorded index', result });
      return result;
    },
    async catalogLookup(input): Promise<CatalogLookup> {
      const model = input.model?.trim().toUpperCase();
      const qw = (input.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const entries = catalog.filter((c) =>
        (model ? hasModelToken(c.model, model) || hasModelToken(model, c.model) : true) &&
        (qw.length > 0 ? qw.every((w) => `${c.brand} ${c.model} ${c.title}`.toLowerCase().includes(w)) : true)).slice(0, SEARCH_ROWS);
      const result = { sourceId: `catalog:${model ?? slug(input.query ?? '')}`, entries };
      log.push({ tool: 'catalogLookup', input, recorded: true, source: 'recorded', result });
      return result;
    },
  };
}

/**
 * Tools that give back, call by call, the results a recorded run's tools gave (its ToolCallLog), so a
 * replay shows the model's turns the same results they answered. A call that does not match the log
 * (another tool, or past its end) answers 'not recorded'.
 */
export function replayedTools(log: ToolCallLog[]): ResearchTools {
  let i = 0;
  const next = async <T>(tool: ToolCallLog['tool']): Promise<T | ToolError> => {
    const call = log[i++];
    return call && call.tool === tool && call.result !== undefined ? (call.result as T) : NOT_RECORDED;
  };
  return {
    readHomeDepotPage: () => next<HomeDepotPage>('readHomeDepotPage'),
    searchHomeDepot: () => next<HomeDepotSearch>('searchHomeDepot'),
    catalogLookup: () => next<CatalogLookup>('catalogLookup'),
  };
}
