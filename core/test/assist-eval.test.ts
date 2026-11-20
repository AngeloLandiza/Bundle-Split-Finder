// The review assistant's eval (A1 fix round 1): truth from the answer key, scoring, and the CLI with a
// fake model. No network, no key, no real model.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { matchTruth, outcomeOf, scoreSuggestions, splitTruth } from '../src/assist/eval';
import { ASSIST_PROMPT_VERSION } from '../src/assist/prompt';
import type { AssistCallResult, AssistModel, AssistRaw, AssistRequest, Suggestion } from '../src/assist/types';
import { PRICE_TABLE } from '../src/judge/eval';
import { runAssistEval, type SuggestionsFile, suggestionsPath } from '../../scripts/assist-eval-cli';
import { asked, assistWorld } from './assist-world';

const FIX = new URL('../../fixtures/', import.meta.url).pathname;
const KEY = 'sk-ant-test-0000-not-a-real-key';
const MODEL = 'claude-haiku-5-5';

describe('truth', () => {
  it("a split's truth is the reading with the key's parts, or none when the key typed other parts", async () => {
    const w = await assistWorld();
    const psk = asked(w, 'split:homedepot:339206615');
    expect(splitTruth(psk, ['PCG002', 'PBP004', 'PBP003'])).toEqual({ kind: 'choose', choiceIndex: 0 });
    expect(splitTruth(asked(w, 'split:homedepot:342303258'), ['PBP003', 'P119'])).toEqual({ kind: 'none' });
    expect(splitTruth(psk, 'none')).toEqual({ kind: 'none' });
    expect(splitTruth(psk, null)).toBeNull();
  });

  it("a match's truth is the labelled ASINs offered, none, or uncertain", async () => {
    const w = await assistWorld();
    const q = asked(w, 'match:RYOBI:PCL265B');
    expect(matchTruth(q, { correct: ['B0BL8BC8MF'] })).toEqual({ kind: 'choose', asins: ['B0BL8BC8MF'] });
    expect(matchTruth(q, { correct: ['B0OTHER000'] })).toEqual({ kind: 'none' });
    expect(matchTruth(q, { correct: 'none' })).toEqual({ kind: 'none' });
    expect(matchTruth(q, { correct: [], uncertain: ['B0BL8BC8MF'] })).toEqual({ kind: 'uncertain' });
    expect(matchTruth(q, undefined)).toBeNull();
  });
});

describe('scoring', () => {
  const meta = { questionId: 'q', seen: '', provider: 'test', model: MODEL, promptVersion: ASSIST_PROMPT_VERSION };
  const verifiedSplit = (choiceIndex: number): Suggestion => ({ ...meta, status: 'verified', reason: '', quotes: [], answer: { decision: 'choose', kind: 'split', choiceIndex, parts: ['A'] }, usage: { inputTokens: 1000, outputTokens: 100 } });
  const verifiedNone: Suggestion = { ...meta, status: 'verified', reason: '', quotes: [], answer: { decision: 'none' }, usage: { inputTokens: 1000, outputTokens: 100 } };

  it('only a verified suggestion is right or wrong; a verified answer on an uncertain label is wrong', () => {
    expect(outcomeOf(verifiedSplit(0), { kind: 'choose', choiceIndex: 0 })).toBe('verified_correct');
    expect(outcomeOf(verifiedSplit(1), { kind: 'choose', choiceIndex: 0 })).toBe('verified_wrong');
    expect(outcomeOf(verifiedNone, { kind: 'none' })).toBe('verified_correct');
    expect(outcomeOf(verifiedNone, { kind: 'choose', asins: ['B0'] })).toBe('verified_wrong');
    expect(outcomeOf(verifiedNone, { kind: 'uncertain' })).toBe('verified_wrong');
    expect(outcomeOf({ ...meta, status: 'cannot_tell', reason: '', quotes: [] }, { kind: 'uncertain' })).toBe('cannot_tell');
  });

  it('counts outcomes, calls, tokens and cost; trustworthy only with no verified-but-wrong', () => {
    const s = scoreSuggestions([
      { questionId: 'a', truth: { kind: 'choose', choiceIndex: 0 }, suggestion: verifiedSplit(0), called: true },
      { questionId: 'b', truth: { kind: 'choose', choiceIndex: 0 }, suggestion: verifiedSplit(1), called: true },
      { questionId: 'c', truth: { kind: 'none' }, suggestion: { ...meta, status: 'not_suggested', reason: 'x' }, called: false },
    ], PRICE_TABLE['claude-opus-5-5']);
    expect(s.byOutcome).toEqual({ verified_correct: 1, verified_wrong: 1, unverified: 0, cannot_tell: 0, not_suggested: 1 });
    expect(s.wrong).toEqual([{ questionId: 'b', truth: { kind: 'choose', choiceIndex: 0 }, said: 'reading 1 (A)' }]);
    expect(s.calls).toBe(2);
    expect(s.tokens).toEqual({ input: 2000, output: 200 });
    expect(s.cost).toBeCloseTo((2000 * 4 + 200 * 20) / 1e6);
    expect(s.trustworthy).toBe(false);
  });
});

