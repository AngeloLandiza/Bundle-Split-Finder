// Step 16, lever 1, on real data only: an unverified research answer checked again (reverifyResearch) with what the scan
// stored by itself since: Home Depot's part-price readings of Nov 18 (fixtures/validation/hd-part-prices-2026-11-18.json)
// and the kits' pages. The answer key decides right and wrong.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { researchQuestion, type ResearchSuggestion } from '../src/research/loop';
import { answerModels, ledgerHasText, reverifyResearch, storedReadingEntries, unconfirmedModels, type StoredFacts } from '../src/research';
import type { ResearchModel, ResearchTurn } from '../src/research/types';
import { partKey, type MatchRecord, type PartPriceRecord } from '../src/scan/types';
import { replayedTools, type ToolCallLog } from '../../scripts/research-tools';
import type { ResearchRunsFile } from '../../scripts/research-eval-cli';
import { loadInputs } from '../../scripts/validate-cli';
import { researchCase } from './research-world';

const run = (file: string): ResearchRunsFile => JSON.parse(readFileSync(`fixtures/research/${file}`, 'utf8')) as ResearchRunsFile;
const LATEST = run('runs-claude-opus-5-5.json');
const RUN3 = run('runs-claude-opus-5-5-prompt3.json');

async function replay(doc: ResearchRunsFile, itemId: string): Promise<ResearchSuggestion & { c: Awaited<ReturnType<typeof researchCase>> }> {
  const id = `split:homedepot:${itemId}`;
  const stored = doc.results.find((r) => r.questionId === id)!;
  const c = await researchCase(id);
  let i = 0;
  const model: ResearchModel = { provider: 'replay', model: doc.model, send: async () => (stored.turns[i++] as ResearchTurn | undefined) ?? { ok: false, notJudged: { reason: 'no_answer', message: 'no more turns' } } };
  const s = await researchQuestion(c.q, c.evidence, replayedTools(stored.tools as ToolCallLog[]), model, { catalog: c.catalog });
  return Object.assign(s, { c });
}

/** Home Depot's part prices of Nov 18 as the part-price store keeps them. */
function nov18(): PartPriceRecord[] {
  return [...loadInputs('fixtures/validation').partPrices].map(([key, r]) => ({
    key, brand: r.brand.toUpperCase(), model: r.model.toUpperCase(), itemId: r.itemId, matchedModel: r.matchedModel?.toUpperCase() ?? null,
    price: r.price, title: r.title, link: r.link, seenAt: r.price === null ? null : 1, checkedAt: 1,
  }));
}

const reasons = (s: { status: string; reasons?: string[] }): string[] => (s.status === 'unverified' ? s.reasons! : []);

