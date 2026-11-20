import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EbayListing } from '../src/ebay/types';
import { costOf, type EvalResult, type JudgeCall, type Label, type ListingJudge, PRICE_TABLE, PROMPT_VERSION, scoreJudgements } from '../src/judge';
import { hiddenByCap, judgementsPath, type JudgementsFile, runJudgeEval, sampleLabels } from '../../scripts/judge-eval-cli';

const FIX = new URL('../../fixtures/', import.meta.url).pathname;

function tmpFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'judge-eval-'));
  mkdirSync(join(dir, 'validation'));
  mkdirSync(join(dir, 'ebay'));
  copyFileSync(join(FIX, 'validation', 'hd-part-prices-2026-11-18.json'), join(dir, 'validation', 'hd-part-prices-2026-11-18.json'));
  copyFileSync(join(FIX, 'ebay', 'validation-2026-11-19.json'), join(dir, 'ebay', 'validation-2026-11-19.json'));
  copyFileSync(join(FIX, 'ebay', 'labels.json'), join(dir, 'ebay', 'labels.json'));
  return dir;
}

const recording = JSON.parse(readFileSync(join(FIX, 'ebay', 'validation-2026-11-19.json'), 'utf8')) as { parts: Record<string, { items: Record<string, EbayListing> }> };
const allLabels = (JSON.parse(readFileSync(join(FIX, 'ebay', 'labels.json'), 'utf8')) as { labels: Label[] }).labels;

// A part with at least two labelled match listings that sold, so the value can change.
const model = Object.keys(recording.parts).find((m) => allLabels.filter((l) => l.model === m && l.verdict === 'match' && (recording.parts[m]!.items[l.itemId]?.soldQuantity ?? 0) > 0).length >= 1)!;
const listings = Object.fromEntries(Object.entries(recording.parts).map(([m, r]) => [m, r.items]));

const lab = (itemId: string, verdict: Label['verdict'], by: Label['labelledBy'] = 'draft', m = model): Label => ({ itemId, model: m, verdict, labelledBy: by });
const res = (itemId: string, verdict?: EvalResult['verdict'], usage = { inputTokens: 1000, outputTokens: 100 }): EvalResult =>
  verdict ? { itemId, model, verdict, reasons: [], usage } : { itemId, model, notJudged: { reason: 'network', message: 'x' }, reasons: [], usage: { inputTokens: 0, outputTokens: 0 } };

