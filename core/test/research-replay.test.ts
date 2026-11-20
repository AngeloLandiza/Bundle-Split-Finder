// Research fix round 2, on the answers of the second real run (Opus 5.5, prompt .2, Nov 20), kept under its
// own name in fixtures/research/runs-claude-opus-5-5-prompt2.json (a later --run overwrites runs-<model>.json).
// Each test replays the run's own model turns, with the tool results the run kept, through today's loop and
// code. No network, no model.
//   - A product that is itself a bundle of other products is not a part (344304336: PSK1212SB, which the
//     answer key splits into PBP004 + PBP003 + PCG002); a catalogued kit is (PCL1600K2, PCL1800K3N).
//   - A kit part accounts for "6 Tools", "2 Batteries", "Charger", "Bag", "Accessories" only as its own title
//     and page state them, counts agreeing (345177929, 345178397); with no Includes list, the bundle's own
//     title shows the parts (320243671). "6-Tool … and Miter Saw" (320243741) stays unverified.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { searchEntry } from '../src/research/ledger';
import { researchQuestion, type ResearchSuggestion } from '../src/research/loop';
import type { ResearchAnswer, ResearchModel, ResearchTurn } from '../src/research/types';
import { verifyResearch } from '../src/research/verify';
import { recordedTools, replayedTools, type ToolCallLog } from '../../scripts/research-tools';
import type { ResearchRunsFile } from '../../scripts/research-eval-cli';
import { recorded, researchCase } from './research-world';

const RUN = JSON.parse(readFileSync('fixtures/research/runs-claude-opus-5-5-prompt2.json', 'utf8')) as ResearchRunsFile;

function replayModel(turns: ResearchTurn[]): ResearchModel {
  let i = 0;
  return { provider: 'replay', model: RUN.model, send: async () => turns[i++] ?? { ok: false, notJudged: { reason: 'no_answer', message: 'no more turns' } } };
}

/** The run's question replayed: its turns, the tool results it kept, the question and evidence as the replay builds them. */
async function replay(itemId: string): Promise<ResearchSuggestion & { answer0: ResearchAnswer; c: Awaited<ReturnType<typeof researchCase>> }> {
  const id = `split:homedepot:${itemId}`;
  const run = RUN.results.find((r) => r.questionId === id)!;
  const c = await researchCase(id);
  const s = await researchQuestion(c.q, c.evidence, replayedTools(run.tools as ToolCallLog[]), replayModel(run.turns), { catalog: c.catalog });
  return Object.assign(s, { answer0: s.research.answer!, c });
}

const reasons = (s: { status: string; reasons?: string[] }): string[] => (s.status === 'unverified' ? s.reasons! : []);