describe('lever 1: an unverified answer checked again with the readings the scan stored', () => {
  it('328690510 (latest run): PCL500B + PCL525B, refused for "PCL525B is not a model", verifies with Home Depot\'s readings of both; the key agrees', async () => {
    const s = await replay(LATEST, '328690510');
    expect(s.status).toBe('unverified');
    expect(reasons(s)[0]).toMatch(/^PCL525B is not a model any source read gives/);
    const answer = s.research.answer!;
    expect(answerModels(answer)).toEqual(['PCL500B', 'PCL525B']);
    expect(unconfirmedModels('RYOBI', answer, s.research.ledger, s.c.catalog)).toEqual(['PCL525B']);
    const r = reverifyResearch({ item: s.c.q, answer, ledger: s.research.ledger, catalog: s.c.catalog, evidence: s.c.evidence, facts: { partPrices: nov18() } })!;
    expect(r.added).toEqual(['hd-reading:PCL500B', 'hd-reading:PCL525B']);
    expect(r.checked.status).toBe('verified');
    if (r.checked.status !== 'verified') return;
    expect(r.checked.answer).toEqual({ decision: 'parts', kind: 'split', parts: ['PCL500B', 'PCL525B'] });
  });

  it('with no reading stored it stays unverified and asks for PCL525B to be read; a reading that found nothing is not asked for again', async () => {
    const s = await replay(LATEST, '328690510');
    const input = { item: s.c.q, answer: s.research.answer!, ledger: s.research.ledger, catalog: s.c.catalog, evidence: s.c.evidence };
    const none = reverifyResearch({ ...input, facts: { partPrices: [] } })!;
    expect(none.checked.status).toBe('unverified');
    expect(none.wanted).toEqual(['PCL525B']);
    const notFound: PartPriceRecord = { key: partKey('RYOBI', 'PCL525B'), brand: 'RYOBI', model: 'PCL525B', itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: 1 };
    const after = reverifyResearch({ ...input, facts: { partPrices: [notFound] } })!;
    expect(after.checked.status).toBe('unverified');
    expect(after.wanted).toEqual([]);
  });

  it('a reading of another model, of the bundle itself, or not found is no evidence; an Amazon match counts only graded exact, and gives no title', () => {
    const prices = nov18();
    // PCL500's reading found PCL500B (one tool by sameModel): it confirms PCL500B and PCL500, never PCL525B.
    expect(storedReadingEntries('RYOBI', 'PCL500525SB', ['PCL500'], { partPrices: prices }).map((e) => e.products[0]!.model)).toEqual(['PCL500B']);
    expect(storedReadingEntries('RYOBI', 'PCL500525SB', ['PCL525X'], { partPrices: prices })).toEqual([]);
    // P119 came back not found on Nov 18; PCL1600K2 is the bundle in a PCL1600K2 question.
    expect(storedReadingEntries('RYOBI', 'PSK1200SB', ['P119'], { partPrices: prices })).toEqual([]);
    expect(storedReadingEntries('RYOBI', 'PCL1600K2', ['PCL1600K2'], { partPrices: prices })).toEqual([]);
    const entry = storedReadingEntries('DEWALT', 'DCKTS681D1P1W34', ['DCS334B'], { partPrices: prices })[0]!;
    expect(entry).toMatchObject({ id: 'hd-reading:DCS334B', kind: 'reading', lines: [], isBundle: false });
    expect(entry.products).toEqual([{ brand: 'DEWALT', model: 'DCS334B', title: '20V MAX XR Cordless Brushless Jigsaw (Tool Only)', kit: null }]);
    expect(entry.url).toMatch(/^https:\/\/www\.homedepot\.com\//);
    const match = (grade: MatchRecord['grade']): MatchRecord => ({ key: 'DEWALT:DCS334B', brand: 'DEWALT', model: 'DCS334B', status: 'matched', asin: 'B07JPFHQKG', grade, alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null });
    const facts = (m: MatchRecord): StoredFacts => ({ partPrices: [], matches: [m] });
    expect(storedReadingEntries('DEWALT', 'X', ['DCS334B'], facts(match('probable')))).toEqual([]);
    expect(storedReadingEntries('DEWALT', 'X', ['DCS334B'], facts(match('exact')))[0]!.products).toEqual([{ brand: 'DEWALT', model: 'DCS334B', title: '', kit: null }]);
  });

  it('a ledger kept without its text cannot be checked again', async () => {
    const s = await replay(LATEST, '328690510');
    const slim = s.research.ledger.map((e) => ({ ...e, lines: [], products: [] }));
    expect(ledgerHasText(slim)).toBe(false);
    expect(reverifyResearch({ item: s.c.q, answer: s.research.answer!, ledger: slim, catalog: s.c.catalog, facts: { partPrices: nov18() } })).toBeNull();
  });

  it('a wrong answer stays unverified with every reading: 341644987 (PCL500525SB + PBP003, the key splits the SB)', async () => {
    const s = await replay(RUN3, '341644987');
    expect(s.research.answer!.parts.map((p) => p.model)).toEqual(['PCL500525SB', 'PBP003']);
    const r = reverifyResearch({ item: s.c.q, answer: s.research.answer!, ledger: s.research.ledger, catalog: s.c.catalog, evidence: s.c.evidence, facts: { partPrices: nov18() } })!;
    expect(r.checked.status).toBe('unverified');
    expect(reasons(r.checked)).toContain('PCL500525SB is a combo of 2 tools that the catalog does not know as a kit; give its tools as the parts.');
  });
});
