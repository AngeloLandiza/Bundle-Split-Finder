// Which Home Depot page to read for one kit, and where the reading is saved.
// The scan's kit pass and the panel's "Read kit page" both use this, so a click reads the page
// the next scan would read. Never a search, and never a page whose item id is not digits:
// the id is put into a Home Depot address.

import { kitIndex, kitPageStored, kitPageUnread, kitRecords } from '../kitContents';
import type { BundleRecord, CatalogRecord, PageReading } from './types';

/** A Home Depot item id is digits. Stored data is untrusted, and the id goes into a page address. */
export const HOME_DEPOT_ITEM_ID = /^\d+$/;

type WithPage = { page?: PageReading | null; itemId?: string | null };

/**
 * The first record in stored order whose page is not read and whose item id is digits, skipping
 * ids in `asked`. This is the scan's own pick (readKitPages): stored order, not key order.
 */
export function pickUnread<T extends WithPage>(records: T[], asked?: ReadonlySet<string>): T | undefined {
  return records.find((r) => {
    const id = r.itemId;
    return !r.page && typeof id === 'string' && HOME_DEPOT_ITEM_ID.test(id) && !(asked?.has(id));
  });
}

/**
 * What a click, or the next scan, would do for this kit.
 * stored  a record of the kit already has its page
 * none    no unread record of the kit is stored
 * no-id   an unread record is stored, but it has no digit item id (a catalog kit waits for a
 *         listing row; a bundle record of the kit is the one the bundle pass reads, and a
 *         catalog id is not used instead)
 * page    the one item id to read, and the record the reading is saved on
 */
export type KitPageTarget =
  | { kind: 'stored' }
  | { kind: 'none' }
  | { kind: 'no-id' }
  | { kind: 'page'; where: 'bundle' | 'catalog'; key: string; itemId: string };

const sameText = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

export function kitPageTarget(bundles: BundleRecord[], catalog: CatalogRecord[], brand: string, model: string): KitPageTarget {
  const own = kitIndex(bundles)(brand, model);
  const kits = kitIndex(catalog.filter((c) => c.isKit === true))(brand, model);
  const all = kitIndex(kitRecords(bundles, catalog))(brand, model);
  if (kitPageStored(all, brand, model)) return { kind: 'stored' };
  if (!kitPageUnread(all, brand, model)) return { kind: 'none' };
  // A bundle record of the kit is read by the bundle pass, not as a catalog kit. Of two written
  // forms (PCL1600K2 and PCL1600K2B), the one the owner named wins when its id can be read.
  if (own.length > 0) {
    const exact = own.find((b) => sameText(b.model, model) && typeof b.itemId === 'string' && HOME_DEPOT_ITEM_ID.test(b.itemId));
    const bundle = exact ?? pickUnread(own);
    return bundle && typeof bundle.itemId === 'string' ? { kind: 'page', where: 'bundle', key: bundle.key, itemId: bundle.itemId } : { kind: 'no-id' };
  }
  const kit = pickUnread(kits);
  return kit && typeof kit.itemId === 'string' ? { kind: 'page', where: 'catalog', key: kit.key, itemId: kit.itemId } : { kind: 'no-id' };
}
