// Step 16, lever 3: three narrower verifier rules, each on the recorded answer it releases, with the answer key (the
// runs files keep every model turn and tool result; no network, no model), and the owner's real answer it no longer
// refuses for a technical reason (fixtures/e2e-2026-11-23).

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { bundleIdentity, ledgerFromEvidence, pageEntry } from '../src/research/ledger';
import { researchQuestion, type ResearchSuggestion } from '../src/research/loop';
import type { ResearchAnswer, ResearchModel, ResearchTurn } from '../src/research/types';
import { titleBatteryCount, verifyResearch } from '../src/research/verify';
import { replayedTools, type ToolCallLog } from '../../scripts/research-tools';
import type { ResearchRunsFile } from '../../scripts/research-eval-cli';
import { recorded, researchCase } from './research-world';

const RUN3 = JSON.parse(readFileSync('fixtures/research/runs-claude-opus-5-5-prompt3.json', 'utf8')) as ResearchRunsFile;

async function replay(doc: ResearchRunsFile, itemId: string): Promise<ResearchSuggestion & { c: Awaited<ReturnType<typeof researchCase>> }> {
  const id = `split:homedepot:${itemId}`;
  const stored = doc.results.find((r) => r.questionId === id)!;
  const c = await researchCase(id);
  let i = 0;
  const model: ResearchModel = { provider: 'replay', model: doc.model, send: async () => (stored.turns[i++] as ResearchTurn | undefined) ?? { ok: false, notJudged: { reason: 'no_answer', message: 'no more turns' } } };
  const s = await researchQuestion(c.q, c.evidence, replayedTools(stored.tools as ToolCallLog[]), model, { catalog: c.catalog });
  return Object.assign(s, { c });
}

const reasons = (s: { status: string; reasons?: string[] }): string[] => (s.status === 'unverified' ? s.reasons! : []);

describe('lever 3: narrower verifier rules, each on the answer it releases', () => {
  it('a title whose "(2)" lost its parentheses still counts two batteries', () => {
    // 324904496 as the validation set stores it (SerpApi's title), and the ones the rule leaves to kitBatteryCount.
    expect(titleBatteryCount('ONE  18V Cordless 2 Tool Combo Kit w/ Drill/Driver, Circular Saw,  Multi Tool, 2  1.5 Ah Batteries, & Charger')).toBe(2);
    // A "(n)" or a singular "Battery" is read as kitBatteryCount reads it, unchanged.
    expect(titleBatteryCount('ONE+ 18V Cordless 6-Tool Combo Kit w/ 1.5 Ah Battery, 4.0 Ah Battery, & Charger w/ (2) 2.0 Ah Batteries')).toBe(2);
    expect(titleBatteryCount('ONE+ 18V Cordless 6-Tool Combo Kit with 1.5 Ah and 4.0 Ah Batteries, Charger, and Miter Saw')).toBe(2);
    expect(titleBatteryCount('Combo Kit with 1.5 Ah Battery and 2 4.0 Ah Batteries')).toBe(2);
    expect(titleBatteryCount('Jig Saw (Tool Only)')).toBeNull();
  });

  it('324904496 (run 3): PCL1201K2 + PCL430B verifies; it was refused for "the title counts 1 battery"; the key agrees', async () => {
    const s = await replay(RUN3, '324904496');
    expect(reasons(s)).toEqual([]);
    expect(s.status).toBe('verified');
    if (s.status === 'verified') expect(s.answer).toEqual({ decision: 'parts', kind: 'split', parts: ['PCL1201K2', 'PCL430B'] });
  });

  it('341644756 (run 3): PCL1600K2 + PBP003 verifies; its Includes lists are all the kit\'s and the model number names PBP003; the key agrees', async () => {
    const s = await replay(RUN3, '341644756');
    expect(reasons(s)).toEqual([]);
    expect(s.status).toBe('verified');
    if (s.status === 'verified') expect(s.answer).toEqual({ decision: 'parts', kind: 'split', parts: ['PCL1600K2', 'PBP003'] });
  });

  it('the extra half must be the model number\'s own: PCL1600K2 + PBP004 on the same page accounts for nothing', async () => {
    const s = await replay(RUN3, '341644756');
    const a = s.research.answer!;
    const other: ResearchAnswer = { ...a, parts: a.parts.map((p) => (p.model === 'PBP003' ? { ...p, model: 'PBP004' } : p)) };
    expect(reasons(verifyResearch(other, s.c.q, s.research.ledger, s.c.catalog))).toContain('PBP004 accounts for nothing on the bundle\'s Includes list.');
  });

  it('321809549 (the owner\'s scan 2): a quote inside one list no longer "spans two lists" because another list\'s "Charger" is a word of it', async () => {
    // The page the research read: the recorded page, with the two highlights the real answer quoted (both found by the first check).
    const c = await researchCase('split:homedepot:321809549');
    const page = recorded().pages.get('321809549')!;
    const withHighlights = { ...page, sections: { ...page.sections, bullets: ['Includes: 6 Tools, 2 Batteries, Charger, Bag, and Accessories', 'Includes: (2) 2.0 Ah Batteries', ...page.sections.bullets] } };
    const ledger = [...ledgerFromEvidence(c.evidence), pageEntry('hd-page:321809549', withHighlights, bundleIdentity(c.q), '321809549')];
    const real = JSON.parse(readFileSync('fixtures/e2e-2026-11-23/store/suggestions.json', 'utf8')) as { questionId: string; suggestion: { research: { answer: ResearchAnswer } } }[];
    const answer = real.find((x) => x.questionId === 'split:homedepot:321809549')!.suggestion.research.answer;
    const r = verifyResearch({ ...answer, parts: answer.parts.map((p) => ({ ...p, quotes: p.quotes.filter((q) => q.sourceId.startsWith('hd-page')) })) }, c.q, ledger, c.catalog);
    expect(reasons(r).filter((x) => /spans two Includes lists/.test(x))).toEqual([]);
    // What stays is the known false negative: the page's "(2) PBP003" is another model than the 2-pack PBP2003.
    expect(reasons(r)).toContain('"PBP003 18V ONE+ Lithium 2.0 Ah Batteries" is model PBP003, not PBP2003.');
  });
});
