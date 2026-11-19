// npm run ebay:record: record eBay Browse responses for the validation set's part models.
//
//   --dry-run   no network, no keys read: lists the parts and the searches planned.
//   --run       reads PRD_EBAY_APP_ID / PRD_EBAY_CERT_ID (never printed), then for each part makes one
//               search ("<BRAND> <MODEL>", Power Tools, New, fixed price, 200), pre-filters the result
//               and reads each kept listing with getItem. Writes fixtures/ebay/validation-<date>.json.
//
// Nothing here spends SerpApi searches. eBay's calls are capped (60 searches, 400 item reads). Only
// parsed listings are written (parseSearch / parseItem drop the seller), and only counts are printed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EbayAuthError, EbayCapError, EbayClient, EbayError, EbayForbiddenError, EbayRateLimitedError,
} from '../core/src/ebay/client';
import { MAX_CANDIDATES, POWER_TOOLS_CATEGORY, preFilter } from '../core/src/ebay/filter';
import type { EbayListing, EbayListingSummary } from '../core/src/ebay/types';

export const RECORD_DATE = '2026-11-19';
export const MAX_SEARCHES = 60;
export const MAX_ITEM_READS = 400;
const SEARCH_LIMIT = 200;

export interface ValidationPart { brand: string; model: string }

export interface PartRecord {
  query: string;
  total: number;
  summaries: EbayListingSummary[];
  kept: string[];
  dropped: { itemId: string; reason: string }[];
  items: Record<string, EbayListing>;
}

export interface Recording {
  about: string;
  recordedAt: string;
  /** Present and true only when the run stopped before every part was done. */
  incomplete?: true;
  parts: Record<string, PartRecord>;
}

/** The validation set's part models, with brands, from fixtures/validation/hd-part-prices-<date>.json. */
export function validationParts(dir: string): ValidationPart[] {
  const file = join(dir, 'validation', 'hd-part-prices-2026-11-18.json');
  const j = JSON.parse(readFileSync(file, 'utf8')) as { prices: Record<string, { brand: string; model: string }> };
  return Object.values(j.prices).map((p) => ({ brand: p.brand, model: p.model }));
}

export interface EbayRecordDeps {
  log: (line: string) => void;
  /** The fixtures directory. */
  dir: string;
  /** Reads a variable from the environment; the CLI never prints what it returns. */
  env: (name: string) => string | undefined;
  /** Builds the client; tests pass one over a fake fetch. */
  makeClient?: (o: { appId: string; certId: string; maxSearches: number; maxItemReads: number }) => EbayClient;
  now?: () => Date;
}

const query = (p: ValidationPart): string => `${p.brand} ${p.model}`;

export async function runEbayRecord(args: string[], deps: EbayRecordDeps): Promise<number> {
  const { log } = deps;
  const known = new Set(['--dry-run', '--run']);
  const bad = args.filter((a) => !known.has(a));
  if (bad.length > 0 || args.length !== 1) {
    log('Usage: npm run ebay:record -- --dry-run | --run');
    return 2;
  }
  const parts = validationParts(deps.dir);
  if (parts.length > MAX_SEARCHES) { log(`The set has ${parts.length} parts, over the cap of ${MAX_SEARCHES} searches.`); return 2; }

  if (args[0] === '--dry-run') {
    log(`eBay record, dry run (no network, no keys read). Validation set: ${parts.length} parts.`);
    for (const p of parts) log(`  search "${query(p)}"  (category ${POWER_TOOLS_CATEGORY}, New, fixed price, limit ${SEARCH_LIMIT})`);
    log(`Planned: ${parts.length} searches (cap ${MAX_SEARCHES}).`);
    log(`Item reads depend on the pre-filter: at most ${MAX_CANDIDATES} per part, so at most ${parts.length * MAX_CANDIDATES} (cap ${MAX_ITEM_READS}).`);
    log(`A run would write fixtures/ebay/validation-${RECORD_DATE}.json. It spends no SerpApi searches.`);
    return 0;
  }

  const appId = deps.env('PRD_EBAY_APP_ID');
  const certId = deps.env('PRD_EBAY_CERT_ID');
  if (!appId || !certId) { log('PRD_EBAY_APP_ID and PRD_EBAY_CERT_ID must both be set (in .env or the environment). Nothing was called.'); return 1; }
  const opts = { appId, certId, maxSearches: MAX_SEARCHES, maxItemReads: MAX_ITEM_READS };
  const client = deps.makeClient ? deps.makeClient(opts) : new EbayClient(opts);

  const rec: Recording = {
    about: `eBay Browse API responses for the validation set's ${parts.length} part models (New, fixed price, Power Tools), recorded ${RECORD_DATE}. One search per part, then getItem for each listing the pre-filter kept (at most ${MAX_CANDIDATES}). Parsed by core/src/ebay/parse, which keeps no seller or buyer field.`,
    recordedAt: (deps.now?.() ?? new Date()).toISOString(),
    parts: {},
  };
  let failure: string | null = null;
  try {
    for (const p of parts) {
      const q = query(p);
      const { total, summaries } = await client.search(q, { categoryIds: [POWER_TOOLS_CATEGORY], conditionNew: true, fixedPrice: true, limit: SEARCH_LIMIT });
      const { kept, dropped } = preFilter(p, summaries);
      const items: Record<string, EbayListing> = {};
      const keptIds: string[] = [];
      for (const k of kept) {
        try {
          items[k.itemId] = await client.getItem(k.itemId);
          keptIds.push(k.itemId);
        } catch (e) {
          // One listing that cannot be read is recorded as dropped; a failure that affects every call stops the run.
          if (e instanceof EbayAuthError || e instanceof EbayForbiddenError || e instanceof EbayRateLimitedError || e instanceof EbayCapError) throw e;
          dropped.push({ itemId: k.itemId, reason: `item read failed${e instanceof EbayError && e.status ? ` (HTTP ${e.status})` : ''}` });
        }
      }
      rec.parts[p.model] = { query: q, total, summaries, kept: keptIds, dropped, items };
      log(`  ${p.model}: total ${total}, ${summaries.length} summaries, ${keptIds.length} kept, ${dropped.length} dropped`);
    }
  } catch (e) {
    failure = e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
    rec.incomplete = true;
  }

  const out = join(deps.dir, 'ebay', `validation-${RECORD_DATE}.json`);
  mkdirSync(join(deps.dir, 'ebay'), { recursive: true });
  writeFileSync(out, JSON.stringify(rec, null, 1) + '\n');
  const done = Object.keys(rec.parts).length;
  log(`Made ${client.counts.searches} searches and ${client.counts.itemReads} item reads (${client.counts.tokens} token requests). Recorded ${done} of ${parts.length} parts.`);
  log(`Wrote ${existsSync(out) ? `fixtures/ebay/validation-${RECORD_DATE}.json` : out}.`);
  if (failure) { log(`Stopped early: ${failure}`); return 1; }
  return 0;
}
