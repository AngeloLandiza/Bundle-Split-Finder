// The extension's IndexedDB database. It survives the service worker being stopped.
// The SerpApi key is never stored here; it lives in chrome.storage.local (see prefs.ts).

import { openDB, type IDBPDatabase } from 'idb';

export const DB_NAME = 'split-finder';
/** 2 (step 9): adds partPrices. An upgrade creates only the stores a database lacks, so nothing stored is lost. */
export const DB_VERSION = 2;

/** Object stores and their key paths. The ledger uses an auto-increment key. */
export const KEYED_STORES = {
  bundles: 'key',
  catalog: 'key',
  matches: 'key',
  prices: 'asin',
  listings: 'asin',
  cursors: 'brand',
  review: 'id',
  scans: 'id',
  cache: 'key',
  partPrices: 'key',
} as const;

export type KeyedStore = keyof typeof KEYED_STORES;

const open = new Map<string, Promise<IDBPDatabase>>();

/** Opens the database once per name and reuses the connection. */
export function openDb(name: string = DB_NAME): Promise<IDBPDatabase> {
  let db = open.get(name);
  if (!db) {
    db = openDB(name, DB_VERSION, {
      upgrade(d) {
        for (const [store, keyPath] of Object.entries(KEYED_STORES)) {
          if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, { keyPath });
        }
        if (!d.objectStoreNames.contains('ledger')) d.createObjectStore('ledger', { autoIncrement: true });
      },
    });
    open.set(name, db);
    db.catch(() => open.delete(name));
  }
  return db;
}