describe('scoreJudgements', () => {
  const matchIds = allLabels.filter((l) => l.model === model && l.verdict === 'match').map((l) => l.itemId);

  it('counts false matches by item id, recall, unsure rate and cost', () => {
    const labels = [lab('a', 'match'), lab('b', 'match'), lab('c', 'not_match'), lab('d', 'unsure'), lab('e', 'match', 'owner')];
    const results = [res('a', 'match'), res('b', 'unsure'), res('c', 'match'), res('d', 'match'), res('e', 'not_match')];
    const s = scoreJudgements({ labels, results, listings, rates: PRICE_TABLE['claude-opus-5-5']! });
    expect(s.falseMatches.map((f) => f.itemId)).toEqual(['c', 'd']);
    expect(s.trueMatchesAccepted).toBe(1);
    expect(s.labelledMatches).toBe(3);
    expect(s.recall).toBeCloseTo(1 / 3);
    expect(s.unsureRate).toBeCloseTo(1 / 5);
    expect(s.ownerChecked).toBe(1);
    expect(s.tokens).toEqual({ input: 5000, output: 500 });
    expect(s.cost).toBeCloseTo(costOf({ inputTokens: 5000, outputTokens: 500 }, { input: 4, output: 20 }));
    expect(s.cost).toBeCloseTo(0.03);
  });

  it('never counts a not-judged result, or a missing one, as a verdict', () => {
    const labels = [lab('a', 'match'), lab('b', 'not_match'), lab('c', 'match')];
    const s = scoreJudgements({ labels, results: [res('a'), res('b')], listings });
    expect(s.notJudged).toBe(3);
    expect(s.judged).toBe(0);
    expect(s.trueMatchesAccepted).toBe(0);
    expect(s.falseMatches).toEqual([]);
    expect(s.unsureRate).toBeNull();
    expect(s.recall).toBe(0);
    expect(s.cost).toBeNull();
  });

  it('compares a part value from the judge with the value from the labels', () => {
    const labels = matchIds.map((id) => lab(id, 'match'));
    const same = scoreJudgements({ labels, results: matchIds.map((id) => res(id, 'match')), listings }).partValues.find((p) => p.model === model)!;
    expect(same.changed).toBe(false);
    expect(same.fromLabels).not.toBeNull();
    const none = scoreJudgements({ labels, results: matchIds.map((id) => res(id, 'unsure')), listings }).partValues.find((p) => p.model === model)!;
    expect(none.fromJudge).toBeNull();
    expect(none.changed).toBe(true);
  });

  it('prints the bar: the real labels fail on owner-checked, and every line passes only when all hold', () => {
    const s = scoreJudgements({ labels: allLabels, results: [], listings });
    expect(s.labelled).toBe(217);
    expect(s.ownerChecked).toBe(0);
    expect(s.reliable.map((r) => r.pass)).toEqual([true, false, true, false]);
    expect(s.passes).toBe(false);
    const labels = Array.from({ length: 100 }, (_, i) => lab(`i${i}`, 'match', i < 30 ? 'owner' : 'draft'));
    const all = scoreJudgements({ labels, results: labels.map((l) => res(l.itemId, 'match')), listings });
    expect(all.reliable.every((r) => r.pass)).toBe(true);
    expect(all.passes).toBe(true);
    const one = scoreJudgements({ labels: [...labels, lab('x', 'not_match')], results: [...labels, lab('x', 'not_match')].map((l) => res(l.itemId, 'match')), listings });
    expect(one.passes).toBe(false);
  });
});

