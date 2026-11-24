// scripts/redteam-listings-cli.ts: the model's second opinion on confirmed listings, a harness only. Never run here: the
// provider is a fake, and without --spend nothing is called and no key is read. No network.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ModelProvider, ModelRequest } from '../src/ai/types';
import { confirmedListings, estimate, runRedteam } from '../../scripts/redteam-listings-cli';
import { AFTER_SCAN5, dealsOf, storedDeals, storeWithWrongListing } from './sanity-world';

const fake = (answer: (req: ModelRequest) => string, calls: string[]): ModelProvider => ({
  id: 'fake', label: 'Fake', model: 'claude-haiku-5-5', capabilities: { serverTools: [] },
  send: async (req) => {
    calls.push(String(req.messages[0]!.content));
    return { ok: true, content: [{ type: 'text', text: answer(req) }], stop: 'end', rawStop: 'end_turn', usage: { inputTokens: 600, outputTokens: 120 } };
  },
});
const noKey = (): string => {
  throw new Error('a key was read');
};

describe('npm run redteam:listings', () => {
  it('after-scan5 holds 46 confirmed listings; without --spend: the estimate, no key read, no call', async () => {
    expect(confirmedListings(storedDeals(AFTER_SCAN5))).toHaveLength(46);
    const lines: string[] = [];
    const calls: string[] = [];
    const code = await runRedteam([AFTER_SCAN5], { log: (l) => lines.push(l), env: noKey, makeProvider: () => fake(() => '{}', calls) });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain('46 confirmed listings');
    expect(text).toContain(`Estimated cost: $${estimate(confirmedListings(storedDeals(AFTER_SCAN5)), 'claude-haiku-5-5').usd.toFixed(4)}`);
    expect(text).toContain('Not run: nothing was called and no key was read.');
  });

  it('with --spend: the estimate first, then one call per listing; the model\'s "different" is listed for a person, nothing decided', async () => {
    const bundles = await dealsOf(await storeWithWrongListing());
    const dir = mkdtempSync(join(tmpdir(), 'sf-redteam-'));
    const file = join(dir, 'export.json');
    writeFileSync(file, JSON.stringify({ kind: 'split-finder-audit', deals: { bundles } }));
    const lines: string[] = [];
    const calls: string[] = [];
    const answer = (req: ModelRequest) => String(req.messages[0]!.content).includes('DWST60122-1')
      ? JSON.stringify({ quotes: [{ about: 'model_number', field: 'title', quote: 'DWST60122-1' }], reason: 'The title names a backpack, DWST60122-1, not the adaptor plate.', verdict: 'different' })
      : JSON.stringify({ quotes: [], reason: 'looks right', verdict: 'same' });
    const code = await runRedteam([file, '--spend', '--max-cost', '1'], { log: (l) => lines.push(l), env: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-test-not-real' : undefined), makeProvider: () => fake(answer, calls) });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text.indexOf('Estimated cost')).toBeLessThan(text.indexOf('Asked'));
    expect(calls.length).toBe(confirmedListings(bundles).length);
    expect(text).toContain('The model says not the part: 1.');
    expect(text).toMatch(/not the part\? DWST08017 on B0DGLWKS9S \(homedepot:339422000\)/);
    expect(text).not.toContain('sk-test-not-real');
  });

  it('with --spend and no key: nothing is called; a bad model or path is refused', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    expect(await runRedteam([AFTER_SCAN5, '--spend'], { log: (l) => lines.push(l), env: () => undefined, makeProvider: () => fake(() => '{}', calls) })).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.at(-1)).toBe('ANTHROPIC_API_KEY must be set. Nothing was called.');
    expect(await runRedteam([AFTER_SCAN5, '--model', 'gpt-x'], { log: () => {}, env: noKey })).toBe(2);
    expect(await runRedteam([], { log: () => {}, env: noKey })).toBe(2);
  });
});