// A fake model: right on PSK1212SB (its Includes line names the parts), a verified "none" on PBP004
// (wrong: the label says B09HDZ5MPV), cannot_tell everywhere else.
const PSK1212SB_INCLUDES = 'Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries, (1) PBP003 18V ONE+ 2Ah Lithium Battery, (1) PCG002 18V ONE+ Charger';
const PBP004_TITLE = 'TTI Ryobi PBP004 ONE+ High Performance 18 Volts Lithium-Ion 4.0 Ah Battery';
const reply = (raw: Partial<AssistRaw>): AssistCallResult => ({
  ok: true, usage: { inputTokens: 1000, outputTokens: 100 },
  answer: JSON.stringify({ evidence: [], reason: 'r', decision: 'cannot_tell', choiceIndex: null, asin: null, ...raw }),
});
function fake(over?: (req: AssistRequest) => AssistCallResult | null): AssistModel & { requests: AssistRequest[] } {
  const requests: AssistRequest[] = [];
  return {
    provider: 'fake', model: MODEL, requests,
    ask: async (req) => {
      requests.push(req);
      const o = over?.(req);
      if (o) return o;
      if (req.user.includes('Bundle model number: PSK1212SB\n')) return reply({ decision: 'choose', choiceIndex: 0, evidence: [{ quote: PSK1212SB_INCLUDES, source: 'bundle' }] });
      if (req.user.includes('Part model number: PBP004\n')) return reply({ decision: 'none', evidence: [{ quote: PBP004_TITLE, source: 'listing:B09HDZ5MPV' }] });
      return reply({});
    },
  };
}

