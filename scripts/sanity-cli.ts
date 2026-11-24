// npm run audit:sanity -- <dir or export.json> [--all]
//
// Red-teams a data set with the app's sanity checks (core/src/audit/sanity.ts): the deals a data folder holds
// (<dir>/store/deals.json, as fixtures/e2e-2026-11-23/after-scan5) or the desktop app's audit export (Settings, Data,
// Export audit file: GET /api/export/audit). Prints every finding as a table and exits 1 when any is a hold. What the owner
// already marked "This is right" is left out, as the app leaves it out; --all shows it too. Reads files only: no network,
// no search, no key.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sanityFindings, type SanityFinding } from '../core/src/audit/sanity';
import type { BundleRow } from '../core/src/scan/types';

export interface SanityData {
  bundles: BundleRow[];
  cleared: string[];
  /** What was read, for the first line. */
  source: string;
}

const USAGE = 'Usage: npm run audit:sanity -- <data folder or audit export .json> [--all]';

interface DealsFile { bundles?: unknown }
interface TrackingFile { sanityCleared?: unknown }

const bundlesOf = (deals: DealsFile | undefined): BundleRow[] | null => (deals && Array.isArray(deals.bundles) ? (deals.bundles as BundleRow[]) : null);
const clearedOf = (t: TrackingFile | undefined): string[] => (t && Array.isArray(t.sanityCleared) ? t.sanityCleared.filter((x): x is string => typeof x === 'string') : []);

/** The deals and the owner's cleared findings of a data folder or a desktop audit export. Throws a sentence when neither. */
export function loadSanityData(path: string): SanityData {
  if (!existsSync(path)) throw new Error(`${path} does not exist. ${USAGE}`);
  if (statSync(path).isDirectory()) {
    const file = join(path, 'store', 'deals.json');
    if (!existsSync(file)) throw new Error(`${path} has no store/deals.json: point at the app's data folder (the one holding scan/ and store/).`);
    const bundles = bundlesOf(JSON.parse(readFileSync(file, 'utf8')) as DealsFile);
    if (!bundles) throw new Error(`${file} holds no deals.`);
    const tracking = join(path, 'store', 'tracking.json');
    const cleared = existsSync(tracking) ? clearedOf(JSON.parse(readFileSync(tracking, 'utf8')) as TrackingFile) : [];
    return { bundles, cleared, source: `${file} (${bundles.length} deals)` };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { kind?: unknown; deals?: DealsFile; tracking?: TrackingFile; bundles?: unknown };
  const bundles = bundlesOf(raw.deals);
  if (raw.kind === 'split-finder-audit' && bundles) return { bundles, cleared: clearedOf(raw.tracking), source: `${path} (${bundles.length} deals)` };
  if (raw.kind === 'split-finder-audit') {
    throw new Error(`${path} is the extension's audit export: it holds no deals. Use the desktop app's export (Settings, Data, Export audit file).`);
  }
  throw new Error(`${path} is not an audit export. ${USAGE}`);
}

const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** One line a finding, in columns: severity, check, deal, part, listing, then the sentence and its first Amazon link. */
export function sanityTable(findings: readonly SanityFinding[]): string {
  const rows = findings.map((f) => [
    f.severity, f.kind, f.bundleId.replace(/^homedepot:/, 'HD '), f.part ?? '', f.asin ?? '', cut(f.sentence, 150),
  ]);
  const head = ['severity', 'check', 'deal', 'part', 'listing', 'what'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(Math.min(w, 40)))), ...rows.map(line)].join('\n');
}

export interface SanityCliIo {
  log: (s: string) => void;
}

/** Runs the command; the exit code: 0 nothing held, 1 a hold, 2 the input could not be read. */
export function runSanityCli(args: readonly string[], io: SanityCliIo): number {
  const all = args.includes('--all');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    io.log(USAGE);
    return 2;
  }
  let data: SanityData;
  try {
    data = loadSanityData(path);
  } catch (err) {
    io.log(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const findings = sanityFindings(data.bundles, { cleared: all ? [] : data.cleared });
  const holds = findings.filter((f) => f.severity === 'hold');
  io.log(`Checked ${data.source}${!all && data.cleared.length > 0 ? `; ${data.cleared.length} marked right by the owner left out (--all shows them)` : ''}.`);
  if (findings.length === 0) {
    io.log('Nothing to look at.');
    return 0;
  }
  io.log(sanityTable(findings));
  const deals = new Set(holds.map((f) => f.bundleId)).size;
  io.log(`${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}: ${holds.length} ${holds.length === 1 ? 'hold' : 'holds'} on ${deals} ${deals === 1 ? 'deal' : 'deals'}, ${findings.length - holds.length} notes.`);
  for (const f of holds) {
    const links = f.links.map((l) => `${l.label}: ${l.url}`).join(' · ');
    io.log(`- ${f.bundleId}${f.part ? ` ${f.part}` : ''}: ${links}`);
  }
  return holds.length > 0 ? 1 : 0;
}
