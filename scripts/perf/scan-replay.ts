// Benchmark: a whole scan replayed from fixtures/recorded (zero network, the way `npm run scan -- --fixtures` does it)
// against the agent's FileScanStore, seeded with the owner's sixth scan (fixtures/e2e-2026-11-23/after-scan6: 258
// bundles, 962 listings), then the post-scan work. fsyncs are counted by wrapping fs.fsyncSync before the store loads.
//
//   npx tsx scripts/perf/scan-replay.ts
//
// Prints: scan_ms=<ms> fsyncs=<n> calls=<replayed requests> bundles=<n> sha=<sha256 of every scan file after the scan>
// The clock is fixed, so the sha is the same from run to run and must not change when the store's write path does.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6', 'scan');
/** Fixed: a day after the sixth scan. */
const NOW = 1_795_560_000_000;

let fsyncs = 0;
const realFsync = fs.fsyncSync;
fs.fsyncSync = (fd: number): void => {
  fsyncs++;
  realFsync(fd);
};
syncBuiltinESMExports();

const { FileScanStore } = await import('../../agent/scanStore');
const { postScanWork } = await import('../../core/src/scan/postScan');
const { runScan } = await import('../../core/src/scan/runner');
const { DEFAULT_SCAN_SETTINGS } = await import('../../core/src/scan/types');
const { SearchBudget } = await import('../../core/src/serpapi/budget');
const { SerpApiClient } = await import('../../core/src/serpapi/client');
const { REQUESTS } = await import('../fixture-requests');
const { replayRecorded } = await import('../replay');

const digest = (dir: string): string => {
  const h = createHash('sha256');
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    h.update(name);
    h.update('\0');
    h.update(fs.readFileSync(join(dir, name)));
    h.update('\0');
  }
  return h.digest('hex');
};

const dir = fs.mkdtempSync(join(tmpdir(), 'sf-scan-replay-'));
try {
  for (const name of fs.readdirSync(SOURCE).filter((n) => n.endsWith('.json'))) fs.copyFileSync(join(SOURCE, name), join(dir, name));
  const store = new FileScanStore(dir);

  const settings = { ...DEFAULT_SCAN_SETTINGS };
  settings.queries = REQUESTS.filter((r) => r.params.engine === 'home_depot' && r.params.hd_filter_tokens === undefined).map((r) => ({ q: String(r.params.q) }));
  settings.catalogPagesPerScan = 2;
  // As scripts/scan-cli.ts --fixtures: a made-up account, nothing is spent.
  const account = { planName: 'Fixture replay', status: 'Active', searchesPerMonth: 250, totalSearchesLeft: 250, thisMonthUsage: 0, thisHourSearches: 0, rateLimitPerHour: 250, renewalDate: null };
  const replay = replayRecorded();
  const budget = new SearchBudget(account, { reserve: 0, maxPerRun: 250 });
  const client = new SerpApiClient({ apiKey: 'FIXTURES', budget, fetchFn: replay.fetchFn, now: () => NOW });

  fsyncs = 0;
  const t = performance.now();
  const job = await runScan({ client, budget, store, settings, labelPrefix: 'fixtures', now: () => NOW });
  await postScanWork({ store, settings, now: () => NOW });
  const ms = performance.now() - t;
  const n = fsyncs;

  const bundles = (await new FileScanStore(dir).listBundles()).length;
  if (job.status !== 'done' && job.status !== 'stopped') throw new Error(`scan ended ${job.status}`);
  console.log(`scan_ms=${ms.toFixed(1)} fsyncs=${n} calls=${replay.calls.length} bundles=${bundles} status=${job.status} sha=${digest(dir)}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
