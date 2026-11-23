import { describe, expect, it } from 'vitest';
import type * as C from '@core/api/contract';
import { mapReview, readBrief } from '../api/map';
import real from '../api/mockReal.json';
import type { ReviewQuestion } from '../api/types';
import { BRIEF_LINE_MAX, BRIEF_REASONS_MAX, briefFor, briefFromQuestion, describeParts, modelsOfAnswer, rowState, sentencesOf, shortLine } from './reviewBrief';

// The owner's real questions: the third scan's ten open questions (fixtures/e2e-2026-11-23/after-scan3/store/review.json,
// as the agent's own view gives them) and the second scan's fifteen, which carry the AI's real suggestions.
const data = real as unknown as { scan3: { review: C.ReviewResponse }; review: C.ReviewResponse };
const third = mapReview(data.scan3.review).questions;
const second = mapReview(data.review).questions;
const all = [...third, ...second];

/** The real "could not tell" the owner saw on PCL406424SB (his screenshot): the AI's own words, no answer. */
const couldNotTell: ReviewQuestion = {
  ...third.find((q) => q.bundle.model === 'PCL406424SB-A21701-A25RS51')!,
  suggestion: {
    status: 'cannot_tell',
    choiceId: null,
    answer: '',
    reason: 'PCL406424SB looks like a special-buy set of two tools rather than a catalog kit, and Home Depot search failed, so the exact tool-only model numbers inside it could not be confirmed.',
    quotes: [
      { text: "Includes: 18V ONE+ Cordless Compact Router, (1) collet wrench, (1) vacuum Dust Chute, 18V 5\" Random Orbit Sander, (3) Pieces of Sandpaper Assortment, Dust Collection Bag, and Operator's Manuals", source: { label: 'Home Depot page', url: 'https://www.homedepot.com/p/x/335724135' } },
    ],
    costUsd: 0.06,
  },
};

