// Nov 25, pictures from what the app already reads (docs/decisions.md). Two kinds of answer the agent already cached carry
// product pictures the app never kept:
// - Keepa's product answers (`<data>/cache/keepa`, the raw body): each listing's `images` (keepa/parse.ts keepaPicture).
//   Every stored Amazon listing without a picture gets its main picture.
// - SerpApi's Home Depot list pages (`<data>/cache/home_depot`, the raw body): each row's `thumbnails`
//   (hdPage.ts hdThumbnail). Every stored bundle and catalog part without a picture gets the one its own row carried.
// Once, at start, before the stored deals are rebuilt, from the newest cached answer for each. No call, no token, no
// search: this reads files only. A record that has a picture keeps it; nothing is created (what is stored as a listing is
// what the matcher reads).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseProductResponse } from '../core/src/keepa/parse';
import { partKey, type ScanStore } from '../core/src/scan/types';
import { parseHomeDepotSearch } from '../core/src/serpapi/parsers';

/** Its name in runtime.migrations: done once. */
export const PICTURE_BACKFILL = 'keepa-picture-backfill';

/** Each cached answer under `<cacheDir>/<kind>` (DirCache's layout) whose key passes `wanted`: its time and body. Reads only. */
function cachedAnswers(cacheDir: string, kind: string, wanted: RegExp): { at: number; data: Record<string, unknown> }[] {
  const dir = join(cacheDir, kind);
  if (!existsSync(dir)) return [];
  const out: { at: number; data: Record<string, unknown> }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let entry: { key?: unknown; at?: unknown; data?: unknown };
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.key !== 'string' || !wanted.test(entry.key) || typeof entry.at !== 'number') continue;
    if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) continue;
    out.push({ at: entry.at, data: entry.data as Record<string, unknown> });
  }
  return out;
}

/** The newest of each key's pictures. */
function newestOf(found: Iterable<{ at: number; key: string; image: string }>): Map<string, string> {
  const newest = new Map<string, { at: number; image: string }>();
  for (const f of found) {
    const had = newest.get(f.key);
    if (!had || had.at < f.at) newest.set(f.key, { at: f.at, image: f.image });
  }
  return new Map([...newest].map(([k, v]) => [k, v.image] as const));
}

/** The newest picture of each Amazon listing (by ASIN) in the cached Keepa product answers (by ASIN, by code, search rows). */
export function cachedPictures(cacheDir: string): Map<string, string> {
  return newestOf(cachedAnswers(cacheDir, 'keepa', /^keepa:(product|search)\?/).flatMap(({ at, data }) =>
    Array.isArray(data.products) ? parseProductResponse(data).products.flatMap((p) => (p.image ? [{ at, key: p.asin, image: p.image }] : [])) : []));
}

/** The newest picture of each Home Depot item (by item id) in the cached SerpApi Home Depot list pages (engine=home_depot). */
export function cachedHomeDepotPictures(cacheDir: string): Map<string, string> {
  return newestOf(cachedAnswers(cacheDir, 'home_depot', /(^|&)engine=home_depot(&|$)/).flatMap(({ at, data }) =>
    parseHomeDepotSearch(data).listings.flatMap((l) => (l.image ? [{ at, key: l.itemId, image: l.image }] : []))));
}

export interface PicturesFilled {
  /** Stored Amazon listings that got a picture. */
  listings: number;
  /** Stored bundles (deals) that got their own Home Depot picture. */
  deals: number;
  /** Distinct parts that got one: a part whose chosen listing got one, or a catalog part that got its own Home Depot one. */
  parts: number;
}

/**
 * Fills `image` on each stored listing (from `amazon`, by ASIN), bundle and catalog part (from `homeDepot`, by item id) that
 * has none. Safe to run again: a filled record is skipped.
 */
export async function backfillPictures(
  store: Pick<ScanStore, 'listListings' | 'putListing' | 'listMatches' | 'listBundles' | 'putBundle' | 'listCatalog' | 'putCatalogEntry'>,
  amazon: ReadonlyMap<string, string>, homeDepot: ReadonlyMap<string, string> = new Map(),
): Promise<PicturesFilled> {
  const filled = new Set<string>();
  for (const l of await store.listListings()) {
    const image = l.image ? undefined : amazon.get(l.asin);
    if (!image) continue;
    await store.putListing({ ...l, image });
    filled.add(l.asin);
  }
  const parts = new Set((await store.listMatches()).filter((m) => m.asin !== null && filled.has(m.asin)).map((m) => m.key));
  let deals = 0;
  for (const b of await store.listBundles()) {
    const image = b.image ? undefined : homeDepot.get(b.itemId);
    if (!image) continue;
    await store.putBundle({ ...b, image });
    deals += 1;
  }
  for (const c of await store.listCatalog()) {
    const image = c.image || !c.itemId ? undefined : homeDepot.get(c.itemId);
    if (!image) continue;
    await store.putCatalogEntry({ ...c, image });
    parts.add(partKey(c.brand, c.model));
  }
  return { listings: filled.size, deals, parts: parts.size };
}

/** The one line Activity shows for it, or null when nothing was found. */
export function backfillSentence(r: PicturesFilled): string | null {
  const said = [
    r.parts > 0 ? `${r.parts} ${r.parts === 1 ? 'part' : 'parts'}` : null,
    r.deals > 0 ? `${r.deals} ${r.deals === 1 ? 'deal' : 'deals'}` : null,
  ].filter((x): x is string => x !== null);
  if (said.length === 0 && r.listings > 0) said.push(`${r.listings} saved Amazon ${r.listings === 1 ? 'listing' : 'listings'}`);
  return said.length === 0 ? null : `Found pictures for ${said.join(' and ')} from data already stored. Nothing was spent.`;
}