describe('judge:eval', () => {
  const run = async (args: string[], dir: string, extra: Partial<Parameters<typeof runJudgeEval>[1]> = {}) => {
    const lines: string[] = [];
    const code = await runJudgeEval(args, { log: (l) => lines.push(l), dir, env: () => undefined, sleep: async () => {}, ...extra });
    return { code, text: lines.join('\n') };
  };

  it('rejects an unknown model or a missing mode before doing anything', async () => {
    const dir = tmpFixtures();
    expect((await run(['--model', 'gpt-5', '--dry-run'], dir)).code).toBe(2);
    expect((await run(['--dry-run'], dir)).code).toBe(2);
    expect((await run(['--model', 'claude-haiku-5-5'], dir)).code).toBe(2);
    expect((await run(['--model', 'claude-haiku-5-5', '--run', '--dry-run'], dir)).code).toBe(2);
  });

  it('dry run prints listings, estimated tokens and cost, and reads no key', async () => {
    const dir = tmpFixtures();
    let envRead = false;
    const { code, text } = await run(['--model', 'claude-opus-5-5', '--dry-run'], dir, { env: () => { envRead = true; return 'k'; } });
    expect(code).toBe(0);
    expect(envRead).toBe(false);
    expect(text).toContain('Listings to judge: 217');
    expect(text).toMatch(/Estimated input: \d+ tokens/);
    expect(text).toContain('characters / 4');
    expect(text).toContain('assumed 400');
    expect(text).toMatch(/Estimated cost: \$\d/);
    expect(existsSync(judgementsPath(dir, 'claude-opus-5-5'))).toBe(false);
  });

  it('a run with a fake judge writes the file shape, records failures as not judged, and keeps the key out', async () => {
    const dir = tmpFixtures();
    let n = 0;
    const usage = { inputTokens: 1500, outputTokens: 300 };
    const fake: ListingJudge = {
      id: 'fake', model: 'claude-haiku-5-5',
      async judge(): Promise<JudgeCall> {
        const base = { judgeId: 'fake', model: 'claude-haiku-5-5', promptVersion: PROMPT_VERSION };
        n++;
        if (n % 2 === 0) return { ...base, ok: false, notJudged: { reason: 'rate_limited', message: 'Claude is busy.' } };
        return { ...base, ok: true, answer: 'not json', usage };
      },
    };
    const { code, text } = await run(['--model', 'claude-haiku-5-5', '--run'], dir, { env: () => 'sk-ant-SECRET', makeJudge: () => fake, now: () => new Date('2026-11-20T00:00:00Z'), pauseMs: 0 });
    expect(code).toBe(0);
    expect(n).toBe(217);
    const raw = readFileSync(judgementsPath(dir, 'claude-haiku-5-5'), 'utf8');
    expect(raw).not.toContain('SECRET');
    expect(text).not.toContain('SECRET');
    expect(raw).not.toMatch(/seller|feedback/i);
    const file = JSON.parse(raw) as JudgementsFile;
    expect(file.model).toBe('claude-haiku-5-5');
    expect(file.promptVersion).toBe(PROMPT_VERSION);
    expect(file.ranAt).toBe('2026-11-20T00:00:00.000Z');
    expect(file.results).toHaveLength(217);
    const failed = file.results.filter((r) => r.notJudged);
    expect(failed).toHaveLength(108);
    for (const r of failed) { expect(r.verdict).toBeUndefined(); expect(r.notJudged?.reason).toBe('rate_limited'); }
    for (const r of file.results.filter((r) => !r.notJudged)) { expect(r.verdict).toBe('unsure'); expect(r.usage).toEqual(usage); }
    expect(text).toContain('Not judged: 108');
    expect(text).toContain('FAIL  at least 30 checked by the owner');

    const replay = await run(['--model', 'claude-haiku-5-5', '--replay'], dir);
    expect(replay.code).toBe(0);
    expect(replay.text).toContain('Not judged: 108');
    expect(replay.text).toContain('Overall: FAIL');
  });

  it('the run asks for ANTHROPIC_API_KEY and calls nothing without it; replay needs a file', async () => {
    const dir = tmpFixtures();
    expect((await run(['--model', 'claude-haiku-5-5', '--run'], dir)).code).toBe(1);
    expect((await run(['--model', 'claude-haiku-5-5', '--replay'], dir)).code).toBe(1);
  });

  it('counts the capped summaries that name the model in the title, on the real recording', () => {
    const rec = JSON.parse(readFileSync(join(FIX, 'ebay', 'validation-2026-11-19.json'), 'utf8')) as { parts: Parameters<typeof hiddenByCap>[0] };
    const parts = (JSON.parse(readFileSync(join(FIX, 'validation', 'hd-part-prices-2026-11-18.json'), 'utf8')) as { prices: Parameters<typeof hiddenByCap>[1] }).prices;
    const c = hiddenByCap(rec.parts, parts);
    expect(c.ofCapped).toBeGreaterThanOrEqual(c.hidden);
    expect(c.ofCapped).toBeGreaterThan(0);
  });
});

