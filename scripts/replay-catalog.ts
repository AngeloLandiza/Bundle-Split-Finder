// npx tsx scripts/replay-catalog.ts [data folder]. Free, no network, writes nothing.
// The catalog check (core/src/scan/catalogCheck.ts) replayed on a data folder's scan store (default: the owner's third
// real scan, fixtures/e2e-2026-11-23/after-scan3): every title match and every match question listing it would pull,
// most valuable first, and what the check does with the Keepa products recorded in fixtures/keepa/. A listing no
// recording holds "needs a live pull" (1 Keepa token each). The store is in memory: nothing is written back.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseProductResponse, parseSearchResponse } from '../core/src/keepa/parse';
import type { KeepaProduct } from '../core/src/keepa/types';
import { dewaltAmpHourConflict, identityFromKeepa } from '../core/src/keepa/verify';
import { applyCatalogCheck, catalogChecksWanted, type CatalogOutcome, type CatalogTarget } from '../core/src/scan/catalogCheck';
import { bundleParts } from '../core/src/scan/runner';
import { knownModels } from '../core/src/scan/split';
import { loadScanFolder } from './data-folder';
import { ROOT } from './node-store';

export const AFTER_SCAN3 = join(ROOT, 'fixtures/e2e-2026-11-23/after-scan3');

/** Every Keepa product recorded in fixtures/keepa/, by ASIN (the stats pull first: it has the price). */
export function recordedKeepaProducts(root = ROOT): Map<string, KeepaProduct> {
  const read = (f: string) => JSON.parse(readFileSync(join(root, 'fixtures/keepa', f), 'utf8')) as Record<string, unknown>;
  const out = new Map<string, KeepaProduct>();
  for (const p of parseProductResponse(read('product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json')).products) out.set(p.asin, p);
  for (const p of parseSearchResponse(read('search-RYOBI-PCL235B.json')).products ?? []) if (!out.has(p.asin)) out.set(p.asin, p);
  return out;
}

export interface ReplayLine {
  target: CatalogTarget;
  /** Null when no recording holds the listing: it needs a live pull. */
  outcomes: CatalogOutcome[] | null;
  /** The listing's saved title, when the store has it. */
  title: string | null;
  /** For a DEWALT kit: what its saved title already says against its battery letters (keepa/verify.ts). */
  ampHours: string | null;
}

export async function replayCatalog(dir = AFTER_SCAN3, root = ROOT): Promise<ReplayLine[]> {
  const store = await loadScanFolder(dir);
  const { catalog } = await knownModels(store);
  const targets = await catalogChecksWanted(store, await bundleParts(store));
  const recorded = recordedKeepaProducts(root);
  const lines: ReplayLine[] = [];
  let clock = Date.UTC(2026, 10, 23, 18);
  for (const target of targets) {
    const product = recorded.get(target.asin);
    const title = (await store.getListing(target.asin))?.title ?? null;
    const ampHours = target.brand === 'DEWALT' && title ? dewaltAmpHourConflict(target.model, title) : null;
    const outcomes = product ? await applyCatalogCheck({ store, catalog, now: () => (clock += 1000) }, identityFromKeepa(product)) : null;
    lines.push({ target, outcomes, title, ampHours });
  }
  return lines;
}

export function replayLines(lines: ReplayLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const t = l.target;
    const what = l.outcomes === null
      ? 'needs a live pull'
      : l.outcomes.map((o) => `${o.key} ${o.status} (${o.change}): ${o.reason}`).join('; ') || 'nothing holds it any more';
    out.push(`${t.holds.padEnd(8)} ${`${t.brand}:${t.model}`.padEnd(20)} ${t.asin}  ${what}${l.ampHours ? `  [the saved title already stops a confirmation: ${l.ampHours}]` : ''}`);
  }
  const of = (holds: CatalogTarget['holds']) => lines.filter((l) => l.target.holds === holds);
  const settled = (ls: ReplayLine[]) => ls.filter((l) => l.outcomes?.some((o) => o.change !== 'kept')).length;
  const live = (ls: ReplayLine[]) => ls.filter((l) => l.outcomes === null).length;
  const questions = [...new Set(of('question').map((l) => l.target.key))];
  out.push('');
  out.push(`Title matches: ${of('match').length} listings to check; ${settled(of('match'))} settled from recorded fields, ${live(of('match'))} need a live pull.`);
  out.push(`Match questions: ${questions.length} (${questions.join(', ')}), ${of('question').length} listings; ${settled(of('question'))} settled from recorded fields, ${live(of('question'))} need a live pull.`);
  out.push(`Cost: 1 Keepa token per listing, ${lines.length} for all of them.`);
  return out;
}

if (process.argv[1] && /replay-catalog\.ts$/.test(process.argv[1])) {
  const dir = process.argv[2] ?? AFTER_SCAN3;
  for (const line of replayLines(await replayCatalog(dir))) console.log(line);
}
