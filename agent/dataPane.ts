// Settings, Data: the audit file and Reset scan data. The audit file is what a developer needs to see what happened; it
// never holds a key: every string is scrubbed, and a last check refuses the whole file if any stored key value is still in it.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScanStore } from '../core/src/scan/types';
import { emptyCollection, type Store, type StoredKeys } from './store';
import { scrub, secretsOf } from './work';

export const AUDIT_REFUSAL = 'The audit file could not be made safely, so nothing was exported.';

/** The collections Reset scan data empties (keys, settings, pairing and the agent's pause are never touched). */
export const RESET_COLLECTIONS = ['deals', 'review', 'suggestions', 'activity', 'autopilot', 'answers', 'tracking', 'jobs'] as const;

export interface AuditInputs {
  store: Store;
  scan: ScanStore;
  now: number;
  appVersion: string | null;
  helperVersion: string | null;
  platform: string;
}

/** Every string (values and property names) through the key scrubber. */
function scrubDeep(value: unknown, keys: StoredKeys): unknown {
  if (typeof value === 'string') return scrub(value, keys);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, keys));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k, keys), scrubDeep(v, keys)]));
  }
  return value;
}

/** The text of the audit file; throws AUDIT_REFUSAL when a stored key value is still anywhere in it. */
export async function buildAuditText(i: AuditInputs): Promise<string> {
  const keys = i.store.get('keys');
  const scan = i.scan;
  const raw = {
    kind: 'split-finder-audit',
    exportedAt: new Date(i.now).toISOString(),
    app: { version: i.appVersion, helperVersion: i.helperVersion, platform: i.platform },
    note: 'Settings are listed without keys. Every key value was removed from this file and checked for before it was written.',
    keysSet: Object.fromEntries((['serpapi', 'keepa', 'anthropic', 'openai', 'ebay', 'telegram'] as const).map((k) => [k, Boolean(keys[k])])),
    settings: i.store.get('settings'),
    scanStore: {
      scans: await scan.listScans(),
      bundles: await scan.listBundles(),
      matches: await scan.listMatches(),
      listings: await scan.listListings(),
      partPrices: await scan.listPartPrices(),
      confirmedPrices: await scan.listConfirmedPrices(),
      reviews: await scan.listReview(),
      ebayValues: await scan.listEbayValues(),
      ebayAnswers: await scan.listEbayAnswers(),
      catalogEntries: (await scan.listCatalog()).length,
    },
    deals: i.store.get('deals'),
    review: i.store.get('review'),
    suggestions: i.store.get('suggestions'),
    activity: i.store.get('activity'),
    autopilot: i.store.get('autopilot'),
    answers: i.store.get('answers'),
    tracking: i.store.get('tracking'),
    jobs: i.store.get('jobs'),
    runtime: i.store.get('runtime'),
  };
  const text = JSON.stringify(scrubDeep(raw, keys), null, 2);
  // The final check: each stored key value, plain and as JSON escapes it. A hit fails the whole export.
  for (const secret of secretsOf(keys)) {
    if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) throw new Error(AUDIT_REFUSAL);
  }
  return text;
}

const stamp = (now: number): string => new Date(now).toISOString().replace(/[:.]/g, '-');

/** Copies what Reset deletes to `<dataDir>/backup-before-reset-<time>/` (never the keys) and returns that folder. */
export function backUpScanData(dataDir: string, store: Store, now: number): string {
  const dir = join(dataDir, `backup-before-reset-${stamp(now)}`);
  mkdirSync(join(dir, 'store'), { recursive: true, mode: 0o700 });
  for (const name of RESET_COLLECTIONS) writeFileSync(join(dir, 'store', `${name}.json`), JSON.stringify(store.get(name), null, 2));
  const scanDir = join(dataDir, 'scan');
  if (existsSync(scanDir)) cpSync(scanDir, join(dir, 'scan'), { recursive: true });
  return dir;
}

/** Empties the scan data. The helper's last snapshot in Activity stays: it is the connection, not a scan. */
export function clearScanData(store: Store): void {
  for (const name of RESET_COLLECTIONS) {
    if (name === 'activity') store.update('activity', (a) => ({ ...emptyCollection('activity'), helper: a.helper }));
    else store.update(name, () => emptyCollection(name) as never);
  }
}