describe('judge:eval --sample and --max-cost (fix round 3)', () => {
  const run = async (args: string[], dir: string, extra: Partial<Parameters<typeof runJudgeEval>[1]> = {}) => {
    const lines: string[] = [];
    const code = await runJudgeEval(args, { log: (l) => lines.push(l), dir, env: () => 'sk-ant-SECRET', sleep: async () => {}, pauseMs: 0, ...extra });
    return { code, text: lines.join('\n') };
  };
  const usage = { inputTokens: 10_000, outputTokens: 1_000 }; // Haiku: $0.0015 a call
  const perCall = costOf(usage, PRICE_TABLE['claude-haiku-5-5']!);
  const fakeJudge = (calls: string[]): ListingJudge => ({
    id: 'fake',
    model: 'claude-haiku-5-5',
    async judge(input): Promise<JudgeCall> {
      calls.push(input.listing.itemId);
      return { judgeId: 'fake', model: 'claude-haiku-5-5', promptVersion: PROMPT_VERSION, ok: true, answer: 'not json', usage };
    },
  });

  it('sampleLabels: sorted by model then item id, n evenly spaced, the same every time', () => {
    const s = sampleLabels(allLabels, 10);
    expect(s).toHaveLength(10);
    expect(sampleLabels(allLabels, 10)).toEqual(s);
    const sorted = [...allLabels].sort((a, b) => (a.model === b.model ? (a.itemId < b.itemId ? -1 : 1) : a.model < b.model ? -1 : 1));
    expect(s).toEqual([0, 21, 43, 65, 86, 108, 130, 151, 173, 195].map((i) => sorted[i]));
    expect(sampleLabels(allLabels, 500)).toHaveLength(217);
    expect(sampleLabels([...allLabels].reverse(), 10)).toEqual(s);
  });

  it('dry run with --sample says it is a sample and counts only the sample', async () => {
    const { code, text } = await run(['--model', 'claude-haiku-5-5', '--dry-run', '--sample', '20'], tmpFixtures());
    expect(code).toBe(0);
    expect(text).toContain('Listings to judge: 20 (a sample of 217');
  });

  it('a run with --sample judges only the sample, writes it, and the score says it is a sample', async () => {
    const dir = tmpFixtures();
    const calls: string[] = [];
    const { code, text } = await run(['--model', 'claude-haiku-5-5', '--run', '--sample', '12'], dir, { makeJudge: () => fakeJudge(calls) });
    expect(code).toBe(0);
    expect(calls).toEqual(sampleLabels(allLabels, 12).map((l) => l.itemId));
    const file = JSON.parse(readFileSync(judgementsPath(dir, 'claude-haiku-5-5'), 'utf8')) as JudgementsFile;
    expect(file.results).toHaveLength(12);
    expect(file.sample).toBe(12);
    expect(file.incomplete).toBeUndefined();
    expect(text).toContain('Sample: 12 of 217 labelled listings');
    expect(text).toContain('Labelled listings: 12');
    // A replay scores the same sample, not 205 listings as never judged.
    const replay = await run(['--model', 'claude-haiku-5-5', '--replay'], dir);
    expect(replay.text).toContain('Sample: 12 of 217 labelled listings');
    expect(replay.text).toContain('Not judged: 0');
  });

  it('--max-cost stops before the next call once the cost reaches it, writes the part marked incomplete, scores only what was judged', async () => {
    const dir = tmpFixtures();
    const calls: string[] = [];
    const max = (perCall * 2.5).toFixed(6);
    const { code, text } = await run(['--model', 'claude-haiku-5-5', '--run', '--max-cost', max], dir, { makeJudge: () => fakeJudge(calls) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(3); // $0.0030 < $0.00375 after two calls, $0.0045 after three
    const file = JSON.parse(readFileSync(judgementsPath(dir, 'claude-haiku-5-5'), 'utf8')) as JudgementsFile;
    expect(file.incomplete).toBe(true);
    expect(file.results).toHaveLength(3);
    expect(text).toMatch(/Run cut by --max-cost \$[\d.]+ after 3 of 217 listings/);
    expect(text).toContain('Labelled listings: 3');
    expect(text).toContain('Judged: 3. Not judged: 0');
    expect(text).not.toContain('SECRET');

    const replay = await run(['--model', 'claude-haiku-5-5', '--replay'], dir);
    expect(replay.code).toBe(0);
    expect(replay.text).toMatch(/cut by --max-cost/);
    expect(replay.text).toContain('Labelled listings: 3');
  });

  it('a max cost never reached judges everything and is not incomplete', async () => {
    const dir = tmpFixtures();
    const calls: string[] = [];
    const { code } = await run(['--model', 'claude-haiku-5-5', '--run', '--sample', '5', '--max-cost', '10'], dir, { makeJudge: () => fakeJudge(calls) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(5);
    expect((JSON.parse(readFileSync(judgementsPath(dir, 'claude-haiku-5-5'), 'utf8')) as JudgementsFile).incomplete).toBeUndefined();
  });

  it('rejects a bad --sample or --max-cost before doing anything', async () => {
    const dir = tmpFixtures();
    for (const bad of [['--sample', '0'], ['--sample', 'x'], ['--sample'], ['--max-cost', '-1'], ['--max-cost', 'lots'], ['--max-cost']]) {
      expect((await run(['--model', 'claude-haiku-5-5', '--run', ...bad], dir, { makeJudge: () => fakeJudge([]) })).code).toBe(2);
    }
    expect(existsSync(judgementsPath(dir, 'claude-haiku-5-5'))).toBe(false);
  });
});
