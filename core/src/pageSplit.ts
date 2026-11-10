// A bundle's own Home Depot page as a second split signal, reconciled with the model number.
//
// The page is read once (hdPage.parseBundlePage); its bullets name the boxed items in a
// brand-specific way, which `pageCatalog` turns into a catalog. The splitter is then run on
// that catalog alone, and the two readings are compared. Neither signal wins alone when they
// disagree: the bundle goes to review. Rules R1 to R5 are in the step 4 plan, Task 3.

import { DEWALT_BUNDLE, decompose, reconcile, type Catalog, type CatalogModel, type Decomposition } from './decompose';
import type { PageContent } from './hdPage';

// DEWALT writes each bullet as "<model>: <text>", and a tool inside a kit as "<kit>: <tool>: <text>".
// Only the leading model counts: the kit is the boxed item, not the tools inside it.
const DEWALT_LEADING = /^([A-Z]{2,}\d[A-Z0-9]*):/;
// decompose's RYOBI model shape, as whole words; 18V and 18T start with digits and do not match.
const RYOBI_TOKEN = /\b[A-Z]{1,6}\d{2,5}[A-Z0-9]*\b/g;
const INCLUDES = /^includes/i;

const entry = (model: string, brand: string, isKit: boolean): CatalogModel => ({ model, brand, kinds: [], isKit });

/** The models a page names at the level of boxed items, as a catalog the splitter can read. */
export function pageCatalog(brand: string, bullets: string[]): Catalog {
  const b = brand.toUpperCase().trim();
  const catalog: Catalog = new Map();
  if (b === 'DEWALT') {
    for (const bullet of bullets) {
      const model = DEWALT_LEADING.exec(bullet)?.[1];
      if (model) catalog.set(model, entry(model, 'DEWALT', model.startsWith('DCK')));
    }
  } else if (b === 'RYOBI') {
    // The page writes a tool without the tool-only B (PBLRC25 for PBLRC25B), so both are added.
    for (const bullet of bullets.filter((x) => INCLUDES.test(x))) {
      for (const [model] of bullet.matchAll(RYOBI_TOKEN)) {
        catalog.set(model, entry(model, 'RYOBI', false));
        catalog.set(`${model}B`, entry(`${model}B`, 'RYOBI', false));
      }
    }
  }
  return catalog;
}

const list = (models: Iterable<string>): string => [...models].sort().join(', ');
const sameSet = (a: string[], b: string[]): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((m) => y.has(m));
};
const withNote = (split: Decomposition, note: string): Decomposition => ({ ...split, notes: [...split.notes, note] });

/** The model split standing, with the parts the page does not name; unchanged when it names them all. */
function standsUnnamed(modelSplit: Decomposition, fromPage: Catalog): Decomposition {
  const unnamed = modelSplit.components.filter((m) => !fromPage.has(m));
  return unnamed.length ? withNote(modelSplit, `page does not name ${list(unnamed)}`) : modelSplit;
}

/**
 * The split once the page is taken into account. `modelSplit` is the runner's split from the
 * model number; `known` is the catalog it used (stored rows and saved listings).
 */
export function splitWithPage(
  bundle: { brand: string; model: string; title: string },
  modelSplit: Decomposition, page: PageContent | null, known: Catalog,
): Decomposition {
  if (!page) return modelSplit; // R1
  const brand = bundle.brand.toUpperCase().trim();
  const fromPage = pageCatalog(brand, page.bullets);
  const named = [...fromPage.keys()];
  const modelResolved = modelSplit.status === 'resolved';

  if (brand === 'DEWALT') {
    // A page that names nothing beyond the bundle's own kit says nothing about the bonus item.
    const kit = DEWALT_BUNDLE.exec(bundle.model.toUpperCase().replace(/[-\s]/g, ''))?.[1];
    if (named.length === 0 || (named.length === 1 && named[0] === kit)) {
      return modelResolved ? standsUnnamed(modelSplit, fromPage) : modelSplit;
    }
  } else if (fromPage.size === 0) {
    return withNote(modelSplit, 'page names no models'); // R1
  }

  const pageSplit = decompose(brand, bundle.model, bundle.title, fromPage);
  // DEWALT: the page's split counts only when it is exactly the models the page names.
  const misfit = brand === 'DEWALT' && pageSplit.status === 'resolved' && !sameSet(pageSplit.components, named);
  const pageResolved = pageSplit.status === 'resolved' && !misfit;
  const doNotFit = `page names ${list(named)}, which do not fit the model number`;

  if (modelResolved && pageResolved) { // R2
    if (sameSet(modelSplit.components, pageSplit.components)) {
      return { ...modelSplit, notes: ['model number and page agree'] };
    }
    const { reason } = reconcile(modelSplit.components, pageSplit.components);
    return { components: modelSplit.components, status: 'needs_review', notes: [reason] };
  }
  if (modelResolved) { // R3
    if (brand === 'DEWALT') return { components: modelSplit.components, status: 'needs_review', notes: [doNotFit] };
    // A RYOBI Includes list goes deeper than the boxed items: it can confirm but not contradict.
    return standsUnnamed(modelSplit, fromPage);
  }
  if (pageResolved) return { ...pageSplit, notes: ['split read from the page'] }; // R4

  // R5: neither resolved.
  if (brand === 'RYOBI') {
    const merged: Catalog = new Map([...fromPage, ...known]); // on the same model, `known` wins
    const both = decompose(brand, bundle.model, bundle.title, merged);
    if (both.status === 'resolved') return { ...both, notes: ['parts known from the catalog and the page'] };
  }
  return misfit ? withNote(modelSplit, doNotFit) : modelSplit;
}
