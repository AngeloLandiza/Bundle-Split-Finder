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
    expect(run.split('\n')).toHaveLength(25); // header, 23 bundles, trailing empty string
    expect(readFileSync(join(deps.outDir, 'review_20261109-120000.csv'), 'utf8').split('\n')).toHaveLength(23); // header, 21 items, trailing
    expect(logs).toContain('Searches used: 0 (replayed 5 recorded responses)');
    expect(logs).toContain('Confirmed 2 · review: inactive listing 0, missing listing 0, contents not known 21');
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
