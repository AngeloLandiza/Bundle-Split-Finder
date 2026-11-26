// Nov 25, pictures from what the app already reads (docs/decisions.md): Keepa's product answers carry each listing's
// pictures (`images`), which the app never read. The answers the agent already cached (`<data>/cache/keepa`, one file per
// request, the raw body) hold them, so every stored Amazon listing without a picture gets its listing's main picture
// once, from the newest cached answer for it, at start, before the stored deals are rebuilt. No call, no token, no search:
// this reads files only. A listing that has a picture keeps it; a listing not stored is not created (what is stored as a
// listing is what the matcher reads).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseProductResponse } from '../core/src/keepa/parse';
import type { ScanStore } from '../core/src/scan/types';

/** Its name in runtime.migrations: done once. */
export const PICTURE_BACKFILL = 'keepa-picture-backfill';

/** The newest picture of each listing in the cached Keepa answers under `<cacheDir>/keepa` (DirCache's layout). Reads only. */
export function cachedPictures(cacheDir: string): Map<string, string> {
  const dir = join(cacheDir, 'keepa');
  const newest = new Map<string, { at: number; image: string }>();
  if (!existsSync(dir)) return new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let entry: { key?: unknown; at?: unknown; data?: unknown };
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as typeof entry;
    } catch {
      continue;
    }
    // Product answers only (by ASIN or by code, and search rows): a trend or an alert is not one.
    if (typeof entry.key !== 'string' || !/^keepa:(product|search)\?/.test(entry.key) || typeof entry.at !== 'number') continue;
    if (!entry.data || typeof entry.data !== 'object' || !Array.isArray((entry.data as { products?: unknown }).products)) continue;
    for (const p of parseProductResponse(entry.data as Record<string, unknown>).products) {
      if (!p.image) continue;
      const had = newest.get(p.asin);
      if (!had || had.at < entry.at) newest.set(p.asin, { at: entry.at, image: p.image });
    }
  }
  return new Map([...newest].map(([asin, v]) => [asin, v.image] as const));
}

export interface PicturesFilled {
  /** Stored listings that got a picture. */
  listings: number;
  /** Parts (match records) whose chosen listing is one of them: what the owner sees fill in. */
  parts: number;
}

/** Fills `image` on each stored listing that has none, from `pictures`. Safe to run again: a filled listing is skipped. */
export async function backfillPictures(
  store: Pick<ScanStore, 'listListings' | 'putListing' | 'listMatches'>, pictures: ReadonlyMap<string, string>,
): Promise<PicturesFilled> {
  const filled = new Set<string>();
  for (const l of await store.listListings()) {
    const image = l.image ? undefined : pictures.get(l.asin);
    if (!image) continue;
    await store.putListing({ ...l, image });
    filled.add(l.asin);
  }
  const parts = (await store.listMatches()).filter((m) => m.asin !== null && filled.has(m.asin)).length;
  return { listings: filled.size, parts };
}

/** The one line Activity shows for it, or null when nothing was found. */
export function backfillSentence(r: PicturesFilled): string | null {
  if (r.parts > 0) return `Found pictures for ${r.parts} ${r.parts === 1 ? 'part' : 'parts'} from data already stored. Nothing was spent.`;
  if (r.listings > 0) return `Found pictures for ${r.listings} saved Amazon ${r.listings === 1 ? 'listing' : 'listings'} from data already stored. Nothing was spent.`;
  return null;
}
