// The SerpApi response cache over IndexedDB: store "cache", values { key, at, data }.

import type { IDBPDatabase } from 'idb';
import type { Cache, CacheEntry } from '@core/serpapi/client';
import { openDb } from './db';

export class IdbCache implements Cache {
  private readonly db: Promise<IDBPDatabase>;

  constructor(db?: IDBPDatabase | Promise<IDBPDatabase>) {
    this.db = Promise.resolve(db ?? openDb());
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const row = (await (await this.db).get('cache', key)) as { key: string; at: number; data: unknown } | undefined;
    return row === undefined ? undefined : { at: row.at, data: row.data };
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await (await this.db).put('cache', { key, at: entry.at, data: entry.data });
  }

  /** Empties the cache store and nothing else. */
  async clear(): Promise<void> {
    await (await this.db).clear('cache');
  }
}
