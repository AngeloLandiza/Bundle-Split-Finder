import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CliDeps, runScanCli } from '../../scripts/scan-cli';
import { replayRecorded } from '../../scripts/replay';
import { SearchBudget } from '../src/serpapi/budget';
import { type LedgerEntry, MemoryCache, SerpApiClient } from '../src/serpapi/client';

// No test here opens the paid client: openClient either throws or hands back a client
// over the replay of fixtures/recorded/.

const NOW = Date.UTC(2026, 10, 9, 12);
let dir: string;
let logs: string[];
let deps: CliDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scan-cli-'));
  logs = [];
  deps = {
    log: (line) => logs.push(line),
    outDir: join(dir, 'out'),
    now: () => NOW,
    openClient: (() => {
      throw new Error('openClient must not be called');
    }) as unknown as CliDeps['openClient'],
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('npm run scan', () => {
  it('runs the whole pipeline on recordings and writes both files', async () => {
    const code = await runScanCli(['--fixtures'], deps);
    expect(code).toBe(0);
    const run = readFileSync(join(deps.outDir, 'run_20261109-120000.csv'), 'utf8');
    expect(run.split('\n')[1]).toMatch(/^confirmed,RYOBI,PBLRC2501SB,.*,268\.55,189,79\.55,0\.4209,,https:/);
    // Both parts are on the DEWALT brand page: the bundle is confirmed, at a small estimated loss.
    expect(run.split('\n')[2]).toMatch(/^confirmed,DEWALT,DCK540D1WCS334B,.*,486\.2,499,-12\.8,-0\.0257,,https:/);
    // PCL515B is on the RYOBI brand page; no Amazon result names the kit PCL1201K2.
    expect(run.split('\n')[4]).toMatch(/^missing_listing,RYOBI,PCL1201K2-PCL515B,.*,PCL1201K2,https:/);
    expect(run.split('\n')).toHaveLength(25); // header, 23 bundles, trailing empty string
    expect(readFileSync(join(deps.outDir, 'review_20261109-120000.csv'), 'utf8').split('\n')).toHaveLength(21); // header, 19 items, trailing
    // Two brand pages, three Home Depot pages, lookups for PBLRC01B, PBLRC25B and PCL1201K2.
    expect(logs).toContain('Searches used: 0 (replayed 8 recorded responses)');
    expect(logs).toContain('Scan done');
    expect(logs.filter((l) => l.startsWith('Note:'))).toEqual([]);
    const counts = logs.indexOf('Pages 3 · products 66 · bundles 23 · parts matched 5');
    expect(counts).toBeGreaterThanOrEqual(0);
    expect(logs[counts + 1]).toBe('Amazon listings saved 183 · parts matched without a search 3');
    expect(logs).toContain('Confirmed 3 · review: inactive listing 0, missing listing 1, contents not known 19');
    expect(logs).toContain('Profit figures are estimates from fee settings, not real Amazon fees.');
  });

  it.each([[[]], [['--limit', '0']], [['--limit', '51']], [['--limit', 'ten']]])('refuses %j without opening a client', async (args) => {
    expect(await runScanCli(args, deps)).toBe(1);
  });

  it('a dry run opens nothing', async () => {
    expect(await runScanCli(['--limit', '40', '--dry-run'], deps)).toBe(0);
    expect(logs).toContain('Would spend up to 40 searches from the demo bucket.');
  });

  it('a paid run goes through the injected client with the demo label and releases the lock', async () => {
    const ledger: LedgerEntry[] = [];
    const release = vi.fn();
    const budget = new SearchBudget(
      { planName: 'Test', status: 'Active', searchesPerMonth: 250, totalSearchesLeft: 250, thisMonthUsage: 0, thisHourSearches: 0, rateLimitPerHour: 250, renewalDate: null },
      { reserve: 0, maxPerRun: 5 },
    );
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => NOW, onSpend: (e) => void ledger.push(e) });
    const opened: unknown[][] = [];
    deps.openClient = (async (...a: unknown[]) => {
      opened.push(a);
      return { client, budget, account: {}, allowance: 5, release };
    }) as unknown as CliDeps['openClient'];

    expect(await runScanCli(['--limit', '5', '--query', 'ryobi extended reach ratchet'], deps)).toBe(0);
    expect(opened).toEqual([['demo', 5]]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((e) => e.label.startsWith('demo:'))).toBe(true);
    expect(logs).toContain(`Searches used: ${ledger.length}`);
  });

  /**
   * A paid run over the replay, except that a request whose decoded `k` is one of `fail` gets
   * HTTP 500. The default settings read one brand page (DEWALT) before the query's page.
   */
  function failingClient(fail: string[]): void {
    const budget = new SearchBudget(
      { planName: 'Test', status: 'Active', searchesPerMonth: 250, totalSearchesLeft: 250, thisMonthUsage: 0, thisHourSearches: 0, rateLimitPerHour: 250, renewalDate: null },
      { reserve: 0, maxPerRun: 5 },
    );
    const replay = replayRecorded();
    const fetchFn = (async (input: string | URL | Request) => {
      const k = new URL(String(input instanceof Request ? input.url : input)).searchParams.get('k');
      if (k !== null && fail.includes(k)) return new Response(JSON.stringify({ error: 'refused' }), { status: 500 });
      return replay.fetchFn(input);
    }) as typeof fetch;
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn, now: () => NOW });
    deps.openClient = (async () => ({ client, budget, account: {}, allowance: 5, release: vi.fn() })) as unknown as CliDeps['openClient'];
  }

  const RATCHET_RUN = ['--limit', '5', '--query', 'ryobi extended reach ratchet'];

  it('says a scan that set a failed lookup aside finished with work left, and why', async () => {
    failingClient(['RYOBI PBLRC01B']);
    expect(await runScanCli(RATCHET_RUN, deps)).toBe(0);
    expect(logs).not.toContain('Scan done');
    const status = logs.indexOf('Scan finished; some steps were set aside');
    expect(status).toBeGreaterThanOrEqual(0);
    expect(logs[status + 1]).toBe('Note: SerpApi returned HTTP 500.');
    expect(logs.filter((l) => l.startsWith('Scan '))).toEqual(['Scan finished; some steps were set aside']);
  });

  it('adds a note to a scan that is done but skipped a brand page', async () => {
    failingClient(['DEWALT']);
    expect(await runScanCli(RATCHET_RUN, deps)).toBe(0);
    const status = logs.indexOf('Scan done');
    expect(status).toBeGreaterThanOrEqual(0);
    expect(logs[status + 1]).toBe('Note: The DEWALT Amazon page 1 was skipped: SerpApi returned HTTP 500.');
  });

  it('adds no note when a failure stopped the scan: the stop line already says it', async () => {
    failingClient(['RYOBI PBLRC01B', 'RYOBI PBLRC25B']);
    expect(await runScanCli(RATCHET_RUN, deps)).toBe(0);
    expect(logs).toContain('Scan stopped: a search failed: SerpApi returned HTTP 500.');
    expect(logs.filter((l) => l.startsWith('Note:'))).toEqual([]);
  });

  it('releases the lock when the scan throws', async () => {
    const release = vi.fn();
    deps.openClient = (async () => ({
      client: { search: () => Promise.reject(new Error('boom')) },
      budget: { spendable: 5, blockReason: () => null },
      account: {},
      allowance: 5,
      release,
    })) as unknown as CliDeps['openClient'];
    await runScanCli(['--limit', '5'], deps).catch(() => undefined);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
