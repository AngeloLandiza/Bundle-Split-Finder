// A copy of the app's data folder (fixtures/e2e-2026-11-23/after-scan3, or the owner's own) read into memory: the scan
// store from <dir>/scan/*.json, each file a list of [key, record] pairs as agent/scanStore.ts writes it. Read only:
// nothing is written back, and nothing reaches the network. Shared by scripts/audit-estimates.ts and scripts/mock-real.ts.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryScanStore } from '../core/src/scan/memoryStore';

const pairsOf = (file: string): [string, unknown][] => {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(raw) ? (raw.filter((p) => Array.isArray(p) && typeof p[0] === 'string') as [string, unknown][]) : [];
};

/** The scan store of a data folder, in memory. `dir` holds scan/ (and store/, which this does not read). */
export async function loadScanFolder(dir: string): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  const scan = join(dir, 'scan');
  const each = async (kind: string, put: (r: never) => Promise<void>) => {
    for (const [, r] of pairsOf(join(scan, `${kind}.json`))) await put(r as never);
  };
  await each('bundles', (r) => store.putBundle(r));
  await each('catalog', (r) => store.putCatalogEntry(r));
  await each('matches', (r) => store.putMatch(r));
  await each('prices', (r) => store.putPrice(r));
  await each('listings', (r) => store.putListing(r));
  await each('cursors', (r) => store.putCursor(r));
  await each('reviews', (r) => store.putReview(r));
  await each('partPrices', (r) => store.putPartPrice(r));
  await each('confirmedPrices', (r) => store.putConfirmedPrice(r));
  await each('ebayValues', (r) => store.putEbayValue(r));
  await each('judgements', (r) => store.putJudgement(r));
  await each('ebayAnswers', (r) => store.putEbayAnswer(r));
  await each('scans', (r) => store.putScan(r));
  await each('partFacts', (r) => store.putPartFact(r));
  await each('rechecks', (r) => store.putRecheck(r));
  return store;
}

/** A JSON file of the data folder's store/ (deals.json, review.json, ...), or `fallback` when it is not there. */
export function readStoreFile<T>(dir: string, name: string, fallback: T): T {
  const file = join(dir, 'store', name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}
