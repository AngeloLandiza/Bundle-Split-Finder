// npm run costs: the replay on the owner's after-scan6 runs and the ledgers rebuilt from them. Files only, no network.

import { describe, expect, it } from 'vitest';

import { runCostsCli } from '../../scripts/costs-cli';

const run = (at: string): string[] => {
  const lines: string[] = [];
  const code = runCostsCli(['fixtures/e2e-2026-11-23/after-scan6', '--ledgers', 'fixtures/costs/after-scan6-ledgers', '--at', at, '--tz', 'America/New_York'], { log: (l) => lines.push(l) });
  expect(code).toBe(0);
  return lines;
};

describe('npm run costs on after-scan6', () => {
  it('on Nov 25: two days of history, so each forecast is the bound his settings allow', () => {
    const out = run('2026-11-25T17:00:00Z');
    expect(out).toContain('SerpApi: 43 searches this month; no limit set. (price not entered; state ok)');
    expect(out).toContain('  Forecast [settings, 2 days, 7 scans]: at most 73 searches by Nov 30.');
    expect(out).toContain('  Forecast [settings, 2 days, 7 scans]: at most 9,698 tokens by Nov 30.');
    expect(out).toContain('  Forecast [settings, 2 days, 7 scans]: at most $25.00 by Nov 30.');
    expect(out).toContain("  A scan's step, for the blocker: 3 searches expected, 16 searches at the high end (from history).");
    expect(out).toContain('Total: $0.14 so far this month; at most $25.00 by Nov 30. SerpApi and Keepa are not counted: no price entered.');
  });

  it('on Nov 30: seven days, resampled', () => {
    const out = run('2026-11-30T17:00:00Z');
    expect(out).toContain('  Forecast [history, 7 days, 7 scans]: about 43 searches by Nov 30 (43 searches to 86 searches).');
    expect(out.some((l) => l.startsWith('  From your 7 days of history: a day used 0 to 43 searches;'))).toBe(true);
  });

  it('says how to run it', () => {
    const lines: string[] = [];
    expect(runCostsCli([], { log: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toMatch(/^Usage: npm run costs -- <data folder>/);
  });
});
