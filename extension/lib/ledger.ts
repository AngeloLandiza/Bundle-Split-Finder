// The search ledger: one entry per paid search, kept in insertion order.

import type { IDBPDatabase } from 'idb';
import type { LedgerEntry } from '@core/serpapi/client';
import { openDb } from './db';

export async function appendLedger(entry: LedgerEntry, db?: IDBPDatabase): Promise<void> {
  await (db ?? (await openDb())).add('ledger', structuredClone(entry));
}

export async function readLedger(db?: IDBPDatabase): Promise<LedgerEntry[]> {
  // Auto-increment keys ascend, so getAll is insertion order.
  return (await (db ?? (await openDb())).getAll('ledger')) as LedgerEntry[];
}
