// Answer once, apply everywhere (Nov 23), on the owner's real questions: fixtures/e2e-2026-11-23/after-scan3 (its scan store
// and store/review.json) and, for the special buy, the readings his Chrome made on Nov 23 (settle-special-buy.test.ts).
// No network. Nothing here answers for him: every fact is one he gave.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { forgetFact, markNotSold, putFact, rememberAnswer } from '../src/facts/apply';
import { factsFromAnswer } from '../src/facts/fact';
import { applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { buildReport } from '../src/scan/report';
import { withdrawUnreadSplitQuestions } from '../src/scan/runner';
import { knownModels, readSplit } from '../src/scan/split';
import { bundleKey, DEFAULT_SCAN_SETTINGS, partKey, type BundleRecord, type PartPriceRecord, type ReviewItem } from '../src/scan/types';
import { SEARCHES } from './followup-world';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3');
const NOW = Date.UTC(2026, 10, 23, 20);
const A986501 = 'split:homedepot:320243671';
const A10FB1G = 'split:homedepot:334547201';

/** The owner's store after scan 3, with today's rules read over its open questions (as the next scan would). */
async function owner() {
  const store = await loadScanFolder(DIR);
  await withdrawUnreadSplitQuestions(store, NOW - 1000);
  return store;
}

/**
 * The owner's live data has bundles sharing a part he was asked about more than once; scan 3's store has one question per
 * such part. The second bundle here is the real PCL1600K2-A986501 record (item 320243671) listed under a second item id,
 * nothing else changed: the stand-in for "another bundle that holds A986501".
 */
async function withSecondListing(store: Awaited<ReturnType<typeof owner>>): Promise<string> {
  const real = (await store.getBundle(bundleKey('320243671')))!;
  const twin: BundleRecord = { ...structuredClone(real), itemId: '920243671', key: bundleKey('920243671'), split: null };
  await store.putBundle(twin);
  await withdrawUnreadSplitQuestions(store, NOW - 500);
  // Read as the scan reads a new bundle: the same question opens for it.
  const { splitOne } = await import('../src/scan/runner');
  await splitOne(store, twin, await knownModels(store), NOW - 400, true);
  return `split:${twin.key}`;
}

describe('the real question shapes', () => {
  it('scan 3 asks "What is A986501 in this bundle?" and "What is A10FB1G …?": each part not sold on its own, PCL1600K2 settled', async () => {
    const store = await owner();
    const open = (await store.listReview()).filter((q) => q.answer === null && q.kind === 'split');
    expect(open.map((q) => q.id).sort()).toEqual([
      'split:homedepot:320243671', 'split:homedepot:321809549', 'split:homedepot:321811428', 'split:homedepot:326894185',
      'split:homedepot:328690510', 'split:homedepot:334547201',
    ]);
    const q = (await store.getReview(A986501))!;
    expect(q.unsettledParts).toEqual([{ model: 'A986501', why: 'not_sold' }]);
    expect(q.settledParts?.map((p) => p.model)).toEqual(['PCL1600K2']);
    // The agent's copy of the questions (store/review.json) holds the same ids.
    const json = JSON.parse(readFileSync(join(DIR, 'store', 'review.json'), 'utf8')) as { questions: { id: string }[] };
    expect(json.questions.map((x) => x.id)).toEqual(expect.arrayContaining([A986501, A10FB1G]));
  });
});

describe('answer once', () => {
  it('approving PCL1600K2 + A986501 with "remember this for A986501" settles the other bundle that holds A986501', async () => {
    const store = await owner();
    const other = await withSecondListing(store);
    expect((await store.getReview(other))!.answer).toBeNull();

    const q = (await store.getReview(A986501))!;
    await applyReviewAnswer(store, A986501, { choice: 0, seen: reviewSignature(q) }, NOW);
    const answered = (await store.getReview(A986501))!;
    const out = await rememberAnswer(store, answered, ['A986501'], NOW);
    expect(out.facts).toEqual([{ field: 'isPart', brand: 'RYOBI', model: 'A986501', mark: { at: NOW, questionId: A986501, bundle: 'PCL1600K2-A986501' } }]);
    expect(out.settled).toEqual([other]);
    // The other bundle is split as he said, with the evidence and its date; its question is closed as a scan closes one.
    const b = (await store.getBundle(bundleKey('920243671')))!;
    expect(b.split).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'A986501'] });
    expect(b.split!.evidence).toContainEqual({ kind: 'owner_fact', model: 'A986501', text: 'A986501 is a part of the bundles that name it: your answer on Nov 23 (PCL1600K2-A986501).' });
    expect((await store.getReview(other))!.answer).toBe('resolved by a later scan');
    // The questions about other parts stay open: a fact settles only the part it is about.
    expect((await store.getReview(A10FB1G))!.answer).toBeNull();
    // A future bundle naming A986501 is settled when it is first read, never asked.
    const later: BundleRecord = { ...structuredClone(b), itemId: '930243671', key: bundleKey('930243671'), split: null };
    expect(readSplit(later, await knownModels(store)).status).toBe('resolved');
  });

  it('nothing is remembered without the tick, for None, or for leaving a part out of one bundle', async () => {
    const store = await owner();
    const q = (await store.getReview(A986501))!;
    await applyReviewAnswer(store, A986501, { parts: ['PCL1600K2'], seen: reviewSignature(q) }, NOW);
    const typed = (await store.getReview(A986501))!;
    expect(factsFromAnswer(typed, ['A986501'], NOW).facts).toEqual([]);
    expect(factsFromAnswer(typed, ['A986501'], NOW).skipped[0]!.why).toBe('Your parts leave A986501 out of this bundle, which says nothing about other bundles.');
    expect((await rememberAnswer(store, typed, [], NOW)).settled).toEqual([]);
    const none: ReviewItem = { ...typed, answer: 'none', answerParts: null };
    expect(factsFromAnswer(none, ['A986501'], NOW).facts).toEqual([]);
    expect(factsFromAnswer(typed, ['PCL1600K2'], NOW).skipped[0]!.why).toBe('This question did not ask what PCL1600K2 is.');
  });

  it('forgetting the fact ("Change") asks about the bundles it settled again, and never touches his own answer', async () => {
    const store = await owner();
    const other = await withSecondListing(store);
    const q = (await store.getReview(A986501))!;
    await applyReviewAnswer(store, A986501, { choice: 0, seen: reviewSignature(q) }, NOW);
    await rememberAnswer(store, (await store.getReview(A986501))!, ['A986501'], NOW);
    expect(await forgetFact(store, partKey('RYOBI', 'A986501'), null, NOW + 1)).toEqual([bundleKey('920243671')]);
    expect((await store.getReview(other))!.answer).toBeNull();
    expect((await store.getBundle(bundleKey('320243671')))!.split?.status).toBe('resolved');
    expect(await store.getPartFact(partKey('RYOBI', 'A986501'))).toBeUndefined();
  });

  it('a special buy he sells as its tools: PCL406424SB-A21701-A25RS51 resolves to his tools wherever it is asked', async () => {
    const store = await owner();
    // Home Depot's readings recorded in his Chrome on Nov 23 (settle-special-buy.test.ts): A21701 found, PCL406424SB a special buy, A25RS51 not sold.
    const reading = (model: string, query: string): PartPriceRecord => {
      const row = SEARCHES.get(query)!.results.find((r) => r.model === model);
      return row
        ? { key: partKey('RYOBI', model), brand: 'RYOBI', model, itemId: row.itemId, matchedModel: row.model, price: 1, title: row.title, link: row.url, seenAt: 1, checkedAt: 1 }
        : { key: partKey('RYOBI', model), brand: 'RYOBI', model, itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: 1 };
    };
    for (const [m, q] of [['PCL406424SB', 'ryobi pcl406424sb'], ['A21701', 'ryobi a21701'], ['A25RS51', 'ryobi a25rs51']] as const) await store.putPartPrice(reading(m, q));
    const bundle = (await store.getBundle('homedepot:335724135'))!;
    expect(readSplit(bundle, await knownModels(store)).unsettledParts?.map((u) => u.model)).toEqual(['PCL406424SB', 'A25RS51']);
    await putFact(store, 'RYOBI', 'PCL406424SB', 'sellAs', { at: NOW, bundle: 'PCL406424SB-A21701-A25RS51' }, ['PCL406B', 'PCL424B']);
    // Only one of the two asked parts settled: still a question, now about A25RS51 alone.
    const half = readSplit(bundle, await knownModels(store));
    expect(half.status).toBe('needs_review');
    expect(half.unsettledParts?.map((u) => u.model)).toEqual(['A25RS51']);
    await putFact(store, 'RYOBI', 'A25RS51', 'isPart', { at: NOW, bundle: 'PCL406424SB-A21701-A25RS51' });
    const whole = readSplit(bundle, await knownModels(store));
    expect(whole).toMatchObject({ status: 'resolved', components: ['PCL406B', 'PCL424B', 'A21701', 'A25RS51'] });
    // Sold whole instead: the special buy stays one part.
    await putFact(store, 'RYOBI', 'PCL406424SB', 'sellAs', { at: NOW + 1 }, null);
    expect(readSplit(bundle, await knownModels(store)).components).toEqual(['PCL406424SB', 'A21701', 'A25RS51']);
  });
});

