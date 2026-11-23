// How a bundle's split is read from the data a scan holds: the model number, with the models the
// stored catalog and the saved listings know, then the bundle's own page. The scan runner splits
// every bundle with it (rule 4, 2c rule 4, P5), and a reopened split question (answers.ts) reads
// its bundle with it, so the two never differ.

import { type Catalog, catalogEntry, type Decomposition, decompose, dewaltBundleForm, kindsFromTitle, PACK_WITH_NOTE } from '../decompose';
import { kitIndex, kitRecords } from '../kitContents';
import { splitWithPage } from '../pageSplit';
import { type SettleData, settleSplit } from './settle';
import type { BundleRecord, ListingRecord, ScanStore, SetItem } from './types';

const HOME_DEPOT = 'https://www.homedepot.com';

/** A set's items whose own page has not given a model yet (fix round 3). */
export const setItemsUnread = (bundle: Pick<BundleRecord, 'set'>): SetItem[] => (bundle.set?.items ?? []).filter((i) => !i.model);

/**
 * Fix round 3: a Home Depot set's split is the items Home Depot lists in it (its Bundle list entry's bundleItems), each
 * named by the brand and model its own page gives, as many times as its quantity: settled by Home Depot's own data, with
 * the set's page as the evidence. Not settled (rule 4): while any item's page is unread (the set waits for it, no
 * question), or when an item's page names another brand than the set's (the parts would be looked up under the wrong
 * brand). Never a model guessed from a title.
 */
export function setSplit(bundle: BundleRecord): Decomposition {
  const items = bundle.set!.items;
  const count = items.reduce((n, i) => n + i.quantity, 0);
  const unread = setItemsUnread(bundle);
  if (unread.length > 0) {
    return { components: [], status: 'needs_review', notes: [`waits for the pages of ${unread.length} of this set's ${items.length} items`] };
  }
  const brand = bundle.brand.trim().toUpperCase();
  const other = items.filter((i) => (i.brand ?? '').trim().toUpperCase() !== brand);
  if (other.length > 0) {
    return { components: [], status: 'needs_review', notes: [`a set item's own page names another brand: ${other.map((i) => `${i.brand || 'none'} ${i.model}`).join(', ')}`] };
  }
  const components = items.flatMap((i) => Array.from({ length: i.quantity }, () => i.model!.trim().toUpperCase()));
  const text = `Home Depot lists this set's ${count} items.`;
  return {
    components, status: 'resolved', notes: [text],
    evidence: [{ kind: 'hd_set', text, url: bundle.link ?? `${HOME_DEPOT}/p/${bundle.itemId}` }],
  };
}

export interface KnownModels {
  /** The stored catalog alone: the models Home Depot's own rows showed. */
  stored: Catalog;
  /** The stored catalog plus an entry for every model in a saved listing's title (2c rule 4). */
  catalog: Catalog;
  listings: ListingRecord[];
  /** Step 15: what the settle rules read (scan/settle.ts): the stored part-price readings and the kits' records. */
  settle: SettleData;
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
  const catalogRecords = await store.listCatalog();
  const settle: SettleData = {
    partPrices: new Map((await store.listPartPrices()).map((r) => [r.key, r] as const)),
    kitsOf: kitIndex(kitRecords(await store.listBundles(), catalogRecords)),
    // Answer once (Nov 23): what the owner settled about each model, when the store keeps it (core/src/facts/fact.ts).
    facts: new Map((store.listPartFacts ? await store.listPartFacts() : []).map((f) => [f.key, f] as const)),
  };
  return { stored, catalog, listings, settle };
}

/**
 * The split of one bundle as the data reads it, before any answer of the owner's (P5): the model
 * number's split (splitBundle), then the bundle's own page, when it was read, then (step 15) the
 * settle rules on what Home Depot itself says, when `known` carries their data.
 */
export function readSplit(bundle: BundleRecord, known: Pick<KnownModels, 'stored' | 'catalog'> & Partial<Pick<KnownModels, 'settle'>>): Decomposition {
  // Fix round 3: a Home Depot set has no model number to read; its split is Home Depot's own list of its items.
  if (bundle.set) return setSplit(bundle);
  const split = splitWithPage(bundle, splitBundle(bundle, known.stored, known.catalog), bundle.page ?? null, known.catalog);
  return known.settle ? settleSplit(bundle, split, known.catalog, known.settle) : split;
}

/**
 * The split of one bundle by its model number. Models read from Amazon titles may not make a DEWALT
 * short code resolve by guesswork: the stored catalog is tried alone first, and a resolved split stands.
 * Otherwise the split with the listings' models is taken only for RYOBI, whose patterns spell
 * every part out, or for DEWALT when it names exactly two parts (the kit and one bonus item, so
 * no short code was glued together from pieces). A DEWALT battery pack + bonus item never resolves;
 * its one reading of two parts may come from the listings' models on the same terms, as a choice for
 * the owner. In every other case the first result stands.
 */
function splitBundle(bundle: BundleRecord, stored: Catalog, catalog: Catalog): Decomposition {
  const first = decompose(bundle.brand, bundle.model, bundle.title, stored);
  if (first.status === 'resolved') return first;
  const second = decompose(bundle.brand, bundle.model, bundle.title, catalog);
  const brand = bundle.brand.trim().toUpperCase();
  const form = brand === 'DEWALT' ? dewaltBundleForm(bundle.model) : null;
  if (form?.kind === 'pack') {
    const one = second.alternatives?.length === 1 && second.alternatives[0]!.length === 2;
    return one && knewNothing(first, form.bonus) ? second : first;
  }
  if (second.status !== 'resolved') return first;
  if (brand === 'RYOBI') return second;
  if (form === null || second.components.length !== 2) return first;
  return knewNothing(first, form.bonus) ? second : first;
}

/**
 * DEWALT, one bonus item: true only when the stored catalog knew nothing at all for the short code
 * (not when it found two readings, "fits A and B" or "more than one way", which a title match must
 * not settle), and only for a short code of three characters or more.
 */
function knewNothing(first: Decomposition, suffix: string): boolean {
  return suffix.length >= 3 && first.notes[0] === `'${suffix}' matches nothing in the catalog` &&
    first.notes.every((n, i) => i === 0 || n === PACK_WITH_NOTE);
}