describe('npm run assist:eval', () => {
  const run = async (args: string[], extra: Partial<Parameters<typeof runAssistEval>[1]> = {}) => {
    const lines: string[] = [];
    const outDir = extra.outDir ?? mkdtempSync(join(tmpdir(), 'assist-eval-'));
    const code = await runAssistEval(args, {
      log: (l) => lines.push(l), dir: FIX, outDir, env: () => KEY, sleep: async () => {}, now: () => new Date('2026-11-20T12:00:00Z'), ...extra,
    });
    return { code, lines, text: lines.join('\n'), outDir };
  };

  it('refuses a bad command before reading anything', async () => {
    for (const args of [[], ['--model', 'gpt-4', '--dry-run'], ['--model', MODEL], ['--model', MODEL, '--dry-run', '--run'], ['--model', MODEL, '--run', '--max-cost', '-1']]) {
      expect((await run(args, { env: () => { throw new Error('env read'); } })).code, args.join(' ')).toBe(2);
    }
  });

  it('dry run: no key read, no model, the 26 questions with their truth and an estimate', async () => {
    const { code, text } = await run(['--model', MODEL, '--dry-run'], { env: () => { throw new Error('env read'); }, makeModel: () => { throw new Error('model made'); } });
    expect(code).toBe(0);
    expect(text).toContain('Questions: 26 (19 split, reopened from the answer key; 7 match, open).');
    expect(text).toContain('Model calls: 24, one each. No call for 2 that offer nothing to choose.');
    expect(text).toContain('split:homedepot:339206615  key reading 0 (PBP004, PBP003, PCG002)');
    expect(text).toContain('split:homedepot:344304336  key none fits');
    expect(text).toContain('match:RYOBI:P553  key uncertain (no answer is right)');
    expect(text).toMatch(/Estimated cost: \$0\.\d{4}\./);
  });

  it('run: asks each question once, writes the answers (no key), scores; replay gives the same score', async () => {
    const model = fake();
    const first = await run(['--model', MODEL, '--run'], { makeModel: (m, key) => { expect([m, key]).toEqual([MODEL, KEY]); return model; } });
    expect(first.code).toBe(0);
    expect(model.requests).toHaveLength(24);
    const file = suggestionsPath(first.outDir, MODEL);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(KEY);
    const doc = JSON.parse(raw) as SuggestionsFile;
    expect(doc).toMatchObject({ model: MODEL, promptVersion: ASSIST_PROMPT_VERSION, ranAt: '2026-11-20T12:00:00.000Z' });
    expect(doc.results).toHaveLength(26);
    expect(doc.results.filter((r) => !r.called).map((r) => r.questionId)).toEqual(['split:homedepot:314716732', 'split:homedepot:328690510']);
    expect(first.text).toContain('Verified and correct: 1');
    expect(first.text).toContain('Verified but wrong: 1 (must be 0 to trust)');
    expect(first.text).toContain('  match:RYOBI:PBP004: key listing B09HDZ5MPV; assistant none');
    expect(first.text).toContain('Cannot tell: 22');
    expect(first.text).toContain('Not suggested: 2');
    expect(first.text).toContain('Tokens: 24000 in, 2400 out.');
    expect(first.text).toContain('Overall: FAIL, a verified suggestion disagrees with the key.');

    const again = await run(['--model', MODEL, '--replay'], { outDir: first.outDir, env: () => { throw new Error('env read'); } });
    expect(again.code).toBe(0);
    const score = (t: string) => t.slice(t.indexOf('Questions scored'));
    expect(score(again.text)).toBe(score(first.text));
  });

  it('replay checks the stored answers with today\'s code, and says when the prompt has changed', async () => {
    const first = await run(['--model', MODEL, '--run'], { makeModel: () => fake() });
    const file = suggestionsPath(first.outDir, MODEL);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as SuggestionsFile;
    writeFileSync(file, JSON.stringify({ ...doc, promptVersion: 'review-assist-2026-11-20.1' }));
    const again = await run(['--model', MODEL, '--replay'], { outDir: first.outDir });
    expect(again.text).toContain(`The answers were given to prompt review-assist-2026-11-20.1; today's prompt is ${ASSIST_PROMPT_VERSION}.`);
    expect(again.text).toContain('Verified and correct: 1');
  });

  it('--max-cost stops before the next call once reached, and marks the file incomplete', async () => {
    // Opus: 1,000 in and 100 out cost $0.006 a call; $0.01 is reached after two calls.
    const model = fake();
    const { code, text, outDir } = await run(['--model', 'claude-opus-5-5', '--run', '--max-cost', '0.01'], { makeModel: () => model });
    expect(code).toBe(0);
    expect(model.requests).toHaveLength(2);
    const doc = JSON.parse(readFileSync(suggestionsPath(outDir, 'claude-opus-5-5'), 'utf8')) as SuggestionsFile;
    expect(doc).toMatchObject({ incomplete: true, maxCost: 0.01 });
    expect(text).toContain('Run cut by --max-cost $0.0100 after 2 of 26 questions');
  });

  it('a failed call is not suggested; a refused key stops the run and writes nothing; no key calls nothing', async () => {
    const failing = fake((req) => (req.user.includes('Bundle model number: PSK1212SB\n')
      ? { ok: false, notJudged: { reason: 'max_tokens', message: 'Claude’s answer was cut off before it finished.' } } : null));
    const { text } = await run(['--model', MODEL, '--run'], { makeModel: () => failing });
    expect(text).toContain('Not suggested: 3');
    expect(text).toContain('split:homedepot:339206615  key reading 0 (PBP004, PBP003, PCG002)  not_suggested: Claude’s answer was cut off before it finished.');

    const refused = fake(() => ({ ok: false, notJudged: { reason: 'auth', status: 401, message: 'Claude refused the API key (HTTP 401).' } }));
    const stopped = await run(['--model', MODEL, '--run'], { makeModel: () => refused });
    expect(stopped.code).toBe(1);
    expect(refused.requests).toHaveLength(1);
    expect(existsSync(suggestionsPath(stopped.outDir, MODEL))).toBe(false);

    const none = fake();
    const nokey = await run(['--model', MODEL, '--run'], { env: () => undefined, makeModel: () => none });
    expect(nokey.code).toBe(1);
    expect(none.requests).toHaveLength(0);
  });
});
