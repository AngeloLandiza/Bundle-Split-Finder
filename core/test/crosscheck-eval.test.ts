// Step 16, lever 4: the cross-check harness (scripts/crosscheck-eval-cli.ts), offline only. The cases are the recorded
// runs' unverified answers; the second model's answers here are written by the test, never asked for.

import { describe, expect, it } from 'vitest';

import { CROSSCHECK_SYSTEM, crosscheckCases, parseCrosscheck, runCrosscheckEval, scoreCrosscheck, type CrosscheckAnswer } from '../../scripts/crosscheck-eval-cli';

describe('the cross-check harness', () => {
  it('builds one case per unverified parts answer, and no prompt carries the first answer\'s reason', async () => {
    const cases = await crosscheckCases('fixtures', ['runs-claude-opus-5-5.json']);
    expect(cases.map((c) => [c.item.model, c.first.join('+'), c.firstRight])).toEqual([
      ['PCL1600K2-PBP2003', 'PCL1600K2+PBP2003', true],
      ['PCL500525SB', 'PCL500B+PCL525B', true],
      ['PCL500525SB-PBP003', 'PCL500525SB+PBP003', false],
      ['PCL1600K2-A963001', 'PCL1600K2+A963001', true],
    ]);
    for (const c of cases) {
      expect(c.user).not.toMatch(/\breason\b|first answer|the parts are/i);
      expect(c.user).toContain(`Bundle: RYOBI ${c.item.model}`);
    }
    expect(CROSSCHECK_SYSTEM).toMatch(/cannot_tell/);
  });

  it('agreement is the same models and quantities; a wrong answer agreed with counts as let through', async () => {
    const cases = await crosscheckCases('fixtures', ['runs-claude-opus-5-5.json']);
    const say = (parts: [string, number][]): CrosscheckAnswer => ({ decision: 'parts', parts: parts.map(([model, qty]) => ({ model, qty })) });
    const answers = new Map<string, CrosscheckAnswer | null>([
      [cases[0]!.user, say([['PCL1600K2', 1], ['PBP2003', 1]])],
      [cases[1]!.user, say([['PCL500', 1], ['PCL525B', 1]])], // PCL500 is PCL500B by kitKey
      [cases[2]!.user, say([['PCL500525SB', 1], ['PBP003', 1]])],
      [cases[3]!.user, { decision: 'cannot_tell', parts: [] }],
    ]);
    expect(scoreCrosscheck(cases, answers)).toEqual({ cases: 4, agreeRight: 2, agreeWrong: 1, disagreeRight: 1, disagreeWrong: 0, noAnswer: 0 });
  });

  it('reads only an answer in its schema', () => {
    expect(parseCrosscheck('{"decision":"parts","parts":[{"model":"PCL525B","qty":1}]}')).toEqual({ decision: 'parts', parts: [{ model: 'PCL525B', qty: 1 }] });
    expect(parseCrosscheck('{"decision":"parts","parts":[{"model":"PCL525B","qty":0}]}')).toBeNull();
    expect(parseCrosscheck('PCL525B')).toBeNull();
  });

  it('a dry run reads no key, prints the cost estimate; a run without --max-cost or a model with no price refuses', async () => {
    const lines: string[] = [];
    const deps = { log: (l: string) => void lines.push(l), dir: 'fixtures', env: () => { throw new Error('no key may be read'); } };
    expect(await runCrosscheckEval(['--dry-run'], deps)).toBe(0);
    expect(lines.find((l) => l.startsWith('Estimated cost: $'))).toMatch(/for \d+ calls/);
    expect(await runCrosscheckEval(['--run'], deps)).toBe(2);
    expect(await runCrosscheckEval(['--dry-run', '--model', 'claude-unknown'], deps)).toBe(2);
  });
});