describe('the real questions', () => {
  it('are all there', () => {
    expect(third).toHaveLength(10);
    expect(second).toHaveLength(15);
  });

  it.each(all.map((q) => [q.id, q] as const))('%s: at most 3 reasons, every line within 110 characters, no quote dump', (_id, q) => {
    const b = briefFromQuestion(q);
    expect(b.reasons.length).toBeLessThanOrEqual(BRIEF_REASONS_MAX);
    const lines = [b.ask, b.suggestion ?? '', ...b.reasons.map((r) => r.text), b.check?.text ?? ''];
    for (const line of lines) if (line !== b.suggestion) expect(line.length, line).toBeLessThanOrEqual(BRIEF_LINE_MAX);
    // A reason is never a page's feature bullet or a quote the evidence already holds.
    const quoted = [...q.evidence, ...(q.suggestion?.quotes ?? [])].map((x) => x.text.trim());
    for (const r of b.reasons) {
      expect(r.text).not.toMatch(/^["“]/);
      expect(quoted.includes(r.text.replace(/\.$/, '')), r.text).toBe(false);
      expect(r.text).not.toMatch(/torque|orbits per minute|RPM|vibration|Includes:/);
    }
  });

  it('every source link a reason carries is an address that came from the data', () => {
    for (const q of all) {
      const known = new Set<string>([q.bundle.link ?? '', ...q.evidence.map((e) => e.source.url ?? ''), ...(q.suggestion?.quotes ?? []).map((e) => e.source.url ?? ''), ...q.choices.map((c) => c.source?.url ?? '')]);
      for (const r of briefFromQuestion(q).reasons) if (r.url) expect(known.has(r.url), `${q.id} ${r.url}`).toBe(true);
    }
  });

  it('snapshot: the card of every real question', () => {
    const out = Object.fromEntries([...all, couldNotTell].map((q, i) => [`${i < all.length ? (i < third.length ? 'scan3' : 'scan2') : 'screenshot'} ${q.id}`, { ...briefFromQuestion(q), row: rowState(q) }]));
    expect(out).toMatchSnapshot();
  });
});

describe('the card, by state', () => {
  it('has no suggestion and says why it is asked when the AI has not answered', () => {
    const q = third.find((x) => x.bundle.model === 'PCL1600K2-PBP2003')!;
    const b = briefFromQuestion(q);
    expect(b).toMatchObject({ ask: 'What is inside this bundle?', suggestion: null, state: 'none', writtenBy: 'rules' });
    expect(b.reasons[0]!.text).toContain('Amazon’s list of RYOBI tools');
    expect(b.check).toMatchObject({ linkLabel: 'Home Depot page', url: q.bundle.link });
    expect(rowState(q)).toBe('Needs the parts');
  });

  it('a match question asks for a listing and checks the Amazon listing', () => {
    const q = third.find((x) => x.kind === 'match' && x.bundle.model === 'A98401')!;
    const b = briefFromQuestion(q);
    expect(b.ask).toBe('Which Amazon listing is this part?');
    expect(b.check?.linkLabel).toMatch(/Amazon/);
    expect(rowState(q)).toBe('Needs a listing');
  });

  it('a suggestion the code could not check is not verified, names the AI’s parts and the first unmet thing', () => {
    const q = second.find((x) => x.bundle.model === 'PCL1201K2-PCL430B')!;
    const b = briefFromQuestion(q);
    expect(b.state).toBe('not_verified');
    expect(b.suggestion).toBe('PCL1201K2 kit + PCL430B tool');
    expect(b.check?.text).toMatch(/different tool counts/);
    expect(rowState(q)).toBe('Suggested: 2 parts');
  });

  it('names what a part is only where the data says it (a catalog line "(kit)", or the AI right after the model)', () => {
    const q = second.find((x) => x.bundle.model === 'PCL1600K2-PBP2003')!;
    expect(briefFromQuestion(q).suggestion).toBe('PCL1600K2 kit + PBP2003 battery');
    // No word anywhere about DCS334B: it is named by its model alone.
    const dewalt = second.find((x) => x.bundle.model === 'DCKTS681D1P1W34')!;
    expect(briefFromQuestion(dewalt).suggestion).toBe('DCKTS681D1P1 kit + DCS334B');
  });

  it('cannot tell: no suggestion, what is missing in one sentence, and what to do', () => {
    const b = briefFromQuestion(couldNotTell);
    expect(b.state).toBe('cannot_tell');
    expect(b.suggestion).toBeNull();
    expect(b.reasons).toHaveLength(1);
    expect(b.reasons[0]!.text).toBe('The exact tool-only model numbers inside it could not be confirmed.');
    expect(b.check).toMatchObject({ text: 'Pick the parts below, or open the page.', linkLabel: 'Home Depot page' });
    expect(rowState(couldNotTell)).toBe('AI could not tell');
  });

  it('a verified suggestion has no check', () => {
    const base = second.find((x) => x.bundle.model === 'PCL1201K2-PCL430B')!;
    const q: ReviewQuestion = { ...base, suggestion: { ...base.suggestion!, status: 'verified', plain: null } };
    const b = briefFromQuestion(q);
    expect(b).toMatchObject({ state: 'verified', check: null });
    expect(rowState(q)).toBe('Verified: 2 parts');
  });

  it('an AI answer that is none of the choices says so', () => {
    const base = second.find((x) => x.bundle.model === 'PCL1201K2-PCL430B')!;
    const q: ReviewQuestion = { ...base, suggestion: { ...base.suggestion!, status: 'unmatched', choiceId: null, answer: 'None of these fits' } };
    expect(briefFromQuestion(q).suggestion).toBe('None of these choices fit');
    expect(rowState(q)).toBe('AI: none fit');
  });

  it('uses the agent’s brief as it is when it sent one', () => {
    const q = { ...third[0]!, brief: { ask: 'Asked?', suggestion: 'X', state: 'verified' as const, reasons: [], check: null, writtenBy: 'ai' as const } };
    expect(briefFor(q)).toBe(q.brief);
    expect(briefFor(third[0]!)).toEqual(briefFromQuestion(third[0]!));
  });
});

describe('the helpers', () => {
  it('shortLine keeps a short line, drops a parenthetical, ends at a claim boundary, else at a word', () => {
    expect(shortLine('One line.')).toBe('One line.');
    expect(shortLine('The model number reads as two items (PCL1600K2 + PBP2003), but one of them is not on Amazon’s list of RYOBI tools yet.')).toBe(
      'The model number reads as two items, but one of them is not on Amazon’s list of RYOBI tools yet.',
    );
    const boundary = 'The bundle is the PCL1600K2 6-tool kit plus the PBP2003 two-pack of batteries, and the page says nothing else about it at all.';
    expect(shortLine(boundary)).toBe('The bundle is the PCL1600K2 6-tool kit plus the PBP2003 two-pack of batteries.');
    // A list is never cut at its comma: "the 65-piece drill and impact drive kit" must not become "the 65-piece drill".
    const list = "The bundle's page lists two items, the PCL1600K2 6-tool kit and the A986501 65-piece drill and impact drive kit, and both appear in the model number.";
    const cut = shortLine(list);
    expect(cut.length).toBeLessThanOrEqual(BRIEF_LINE_MAX);
    expect(cut).toContain('drill and impact drive');
    const run = 'word '.repeat(40).trim();
    expect(shortLine(run).endsWith('…')).toBe(true);
    expect(shortLine(run).length).toBeLessThanOrEqual(BRIEF_LINE_MAX);
    // No line ends on "the…".
    expect(shortLine('The page counts 3 batteries in total, so the third must be the added PBP003 2.0 Ah battery named in the bundle model number and more words')).not.toMatch(/\b(the|in|of)…$/);
  });
  it('sentencesOf does not split inside "7-1/4 in. Compound Miter Saw"', () => {
    expect(sentencesOf('It has a 7-1/4 in. Compound Miter Saw. And a kit.')).toEqual(['It has a 7-1/4 in. Compound Miter Saw.', 'And a kit.']);
  });
  it('modelsOfAnswer and describeParts read both the "+" and the comma form', () => {
    expect(modelsOfAnswer('PCL1600K2 + PBP006 ×2')).toEqual(['PCL1600K2', 'PBP006']);
    expect(modelsOfAnswer('PCL1600K2, A986501')).toEqual(['PCL1600K2', 'A986501']);
    expect(describeParts('A1, B2', null, ['RYOBI A1 (kit): x'])).toBe('A1 kit + B2');
  });
  it('readBrief keeps a brief of the promised shape and drops any other', () => {
    const ok = { ask: 'A?', suggestion: null, state: 'none', reasons: [{ text: 't', url: 'https://x.test' }], check: { text: 'c' }, writtenBy: 'ai' };
    expect(readBrief(ok)).toEqual(ok);
    expect(readBrief({ ...ok, state: 'maybe' })).toBeUndefined();
    expect(readBrief({ ...ok, reasons: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] })).toBeUndefined();
    expect(readBrief('no')).toBeUndefined();
  });
});