describe('fix round 2 on run 2', () => {
  it('the run file is the second run: prompt .2, Opus 5.5, every question with its tool results kept', () => {
    expect(RUN).toMatchObject({ model: 'claude-opus-5-5', promptVersion: 'review-research-2026-11-20.2' });
    expect(RUN.results).toHaveLength(19);
    expect(RUN.results.every((r) => r.tools.every((t) => t.result !== undefined))).toBe(true);
  });

  it('344304336: PSK1212SB is itself a bundle of PBP004, PBP003 and PCG002, so PSK1212SB + PCL265B is unverified (it verified wrong before)', async () => {
    const s = await replay('344304336');
    expect(s.answer0.parts.map((p) => p.model)).toEqual(['PSK1212SB', 'PCL265B']);
    expect(s.status).toBe('unverified');
    expect(reasons(s)).toEqual(['PSK1212SB is itself a bundle of PBP004, PBP003, PCG002: its own Home Depot page lists them, and the catalog does not know it as a kit. Give those as the parts.']);
  });

  it('344304336: its contents, as the answer key gives them, verify against the same ledger and three searches of the recorded index', async () => {
    const s = await replay('344304336');
    const tools = recordedTools(recorded(), s.c.catalog);
    const rows = [];
    for (const m of ['PBP004', 'PBP003', 'PCG002']) {
      const r = await tools.searchHomeDepot({ query: `RYOBI ${m}` });
      if ('error' in r) throw new Error(r.error);
      rows.push(searchEntry(`hd-search:${m}`, r));
    }
    const ledger = [...s.research.ledger, ...rows];
    const row = (id: string, m: string) => ({ quote: ledger.find((e) => e.id === id)!.lines.find((l) => l.model === m)!.text, sourceId: id });
    const wrench = s.answer0.parts.find((p) => p.model === 'PCL265B')!;
    const answer: ResearchAnswer = {
      quotes: [], decision: 'parts', choiceIndex: null, reason: 'The page lists PBP004, PBP003, PCG002 and PCL265.',
      parts: [
        { model: 'PBP004', qty: 1, quotes: [row('hd-search:PBP004', 'PBP004'), { quote: 'PBP004 18V 4Ah Lithium Battery', sourceId: 'bundle' }] },
        { model: 'PBP003', qty: 1, quotes: [row('hd-search:PBP003', 'PBP003'), { quote: 'PBP003 18V 2Ah Lithium Battery', sourceId: 'bundle' }] },
        { model: 'PCG002', qty: 1, quotes: [row('hd-search:PCG002', 'PCG002'), { quote: 'PCG002 Charger', sourceId: 'bundle' }] },
        wrench,
      ],
    };
    const r = verifyResearch(answer, s.c.q, ledger, s.c.catalog);
    expect(reasons(r)).toEqual([]);
    expect(r).toMatchObject({ status: 'verified', answer: { parts: ['PBP004', 'PBP003', 'PCG002', 'PCL265B'] } });
  });

  it('345177929: PCL1600K2 accounts for "6 Tools, 2 Batteries, Charger, Bag, and Accessories" by its own title and page; verified', async () => {
    const s = await replay('345177929');
    expect(reasons(s)).toEqual([]);
    expect(s).toMatchObject({ status: 'verified', answer: { parts: ['PCL1600K2', 'A963001'] } });
  });

  it('345178397: the same kit, and the 95-piece set its list quote accounts for; verified', async () => {
    const s = await replay('345178397');
    expect(reasons(s)).toEqual([]);
    expect(s).toMatchObject({ status: 'verified', answer: { parts: ['PCL1600K2', 'A989504'] } });
  });

  it('320243671: no Includes list; the title shows the 6-Tool kit, the 65-piece set and two batteries; verified', async () => {
    const s = await replay('320243671');
    expect(reasons(s)).toEqual([]);
    expect(s).toMatchObject({ status: 'verified', answer: { parts: ['PCL1600K2', 'A986501'] } });
  });

  it('320243741: "6-Tool … and Miter Saw" stays unverified, the kit\'s six tools and the saw make seven', async () => {
    const s = await replay('320243741');
    expect(reasons(s)).toEqual(['The bundle states 6 tools; the parts hold 7.']);
  });

  it('counts that disagree: an 8-Tool kit of three batteries (PCL1800K3N) for "6 Tools, 2 Batteries" is unverified', async () => {
    const s = await replay('345177929');
    const tools = recordedTools(recorded(), s.c.catalog);
    const r = await tools.searchHomeDepot({ query: 'RYOBI PCL1800K3N' });
    if ('error' in r) throw new Error(r.error);
    const ledger = [...s.research.ledger, searchEntry('hd-search:kit', r)];
    const kitRow = ledger.find((e) => e.id === 'hd-search:kit')!.lines.find((l) => l.model === 'PCL1800K3N')!.text;
    const parts = s.answer0.parts.map((p) => (p.model === 'PCL1600K2'
      ? { model: 'PCL1800K3N', qty: 1, quotes: [{ quote: kitRow, sourceId: 'hd-search:kit' }, ...p.quotes.filter((q) => q.sourceId === 'bundle')] }
      : p));
    const whole = verifyResearch({ ...s.answer0, parts }, s.c.q, ledger, s.c.catalog);
    expect(reasons(whole)).toEqual(expect.arrayContaining([
      'The bundle states 6 tools; the parts hold 8.',
      '"6 Tools" on the bundle\'s Includes list is left over: no part accounts for it.',
      '"2 Batteries" on the bundle\'s Includes list is left over: no part accounts for it.',
    ]));
    // Quoted one item at a time, each disagreement is named.
    const one = parts.map((p) => (p.model === 'PCL1800K3N' ? { ...p, quotes: [p.quotes[0]!, { quote: '6 Tools', sourceId: 'bundle' }, { quote: '2 Batteries', sourceId: 'bundle' }] } : p));
    expect(reasons(verifyResearch({ ...s.answer0, parts: one }, s.c.q, ledger, s.c.catalog))).toEqual(expect.arrayContaining([
      '"6 Tools" says 6 tools; PCL1800K3N holds 8.',
      '"2 Batteries" is 2 batteries; PCL1800K3N\'s own title and page say 3.',
    ]));
  });

  it('a kit cannot take a list it does not hold: PCL1600K2 quoting the bits list of 345177929 instead of A963001 leaves the set out', async () => {
    const s = await replay('345177929');
    const kit = s.answer0.parts.find((p) => p.model === 'PCL1600K2')!;
    const set = s.answer0.parts.find((p) => p.model === 'A963001')!;
    const alone = { ...kit, quotes: [...kit.quotes, ...set.quotes.filter((q) => q.sourceId === 'bundle')] };
    const r = verifyResearch({ ...s.answer0, parts: [alone] }, s.c.q, s.research.ledger, s.c.catalog);
    expect(reasons(r)).toEqual(expect.arrayContaining([
      '"Impact Driving Bits" on the bundle\'s Includes list is left over: no part accounts for it.',
      'The bundle\'s title names a 30-piece set that no part is.',
    ]));
  });
});
