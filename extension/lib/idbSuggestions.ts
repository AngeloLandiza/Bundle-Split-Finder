// The suggestions Ask AI made (core/src/assist/stored.ts) over IndexedDB. Its own store, apart from the scan's: a
// scan never reads or rewrites it, and a suggestion is never a ReviewItem's answer.

import type { IDBPDatabase } from 'idb';
import type { StoredSuggestion, SuggestionStore } from '@core/assist/stored';
import { openDb } from './db';

export class IdbSuggestionStore implements SuggestionStore {
  private readonly db: Promise<IDBPDatabase>;

  constructor(db?: IDBPDatabase | Promise<IDBPDatabase>) {
    this.db = Promise.resolve(db ?? openDb());
  }

  async put(record: StoredSuggestion): Promise<void> {
    // Cloned first, so a record that cannot be stored fails here.
    await (await this.db).put('suggestions', structuredClone(record));
  }

  async list(): Promise<StoredSuggestion[]> {
    const all = (await (await this.db).getAll('suggestions')) as StoredSuggestion[];
    return all.sort((a, b) => a.askedAt - b.askedAt || (a.key < b.key ? -1 : 1));
  }

  async clear(): Promise<void> {
    await (await this.db).clear('suggestions');
  }
}