describe('"in the box, not sold separately"', () => {
  it('A10FB1G: not counted, so PCL1200K2-A10FB1G is missing one price fewer; newer Home Depot evidence makes it ask again', async () => {
    const store = await owner();
    const before = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'PCL1200K2-A10FB1G')!;
    expect(before.incomplete!.unpriced.map((u) => u.model)).toEqual(['PCL206', 'A10FB1G']);
    await markNotSold(store, 'RYOBI', 'A10FB1G', NOW);
    const after = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'PCL1200K2-A10FB1G')!;
    expect(after.incomplete!.unpriced.map((u) => u.model)).toEqual(['PCL206']);
    expect(after.incomplete!.total).toBe(before.incomplete!.total - 1);
    const part = after.parts.find((p) => p.model === 'A10FB1G')!;
    expect(part.fact).toEqual({ text: 'In the box, not sold separately', at: NOW, notCounted: true });
    expect(part.priceSuggestion).toBeUndefined();
    // Home Depot later sells it alone: the fact is not applied, and the row says what changed.
    await store.putPartPrice({ key: partKey('RYOBI', 'A10FB1G'), brand: 'RYOBI', model: 'A10FB1G', itemId: '1', matchedModel: 'A10FB1G', price: 12.97, title: 'bit holder', link: 'https://www.homedepot.com/p/1', seenAt: NOW + 86_400_000 * 2, checkedAt: NOW + 86_400_000 * 2 });
    const later = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'PCL1200K2-A10FB1G')!;
    expect(later.incomplete!.unpriced.map((u) => u.model)).toEqual(['PCL206', 'A10FB1G']);
    expect(later.parts.find((p) => p.model === 'A10FB1G')!.fact).toEqual({ text: 'In the box, not sold separately', at: NOW, stale: 'Home Depot sells A10FB1G on its own since Nov 25 ($12.97).' });
    // He keeps his answer: a new date, newer than the evidence, and it applies again.
    await markNotSold(store, 'RYOBI', 'A10FB1G', NOW + 86_400_000 * 3);
    const kept = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'PCL1200K2-A10FB1G')!;
    expect(kept.incomplete!.unpriced.map((u) => u.model)).toEqual(['PCL206']);
  });
});
