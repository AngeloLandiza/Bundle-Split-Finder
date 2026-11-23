import { describe, expect, it } from 'vitest';

import type { ModelProvider, ModelRequest } from '../src/ai/types';
import { checkListingJudge, judgeListingWith, parseListingJudge, partKind, type ListingJudgeRaw } from '../src/listingJudge';
import { measureIdentity } from '../../scripts/measure-identity';
import { judgeRows, runListingJudgeEval, worstCaseJudge } from '../../scripts/listing-judge-eval-cli';

// Rung 3, the AI listing judge: the code's check of an answer, on recorded rows with an answer key. The model is a fake:
// no network, no key.

const rows = measureIdentity().rows;
const row = (asin: string, model: string) => rows.find((r) => r.asin === asin && r.model === model)!;

const same = (quotes: ListingJudgeRaw['quotes']): ListingJudgeRaw => ({ quotes, reason: 'The listing names the model.', verdict: 'same' });

describe("the code's check of a judge's answer", () => {
  it('a "same" with every quote on the listing, the model named and nothing contradicting is ai_checked (B07JPFHQKG, DCS334B)', () => {
    const r = row('B07JPFHQKG', 'DCS334B');
    const out = checkListingJudge(r.want, r.listing, same([
      { about: 'model_number', field: 'title', quote: 'Bare Tool Only (DCS334B)' },
      { about: 'kit_or_bare', field: 'title', quote: 'Bare Tool Only' },
    ]));
    expect(out.status).toBe('ai_checked');
    expect(out.checks).toContain('the quote names DCS334B');
  });

  it('a quote not on the listing is cannot_tell, whatever the verdict', () => {
    const r = row('B07JPFHQKG', 'DCS334B');
    expect(checkListingJudge(r.want, r.listing, same([{ about: 'model_number', field: 'title', quote: 'DEWALT DCS334B Jig Saw Kit' }])).status).toBe('cannot_tell');
  });

  it('a "same" on a kit sold with a saw is stopped by the contradictions (B0722GYTWL, DCK240C2; the key says not the part)', () => {
    const r = row('B0722GYTWL', 'DCK240C2');
    const out = checkListingJudge(r.want, r.listing, same([{ about: 'model_number', field: 'title', quote: 'DCK240C2' }]));
    expect(out.status).toBe('cannot_tell');
  });

  it('a "same" on a listing with no brand field needs a brand quote', () => {
    const r = row('B07JPFHQKG', 'DCS334B');
    const l = { ...r.listing, brand: null };
    expect(checkListingJudge(r.want, l, same([{ about: 'model_number', field: 'title', quote: '(DCS334B)' }])).status).toBe('cannot_tell');
  });

  it('a spare part whose title names the brand only after "for" is stopped (B0HN1FZ74T: "… Screw for New Ryobi P553 PBT01 …")', () => {
    const r = row('B0HN1FZ74T', 'P553');
    expect(r.key).toBe('not');
    const out = checkListingJudge(r.want, r.listing, same([{ about: 'model_number', field: 'title', quote: 'P553' }, { about: 'brand', field: 'title', quote: 'Ryobi' }]));
    expect(out.status).toBe('cannot_tell');
  });

  it('measured: against a judge that says "same" on every recorded row, the code lets no wrong listing through', () => {
    expect(worstCaseJudge(judgeRows(process.cwd(), true))).toMatchObject({ wrong: 0, right: 33 });
    expect(worstCaseJudge(judgeRows(process.cwd(), false))).toMatchObject({ wrong: 0, right: 1 });
  });

  it('reads only well-formed answers', () => {
    expect(parseListingJudge('not json').ok).toBe(false);
    expect(parseListingJudge(JSON.stringify({ quotes: [], reason: 'x', verdict: 'maybe' })).ok).toBe(false);
    expect(parseListingJudge(JSON.stringify({ quotes: [{ about: 'model_number', field: 'title', quote: 'PCL235B' }], reason: 'x', verdict: 'same' })).ok).toBe(true);
  });

  it('says what the part is only from its model shape and the kit flag', () => {
    expect(partKind({ brand: 'RYOBI', model: 'PCL235B' })).toBe('bare tool');
    expect(partKind({ brand: 'RYOBI', model: 'PBP003' })).toBe('battery');
    expect(partKind({ brand: 'DEWALT', model: 'DCK240C2', isKit: true })).toBe('kit');
    expect(partKind({ brand: 'RYOBI', model: 'A967001' })).toBe('unknown');
  });
});

const fake = (answer: (req: ModelRequest) => string): ModelProvider => ({
  id: 'fake', label: 'Fake', model: 'claude-haiku-5-5', capabilities: { serverTools: [] },
  send: async (req) => ({ ok: true, content: [{ type: 'text', text: answer(req) }], stop: 'end', rawStop: 'end_turn', usage: { inputTokens: 400, outputTokens: 100 } }),
});

describe('the eval harness', () => {
  it('judges the 215 rows rungs 0 and 1 left unknown; the dry run reads no key', async () => {
    expect(judgeRows(process.cwd(), false)).toHaveLength(215);
    const lines: string[] = [];
    const code = await runListingJudgeEval(['--model', 'claude-haiku-5-5', '--dry-run'], { log: (l) => lines.push(l), root: process.cwd(), env: () => { throw new Error('no key read'); } });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Rows: 215');
  });

  it('a judge that says "cannot_tell" every time scores 0 right, 0 wrong (one call per row, through the fake)', async () => {
    const r = row('B07JPFHQKG', 'DCS334B');
    const call = await judgeListingWith(fake(() => JSON.stringify({ quotes: [], reason: 'not sure', verdict: 'cannot_tell' })), { brand: 'DEWALT', model: 'DCS334B', kind: 'bare tool', packQty: 1 }, r.want, r.listing);
    expect(call).toMatchObject({ ok: true, outcome: { status: 'cannot_tell' } });
  });
});
