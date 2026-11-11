// How a bundle's split is read from the data a scan holds: the model number, with the models the
// stored catalog and the saved listings know, then the bundle's own page. The scan runner splits
// every bundle with it (rule 4, 2c rule 4, P5), and a reopened split question (answers.ts) reads
// its bundle with it, so the two never differ.

import { type Catalog, catalogEntry, DEWALT_BUNDLE, type Decomposition, decompose, kindsFromTitle } from '../decompose';
import { splitWithPage } from '../pageSplit';
import type { BundleRecord, ListingRecord, ScanStore } from './types';

export interface KnownModels {
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
 * a bonus tool. The one source of the catalog for the split, for the parts phase and for the
 * panel's paid actions (paid.ts).
 */
export async function knownModels(store: ScanStore): Promise<KnownModels> {
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
 * The split of one bundle as the data reads it, before any answer of the owner's (P5): the model
 * number's split (splitBundle), then the bundle's own page, when it was read.
 */
export function readSplit(bundle: BundleRecord, known: Pick<KnownModels, 'stored' | 'catalog'>): Decomposition {
  return splitWithPage(bundle, splitBundle(bundle, known.stored, known.catalog), bundle.page ?? null, known.catalog);
}

/**
 * The split of one bundle by its model number. Models read from Amazon titles may not make a DEWALT
 * short code resolve by guesswork: the stored catalog is tried alone first, and a resolved split stands.
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
  if (brand === 'RYOBI') return second;
  if (brand !== 'DEWALT' || second.components.length !== 2) return first;
  // DEWALT, one bonus item: only when the stored catalog knew nothing at all for the short
  // code (not when it found two readings, "fits A and B" or "more than one way", which a title
  // match must not settle), and only for a short code of three characters or more.
  const suffix = DEWALT_BUNDLE.exec(bundle.model.toUpperCase().replace(/[-\s]/g, ''))?.[2];
  if (suffix === undefined || suffix.length < 3) return first;
  return first.notes.length === 1 && first.notes[0] === `'${suffix}' matches nothing in the catalog` ? second : first;
}
