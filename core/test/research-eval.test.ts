// npm run research:eval with a fake model (no network, no key read from .env): the questions from the
// validation replay, tools from recorded files only, the runs file, its replay and the score. Also the
// scoring rules and the cost of a question.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PRICE_TABLE } from '../src/judge/eval';
import { researchCost, researchCostLabel, researchOutcome, scoreResearch } from '../src/research/eval';
import type { ResearchModel, ResearchTurn } from '../src/research/types';
import type { Suggestion } from '../src/assist/types';
import { runResearchEval, type ResearchRunsFile } from '../../scripts/research-eval-cli';
import { asked, assistWorld } from './assist-world';
import { PCL500525SB } from './research-world';

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const turn = (content: unknown[]): ResearchTurn => ({ ok: true, stopReason: 'tool_use', content, usage: { inputTokens: 3000, outputTokens: 200, webSearchRequests: 0 } });
const RIGHT = {
  quotes: [], decision: 'parts', choiceIndex: null, reason: 'The two tools, as Home Depot sells them alone.',
  parts: [
    { model: 'PCL500B', qty: 1, quotes: [
      { quote: 'RYOBI PCL500B (item 317987588): ONE+ 18V Cordless 5 1/2 in. Circular Saw (Tool Only)', sourceId: 'hd-search:ryobi-pcl500' },
      { quote: '18V 5-1/2" Circular Saw', sourceId: 'bundle' }, { quote: '18T Carbide Tipped Blade', sourceId: 'bundle' },
      { quote: '(2) Hex Wrenches', sourceId: 'bundle' },
    ] },
    { model: 'PCL525B', qty: 1, quotes: [
      { quote: 'RYOBI PCL525B (item 318898528): ONE+ 18V Cordless Jig Saw (Tool Only)', sourceId: 'hd-search:index-ryobi-one-18v-jig-saw-tool-only-pcl525b' },
      { quote: '18V Jig Saw', sourceId: 'bundle' }, { quote: 'Non-Marring Shoe', sourceId: 'bundle' },
      { quote: 'T-Shank Wood Cutting Blade', sourceId: 'bundle' },
    ] },
  ],
};

/** Researches PCL500525SB as a model might; says cannot tell for every other question. */
function fakeModel(): ResearchModel & { sent: number } {
  const byQuestion = new Map<string, number>();
  const m = {
    provider: 'fake', model: 'claude-opus-5-5', sent: 0,
    async send(req: { messages: { content: unknown }[] }) {
      m.sent++;
      const first = String(req.messages[0]!.content);
      const key = /Bundle Home Depot item id: (\d+)/.exec(first)?.[1] ?? '';
      const n = byQuestion.get(key) ?? 0;
      byQuestion.set(key, n + 1);
      if (key === '328690510') {
        return [
          turn([use('t1', 'read_homedepot_page', { itemId: '328690510', url: null })]),
          turn([use('t2', 'search_homedepot', { query: 'ryobi pcl500' }), use('t3', 'search_homedepot', { query: 'RYOBI ONE+ 18V Jig Saw Tool Only PCL525B' })]),
          turn([use('t4', 'submit_answer', RIGHT)]),
        ][n]!;
      }
      return turn([use('t1', 'submit_answer', { quotes: [], parts: [], reason: 'Not settled.', decision: 'cannot_tell', choiceIndex: null })]);
    },
  };
  return m;
}

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};

