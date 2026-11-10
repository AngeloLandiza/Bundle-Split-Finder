// npm run scan: the scan pipeline from the command line.
//
//   --fixtures        free: the whole pipeline over the recorded responses
//   --limit N         spends up to N searches from the demo bucket
//   --dry-run         with --limit: say what would be spent, open nothing
//   --query "<text>"  repeatable; replaces the default queries
//   --pages N         listing pages per query (1 to 5)
//
// Every argument is checked before a client is opened, so a typo can never spend.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryScanStore } from '../core/src/scan/memoryStore';
import { buildReport } from '../core/src/scan/report';
import { reviewCsv, runCsv } from '../core/src/scan/csv';
import { runScan } from '../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanJob, type ScanSettings, type StopReason } from '../core/src/scan/types';
import { type AccountInfo, SearchBudget } from '../core/src/serpapi/budget';
import { BudgetExceededError, SerpApiClient } from '../core/src/serpapi/client';
import { DEV_ALLOCATION } from './dev-budget';
import { NoKeyError, type openDevClient } from './dev-client';
import { REQUESTS } from './fixture-requests';
import { SpendLockError } from './node-store';
import { replayRecorded } from './replay';

export interface CliDeps {
  log: (line: string) => void;
  outDir: string;
  now: () => number;
  openClient: typeof openDevClient;
}

const USAGE = [
  'Usage:',
  '  npm run scan -- --fixtures                  free: the whole pipeline on recorded responses',
  `  npm run scan -- --limit N                   spends up to N searches (1 to ${DEV_ALLOCATION.demo}, demo bucket)`,
  '  npm run scan -- --limit N --dry-run         say what would be spent, spend nothing',
  '  options: --query "<text>" (repeatable)  --pages N (1 to 5)',
];

const STOP_WORDS: Record<Exclude<StopReason, 'error'>, string> = {
  reserve: 'the search reserve would be touched',
  run_cap: 'this run reached its search limit',
  hourly_limit: "the plan's hourly limit is reached",
  rate_limited: 'SerpApi refused the request (HTTP 429)',
  user: 'stopped by you',
};

interface Options {
  fixtures: boolean;
  dryRun: boolean;
  limit: number | null;
  queries: string[];
  pages: number | null;
}

/** Null when the arguments are not understood. */
function parseArgs(args: string[]): Options | null {
  const o: Options = { fixtures: false, dryRun: false, limit: null, queries: [], pages: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--fixtures') o.fixtures = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--limit' || a === '--query' || a === '--pages') {
      const value = args[++i];
      if (value === undefined) return null;
      if (a === '--query') {
        if (value.trim() === '') return null;
        o.queries.push(value.trim());
      } else {
        if (!/^\d+$/.test(value)) return null;
        const n = Number(value);
        if (a === '--limit') {
          if (n < 1 || n > DEV_ALLOCATION.demo) return null;
          o.limit = n;
        } else {
          if (n < 1 || n > 5) return null;
          o.pages = n;
        }
      }
    } else return null;
  }
  if (o.fixtures ? o.limit !== null || o.dryRun : o.limit === null) return null;
  if (o.dryRun && o.limit === null) return null;
  return o;
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

const FIXTURE_ACCOUNT: AccountInfo = {
  planName: 'Fixture replay',
  status: 'Active',
  searchesPerMonth: 250,
  totalSearchesLeft: 250,
  thisMonthUsage: 0,
  thisHourSearches: 0,
  rateLimitPerHour: 250,
  renewalDate: null,
};

export async function runScanCli(args: string[], deps: CliDeps): Promise<number> {
  const { log } = deps;
  const opts = parseArgs(args);
  if (!opts) {
    for (const line of USAGE) log(line);
    return 1;
  }

  const settings: ScanSettings = { ...DEFAULT_SCAN_SETTINGS };
  if (opts.queries.length > 0) settings.queries = opts.queries.map((q) => ({ q }));
  else if (opts.fixtures) settings.queries = REQUESTS.filter((r) => r.params.engine === 'home_depot' && r.params.hd_filter_tokens === undefined).map((r) => ({ q: String(r.params.q) }));
  // Both recorded brand pages (DEWALT and RYOBI, page 1) are replayed.
  if (opts.fixtures) settings.catalogPagesPerScan = 2;
  if (opts.pages !== null) settings.pagesPerQuery = opts.pages;

  if (opts.dryRun) {
    log(`Would spend up to ${opts.limit} searches from the demo bucket.`);
    log(`Queries (${settings.pagesPerQuery} page${settings.pagesPerQuery === 1 ? '' : 's'} each):`);
    for (const q of settings.queries) log(`  ${q.q}`);
    return 0;
  }

  let job: ScanJob;
  let replayedCalls: number | null = null;
  const store = new MemoryScanStore();
  try {
    if (opts.fixtures) {
      const replay = replayRecorded();
      const budget = new SearchBudget(FIXTURE_ACCOUNT, { reserve: 0, maxPerRun: 250 });
      const client = new SerpApiClient({ apiKey: 'FIXTURES', budget, fetchFn: replay.fetchFn, now: deps.now });
      job = await runScan({ client, budget, store, settings, labelPrefix: 'fixtures', now: deps.now });
      replayedCalls = replay.calls.length;
    } else {
      const dev = await deps.openClient('demo', opts.limit!);
      try {
        job = await runScan({ client: dev.client, budget: dev.budget, store, settings, labelPrefix: 'demo', now: deps.now });
      } finally {
        dev.release();
      }
    }
  } catch (err) {
    if (err instanceof NoKeyError || err instanceof SpendLockError || err instanceof BudgetExceededError) {
      log(err.message);
      return 1;
    }
    throw err;
  }

  const report = await buildReport(store, settings);
  const name = stamp(deps.now());
  mkdirSync(deps.outDir, { recursive: true });
  const runPath = join(deps.outDir, `run_${name}.csv`);
  const reviewPath = join(deps.outDir, `review_${name}.csv`);
  writeFileSync(runPath, runCsv(report));
  writeFileSync(reviewPath, reviewCsv(report));

  log(replayedCalls !== null ? `Searches used: 0 (replayed ${replayedCalls} recorded responses)` : `Searches used: ${job.searchesUsed}`);
  if (job.status === 'stopped' && job.stopReason !== null) {
    const words = job.stopReason === 'error' ? `a search failed: ${job.stopMessage ?? ''}`.trimEnd() : STOP_WORDS[job.stopReason];
    log(`Scan stopped: ${words}`);
  } else if (job.status === 'stopped') {
    // Nothing stopped the scan, but a failed step was set aside and is still to do.
    log('Scan finished; some steps were set aside');
  } else {
    log('Scan done');
  }
  // A step that failed and was set aside or skipped. An "error" stop already shows its message.
  if (job.stopMessage !== null && job.stopReason !== 'error') log(`Note: ${job.stopMessage}`);
  const c = job.counts;
  const inSection = (section: string): number => report.bundles.filter((b) => b.section === section).length;
  log(`Pages ${c.pagesFetched} · products ${c.productsSeen} · bundles ${c.bundlesSeen} · parts matched ${c.partsMatched}`);
  log(`Amazon listings saved ${c.listingsSaved} · parts matched without a search ${c.partsFromCatalog}`);
  log(`Confirmed ${inSection('confirmed')} · review: inactive listing ${inSection('inactive_listing')}, missing listing ${inSection('missing_listing')}, contents not known ${inSection('split')}`);
  log(`Ranked bundles: ${runPath}`);
  log(`Review items:   ${reviewPath}`);
  log('Profit figures are estimates from fee settings, not real Amazon fees.');
  return 0;
}
