// Research tools that answer only from recorded files (step 12, R1): for the tests and for
// `npm run research:eval`. Nothing here fetches. A page or search with no recording answers
// { error: 'not recorded' }, so a real model run with these tools never reaches Home Depot.
//
// Sources, in the order a page is looked for:
//   fixtures/research/tools/*.json              recordings made for research (format below)
//   fixtures/homedepot-pages/research-*.json    Home Depot pages with specifications and free-text
//                                               searches, recorded in the owner's Chrome (Nov 20)
//   fixtures/validation/pages-*.json, kit-pages-*.json   the validation set's pages (Nov 18): title,
//                                               model and the Includes bullets only, no specifications
// The catalog is the validation replay's catalog (the store the replay builds from recorded files).
//
// The mapping of a recorded page to PageSections is this file's reading of the recorded state, made
// for R1's tests: bullets are the highlights then the descriptive attributes' values, specifications
// are every specificationGroup row. The extension's own reader (R2) may differ; recordings it makes
// for fixtures/research/tools/ are used as they are.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CatalogEntry, CatalogLookup, HomeDepotPage, HomeDepotSearch, PageSections, ResearchTools, ToolError } from '../core/src/research/types';
import { hasModelToken } from '../core/src/match';

const HD = 'https://www.homedepot.com';
const NOT_RECORDED: ToolError = { error: 'not recorded' };

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

/** A page of research-*.json (base-catalog-<id> of the page's state) as the read_homedepot_page result. */
export function pageFromState(itemId: string, page: unknown): HomeDepotPage | null {
  const p = obj(obj(page)[`base-catalog-${itemId}`]);
  if (Object.keys(p).length === 0) return null;
  const ids = obj(p.identifiers);
  const details = obj(p.details);
  const highlights = Array.isArray(details.highlights) ? details.highlights.map(text).filter((s) => s !== '') : [];
  const attrs = Array.isArray(details.descriptiveAttributes) ? details.descriptiveAttributes.map((a) => text(obj(a).value)).filter((s) => s !== '') : [];
  const specifications = (Array.isArray(p.specificationGroup) ? p.specificationGroup : []).flatMap((g) =>
    (Array.isArray(obj(g).specifications) ? (obj(g).specifications as unknown[]) : []).map((s) => ({ name: text(obj(s).specName), value: text(obj(s).specValue) })));
  const sections: PageSections = { title: text(ids.productLabel), model: text(ids.modelNumber), bullets: [...highlights, ...attrs], description: text(details.description), specifications };
  const path = text(ids.canonicalUrl);
  return { sourceId: `hd-page:${itemId}`, label: 'Home Depot page', url: path ? `${HD}${path}` : `${HD}/p/${itemId}`, sections };
}

/** A search of research-*.json as the search_homedepot result: the first 10 products in page order. */
export function searchFromState(query: string, search: unknown): HomeDepotSearch {
  const state = obj(obj(search).state);
  const results = Object.values(state).map(obj).slice(0, 10).map((r) => {
    const ids = obj(r.identifiers);
    const itemId = text(r.itemId);
    return { title: text(ids.productLabel), brand: text(ids.brandName), model: text(ids.modelNumber), itemId, url: `${HD}${text(ids.canonicalUrl) || `/p/${itemId}`}` };
  });
  return { sourceId: `hd-search:${query}`, label: 'Home Depot search', url: `${HD}/s/${encodeURIComponent(query)}`, results };
}

/** A validation-set page (ProductPage form: title, model, Includes bullets, description). */
function pageFromValidation(itemId: string, p: unknown): HomeDepotPage {
  const v = obj(p);
  const bullets = Array.isArray(v.bullets) ? v.bullets.map(text) : [];
  return {
    sourceId: `hd-page:${itemId}`, label: 'Home Depot page', url: `${HD}/p/${itemId}`,
    sections: { title: text(v.title), model: text(v.model), bullets, description: text(v.description), specifications: [] },
  };
}

const queryKey = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');

export interface RecordedSources {
  pages: Map<string, HomeDepotPage>;
  searches: Map<string, HomeDepotSearch>;
}

const jsonFiles = (dir: string, prefix = ''): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith(prefix)).sort().map((f) => join(dir, f)) : [];

/** Every recorded page and search under `fixtures`, the more specific files first (a page found earlier wins). */
export function loadRecordedSources(fixtures: string): RecordedSources {
  const pages = new Map<string, HomeDepotPage>();
  const searches = new Map<string, HomeDepotSearch>();
  const read = (f: string): Json => obj(JSON.parse(readFileSync(f, 'utf8')));
  for (const f of jsonFiles(join(fixtures, 'research', 'tools'))) {
    const doc = read(f) as unknown as ResearchToolsFile;
    for (const [id, p] of Object.entries(doc.pages ?? {})) if (!pages.has(id)) pages.set(id, p);
    for (const [q, s] of Object.entries(doc.searches ?? {})) if (!searches.has(queryKey(q))) searches.set(queryKey(q), s);
  }
  for (const f of jsonFiles(join(fixtures, 'homedepot-pages'), 'research-')) {
    const doc = read(f);
    for (const [id, p] of Object.entries(obj(doc.pages))) {
      const page = pageFromState(id, p);
      if (page && !pages.has(id)) pages.set(id, page);
    }
    for (const [q, s] of Object.entries(obj(doc.searches))) if (!searches.has(queryKey(q))) searches.set(queryKey(q), searchFromState(q, s));
  }
  for (const f of [...jsonFiles(join(fixtures, 'validation'), 'pages-'), ...jsonFiles(join(fixtures, 'validation'), 'kit-pages-')]) {
    for (const [id, p] of Object.entries(obj(read(f).pages))) if (!pages.has(id)) pages.set(id, pageFromValidation(id, p));
  }
  return { pages, searches };
}

export interface ToolCallLog {
  tool: 'readHomeDepotPage' | 'searchHomeDepot' | 'catalogLookup';
  input: unknown;
  recorded: boolean;
}

/**
 * Tools over recorded sources and a catalog. `log` receives every call. A page is found by item id, or
 * by the item id at the end of a homedepot.com address; a search by its words, case and spacing aside.
 */
export function recordedTools(sources: RecordedSources, catalog: CatalogEntry[], log: ToolCallLog[] = []): ResearchTools {
  return {
    async readHomeDepotPage(input) {
      const id = input.itemId ?? /\/(\d{6,12})(?:[/?#]|$)/.exec(input.url ?? '')?.[1];
      const page = id ? sources.pages.get(id) : undefined;
      log.push({ tool: 'readHomeDepotPage', input, recorded: !!page });
      return page ?? NOT_RECORDED;
    },
    async searchHomeDepot(input) {
      const s = sources.searches.get(queryKey(input.query));
      log.push({ tool: 'searchHomeDepot', input, recorded: !!s });
      return s ?? NOT_RECORDED;
    },
    async catalogLookup(input): Promise<CatalogLookup> {
      const model = input.model?.trim().toUpperCase();
      const words = (input.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const entries = catalog.filter((c) =>
        (model ? hasModelToken(c.model, model) || hasModelToken(model, c.model) : true) &&
        (words.length > 0 ? words.every((w) => `${c.brand} ${c.model} ${c.title}`.toLowerCase().includes(w)) : true)).slice(0, 10);
      log.push({ tool: 'catalogLookup', input, recorded: true });
      return { sourceId: `catalog:${model ?? queryKey(input.query ?? '')}`, entries };
    },
  };
}
