import { describe, expect, it } from 'vitest';

import { corpusGrade, pairKey, pairProblem, readCorpus } from '../../scripts/audit-cli';
import { grade } from '../src/match';
import { wantedFor } from '../src/scan/classify';

// Every labelled (part, Amazon listing) pair from the audits and the validation set
// (fixtures/audit/corpus.json, docs/audit.md), graded by the matcher as a scan grades a search row:
//   labelled not the part  -> never probable or better (a scan would use it)
//   labelled the part      -> at least review (never silently rejected)
//   uncertain              -> not asserted: a person settles it first.
// A pair marked `known` fails today for the reason it gives; it must keep failing, so the mark is
// removed in the commit that fixes it.

const corpus = readCorpus('fixtures/audit/corpus.json');
const show = (p: (typeof corpus.pairs)[number], why: string) => `${p.part.brand} ${p.part.model} ${p.listing.asin} "${p.listing.title}": ${why}`;

describe('the labelled corpus, through the matcher', () => {
  it('holds pairs, one per part and listing, each known mark with its reason', () => {
    expect(corpus.pairs.length).toBeGreaterThan(0);
    const keys = corpus.pairs.map(pairKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of corpus.pairs) {
      expect(['part', 'not-part', 'uncertain']).toContain(p.label);
      if (p.known !== undefined) expect(p.known.trim()).not.toBe('');
    }
  });

  it('grades each pair with the scan\'s own grading: grade over wantedFor', () => {
    // A scan grades a search row with pick(wantedFor(brand, model, catalog), rows), which is grade()
    // per row; corpusGrade gives that grading the pair's part and row, nothing else.
    for (const p of corpus.pairs.filter((x) => !x.part.isKit)) {
      expect(corpusGrade(p)).toEqual(grade(wantedFor(p.part.brand, p.part.model, new Map()), { ...p.listing }));
    }
  });

  it('never grades a listing labelled not the part probable or better, and never rejects one labelled the part', () => {
    const failing = corpus.pairs.filter((p) => !p.known).flatMap((p) => {
      const why = pairProblem(p);
      return why ? [show(p, why)] : [];
    });
    expect(failing).toEqual([]);
  });

  it('still fails each known pair (a pair that passes now: remove its known mark)', () => {
    const fixed = corpus.pairs.filter((p) => p.known && pairProblem(p) === null).map((p) => show(p, `passes now; was known: ${p.known}`));
    expect(fixed).toEqual([]);
  });
});