describe('npm run research:eval', () => {
  it('refuses unknown arguments, an unknown model, and a run without --max-cost', async () => {
    const { log, lines } = quiet();
    expect(await runResearchEval(['--model', 'gpt-x', '--dry-run'], { log, dir: 'fixtures', env: () => undefined })).toBe(2);
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--run'], { log, dir: 'fixtures', env: () => 'k' })).toBe(2);
    expect(lines).toContain('--run needs --max-cost: research costs tokens and web searches.');
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--run', '--max-cost', '0'], { log, dir: 'fixtures', env: () => 'k' })).toBe(2);
  });

  it('a dry run reads no key and lists the 19 split questions with their key and an estimate', async () => {
    const { log, lines } = quiet();
    const env = vi.fn(() => undefined);
    expect(await runResearchEval(['--model', 'claude-haiku-5-5', '--dry-run'], { log, dir: 'fixtures', env })).toBe(0);
    expect(env).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('Questions: 19 split questions');
    expect(lines).toContain('  split:homedepot:328690510  key PCL500B + PCL525B');
    expect(lines.some((l) => l.startsWith('Estimated cost: $'))).toBe(true);
  });

  it('a run with a fake model and recorded tools writes the runs file; a replay of it scores the same', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'research-eval-'));
    const model = fakeModel();
    const run = quiet();
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--run', '--max-cost', '5'], {
      log: run.log, dir: 'fixtures', outDir, env: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-ant-test' : undefined), makeModel: () => model, sleep: async () => {},
      now: () => new Date('2026-11-20T12:00:00Z'),
    })).toBe(0);
    expect(run.lines).toContain('Verified and correct: 1');
    expect(run.lines).toContain('Verified but wrong: 0 (must be 0 to trust)');
    expect(run.lines).toContain('Cannot tell: 18');
    expect(run.lines).toContain('    tools: read 328690510 (recorded); search "ryobi pcl500" (recorded, 10 rows); search "RYOBI ONE+ 18V Jig Saw Tool Only PCL525B" (recorded index, 10 rows)');
    expect(run.lines).toContain('Overall: no verified suggestion disagrees with the key.');
    const doc = JSON.parse(readFileSync(join(outDir, 'runs-claude-opus-5-5.json'), 'utf8')) as ResearchRunsFile;
    expect(doc.results).toHaveLength(19);
    const pcl = doc.results.find((r) => r.questionId === PCL500525SB)!;
    expect(pcl.turns).toHaveLength(3);
    expect(pcl.tools.map((t) => [t.tool, t.recorded])).toEqual([['readHomeDepotPage', true], ['searchHomeDepot', true], ['searchHomeDepot', true]]);
    expect(JSON.stringify(doc)).not.toContain('sk-ant-test');

    const replay = quiet();
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--replay'], { log: replay.log, dir: 'fixtures', outDir, env: () => undefined })).toBe(0);
    expect(replay.lines).toContain('Verified and correct: 1');
    expect(replay.lines.slice(-21)).toEqual(run.lines.slice(-21));
  });

  it('--max-cost stops before the next question and marks the file incomplete', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'research-eval-'));
    const { log, lines } = quiet();
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--run', '--max-cost', '0.05'], {
      log, dir: 'fixtures', outDir, env: () => 'sk-ant-test', makeModel: () => fakeModel(), sleep: async () => {},
    })).toBe(0);
    const doc = JSON.parse(readFileSync(join(outDir, 'runs-claude-opus-5-5.json'), 'utf8')) as ResearchRunsFile;
    expect(doc).toMatchObject({ incomplete: true, maxCost: 0.05 });
    expect(doc.results).toHaveLength(4); // 3,000 in and 200 out at Opus rates is $0.016 a question: 3 make $0.048, the 4th crosses $0.05
    expect(lines.some((l) => l.startsWith('Run cut by --max-cost $0.0500 after 4 of 19'))).toBe(true);
  });
});

describe('research scoring and cost', () => {
  it('a question costs its tokens and $0.01 a web search; the button estimate is rounded up to a cent', () => {
    expect(researchCost({ inputTokens: 1_000_000, outputTokens: 0, webSearchRequests: 2 }, PRICE_TABLE['claude-haiku-5-5']!)).toBeCloseTo(0.12);
    expect(researchCostLabel('claude-haiku-5-5')).toBe('about $0.02');
    expect(researchCostLabel('claude-opus-5-5')).toBe('about $0.20');
    expect(researchCostLabel('unknown')).toBeNull();
  });

  it('compares parts as a multiset by kitKey: PCL500 is PCL500B, a missing or extra part is wrong', async () => {
    const w = await assistWorld();
    const item = asked(w, PCL500525SB);
    const meta = { questionId: item.id, seen: '', provider: 'p', model: 'm', promptVersion: 'v' };
    const parts = (p: string[]): Suggestion => ({ ...meta, status: 'verified', answer: { decision: 'parts', kind: 'split', parts: p }, quotes: [], reason: '' });
    const truth = { kind: 'parts' as const, parts: ['PCL500B', 'PCL525B'] };
    expect(researchOutcome(parts(['PCL525B', 'PCL500']), truth, item)).toBe('verified_correct');
    expect(researchOutcome(parts(['PCL500B']), truth, item)).toBe('verified_wrong');
    expect(researchOutcome(parts(['PCL500B', 'PCL525B', 'PCL525B']), truth, item)).toBe('verified_wrong');
    expect(researchOutcome({ ...meta, status: 'cannot_tell', reason: '', quotes: [] }, truth, item)).toBe('cannot_tell');
    const s = scoreResearch([{ questionId: item.id, item, truth, suggestion: parts(['PCL500B']), called: true }]);
    expect(s).toMatchObject({ trustworthy: false, wrong: [{ questionId: item.id, said: 'parts PCL500B' }] });
  });
});
