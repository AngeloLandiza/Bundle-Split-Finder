// Key stacking on Costs (Nov 25): the service's row is the totals; under it one line per key (label, used and left this
// month, state). The owner's after-scan6 runs and the ledgers rebuilt from them (fixtures/costs/after-scan6-ledgers: rows
// with no key id, as every build before key stacking wrote them), plus rows a second key made. Files only, no network.

import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCostsCli } from '../../scripts/costs-cli';
import { freeSerpPlan, keyLines } from '../src/costs/view';

const SERP1 = 'serp-one-0123456789abcdef0123456789abcdef';
const SERP2 = 'serp-two-fedcba9876543210fedcba9876543210';

describe('key lines', () => {
  it('say each key: used, left, and a refused or empty key in words', () => {
    const used = new Map([['k1', 43], ['k2', 5]]);
    const lines = keyLines('searches', [
      { id: 'k1', label: 'Key 1', left: 0, planLimit: 250, refused: false },
      { id: 'k2', label: 'Partner', left: 143, planLimit: 250, refused: false },
      { id: 'k3', label: 'Key 3', left: null, planLimit: null, refused: true },
      { id: 'k4', label: 'Key 4', left: null, planLimit: null, refused: false },
    ], used);
    expect(lines.map((l) => [l.state, l.sentence])).toEqual([
      ['out', 'Key 1: no searches left this month; 43 used this month.'],
      ['accepted', 'Partner: 5 used this month, 143 of 250 left.'],
      ['refused', 'Key 3: not accepted by SerpApi; 0 used this month.'],
      ['unchecked', 'Key 4: 0 used this month; not checked yet.'],
    ]);
  });

  it('two plans cost $0 only when every one is free', () => {
    expect(freeSerpPlan({ perMonth: 500, planName: 'Free Plan' })).toBe(true);
    expect(freeSerpPlan({ perMonth: 1250, planName: 'Free Plan + Developer' })).toBe(false);
    expect(freeSerpPlan({ perMonth: 250, planName: null })).toBe(true);
  });
});

describe('npm run costs with two SerpApi keys', () => {
  /** after-scan6 with a keys.json of two SerpApi keys and the runtime's per-key checks; two searches on key 2. */
  function folder(): { dir: string; ledgers: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sf-costs-keys-'));
    cpSync('fixtures/e2e-2026-11-23/after-scan6', dir, { recursive: true });
    const ledgers = join(dir, 'ledgers');
    mkdirSync(ledgers);
    for (const f of ['serpapi-ledger.jsonl', 'keepa-ledger.jsonl']) copyFileSync(join('fixtures/costs/after-scan6-ledgers', f), join(ledgers, f));
    appendFileSync(join(ledgers, 'serpapi-ledger.jsonl'), [
      { at: '2026-11-25T14:00:00.000Z', engine: 'amazon', key: 'amazon|k=P553', label: 'agent:lookup:P553', keyId: 'serpapi-b' },
      { at: '2026-11-25T14:01:00.000Z', engine: 'amazon', key: 'amazon|k=P554', label: 'agent:lookup:P554', keyId: 'serpapi-b' },
    ].map((r) => `${JSON.stringify(r)}\n`).join(''));
    writeFileSync(join(dir, 'store', 'keys.json'), JSON.stringify({
      serpapi: SERP1,
      serpapiKeys: [
        { id: 'serpapi-1', label: 'Key 1', addedAt: null, key: SERP1 },
        { id: 'serpapi-b', label: 'Partner', addedAt: '2026-11-25T13:00:00.000Z', key: SERP2 },
      ],
    }));
    writeFileSync(join(dir, 'store', 'runtime.json'), JSON.stringify({
      lastScheduledRunAt: null,
      serp: { left: 350, perMonth: 500, rateLimitPerHour: 100, at: '2026-11-25T13:30:00.000Z', planName: 'Free Plan' },
      serpKeys: {
        'serpapi-1': { left: 207, perMonth: 250, rateLimitPerHour: 50, at: '2026-11-25T13:30:00.000Z', planName: 'Free Plan' },
        'serpapi-b': { left: 143, perMonth: 250, rateLimitPerHour: 50, at: '2026-11-25T13:30:00.000Z', planName: 'Free Plan' },
      },
      keepa: null,
    }));
    return { dir, ledgers };
  }

  it('prints the totals, then a line per key; never a key', () => {
    const { dir, ledgers } = folder();
    const lines: string[] = [];
    expect(runCostsCli([dir, '--ledgers', ledgers, '--at', '2026-11-25T17:00:00Z', '--tz', 'America/New_York'], { log: (l) => lines.push(l) })).toBe(0);
    // The totals: the 43 searches of the old ledger and the 2 on the second key; the plan is the two plans' months.
    expect(lines).toContain('SerpApi: 45 searches this month; no limit set. ($0.00 a month; plan 500 searches a month; state ok)');
    // Rows with no key id are Key 1's; each key's left is its own check less its own rows since.
    expect(lines).toContain('  Key 1: 43 used this month, 207 of 250 left.');
    expect(lines).toContain('  Partner: 2 used this month, 141 of 250 left.');
    const all = lines.join('\n');
    expect(all).not.toContain(SERP1);
    expect(all).not.toContain(SERP2);
  });

  it('a key that ran out is named in the service sentence, which warnings and held steps carry', () => {
    const { dir, ledgers } = folder();
    const rt = join(dir, 'store', 'runtime.json');
    writeFileSync(rt, JSON.stringify({
      lastScheduledRunAt: null,
      serp: { left: 143, perMonth: 500, rateLimitPerHour: 100, at: '2026-11-25T13:30:00.000Z', planName: 'Free Plan' },
      serpKeys: {
        'serpapi-1': { left: 0, perMonth: 250, rateLimitPerHour: 50, at: '2026-11-25T13:30:00.000Z', planName: 'Free Plan' },
        'serpapi-b': { left: 143, perMonth: 250, rateLimitPerHour: 50, at: '2026-11-25T13:30:00.000Z', planName: 'Free Plan' },
      },
      keepa: null,
    }));
    const lines: string[] = [];
    runCostsCli([dir, '--ledgers', ledgers, '--at', '2026-11-25T17:00:00Z', '--tz', 'America/New_York'], { log: (l) => lines.push(l) });
    expect(lines).toContain('SerpApi: 45 searches this month; no limit set. SerpApi Key 1 has no searches left this month. ($0.00 a month; plan 500 searches a month; state ok)');
    expect(lines).toContain('  Key 1: no searches left this month; 43 used this month.');
  });
});
