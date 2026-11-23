import { describe, expect, it } from 'vitest';

import { BRAND_NOT_CONFIRMED } from '../src/match';
import { identityFromKeepa } from '../src/keepa/verify';
import { applyCatalogCheck, catalogChecksWanted, catalogSentence } from '../src/scan/catalogCheck';
import { RESOLVED_BY_SCAN } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import type { MatchRecord, ReviewItem } from '../src/scan/types';
import { recordedKeepaProducts, replayCatalog, replayLines } from '../../scripts/replay-catalog';

// The catalog check applied to the store (core/src/scan/catalogCheck.ts), with the Keepa products recorded in
// fixtures/keepa/ and the owner's third real scan (fixtures/e2e-2026-11-23/after-scan3). No network.

const keepa = recordedKeepaProducts();
const identity = (asin: string) => identityFromKeepa(keepa.get(asin)!);
const T = Date.UTC(2026, 10, 23, 18);
const ctx = (store: MemoryScanStore) => ({ store, catalog: new Map(), now: () => T });

const titleMatch = (model: string, asin: string, alternatives: string[] = []): MatchRecord => ({
  key: `RYOBI:${model}`, brand: 'RYOBI', model, status: 'matched', asin, grade: 'probable', alternatives, decidedBy: 'auto', updatedAt: 1, waitingSince: null,
});

const question = (model: string, asins: string[]): ReviewItem => ({
  id: `match:RYOBI:${model}`, kind: 'match', subject: `RYOBI:${model}`, brand: 'RYOBI', model, title: null,
  reason: `${asins.length} listing(s) show the model number, but the brand is not confirmed`,
  candidates: asins.map((asin) => ({ asin, title: keepa.get(asin)!.title!, price: null, reviews: null, reasons: [BRAND_NOT_CONFIRMED], seenAt: 1 })),
  choices: [], openedAt: 1, answer: null, answeredAt: null,
});

async function inReview(model: string, asins: string[]): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  await store.putMatch({ ...titleMatch(model, ''), status: 'review', asin: null, grade: null });
  await store.putReview(question(model, asins));
  return store;
}

describe('a title match', () => {
  it('is verified from the catalog: strong, keepa_catalog, the evidence with the listing link (B0BGYFTPGK for PCL235)', async () => {
    const store = new MemoryScanStore();
    await store.putMatch(titleMatch('PCL235', 'B0BGYFTPGK'));
    const out = await applyCatalogCheck(ctx(store), identity('B0BGYFTPGK'));
    expect(out).toEqual([{ key: 'RYOBI:PCL235', asin: 'B0BGYFTPGK', status: 'confirmed', reason: "Amazon's catalog lists brand RYOBI, part number PCL235B", change: 'verified' }]);
    expect(await store.getMatch('RYOBI:PCL235')).toMatchObject({
      status: 'matched', asin: 'B0BGYFTPGK', grade: 'strong', source: 'page', verifiedBy: 'keepa_catalog',
      verifyEvidence: "Amazon's catalog lists brand RYOBI, part number PCL235B: https://www.amazon.com/dp/B0BGYFTPGK",
    });
  });

  it('on a listing of another brand is removed: the part has no listing, with the reason (B0HFS4PFLN, a Tourmate case)', async () => {
    const store = new MemoryScanStore();
    await store.putMatch(titleMatch('PCL235B', 'B0HFS4PFLN'));
    const [o] = await applyCatalogCheck(ctx(store), identity('B0HFS4PFLN'));
    expect(o).toMatchObject({ status: 'contradicted', change: 'removed' });
    expect(await store.getMatch('RYOBI:PCL235B')).toMatchObject({
      status: 'none', asin: null, grade: null, rejectedAsins: ['B0HFS4PFLN'],
      verifyEvidence: "Amazon's catalog lists brand Tourmate, not RYOBI: https://www.amazon.com/dp/B0HFS4PFLN",
    });
  });

  it('removed with an alternative of the same grade, moves to it, still a title match to check', async () => {
    const store = new MemoryScanStore();
    await store.putMatch(titleMatch('PCL235B', 'B0HL8FNQB5', ['B0BGYFTPGK']));
    await applyCatalogCheck(ctx(store), identity('B0HL8FNQB5'));
    expect(await store.getMatch('RYOBI:PCL235B')).toMatchObject({ status: 'matched', asin: 'B0BGYFTPGK', grade: 'probable', alternatives: [], rejectedAsins: ['B0HL8FNQB5'] });
    expect((await catalogChecksWanted(store, new Map([['RYOBI:PCL235B', { saving: 0 }]]))).map((t) => t.asin)).toEqual(['B0BGYFTPGK']);
  });

  it('unknown keeps the match and is remembered, so it is not pulled again (B0BL8BC8MF: FIRE ROSE, made by Ryobi)', async () => {
    const store = new MemoryScanStore();
    await store.putMatch(titleMatch('PCL265B', 'B0BL8BC8MF'));
    const parts = new Map([['RYOBI:PCL265B', { saving: 10 }]]);
    expect(await catalogChecksWanted(store, parts)).toHaveLength(1);
    const [o] = await applyCatalogCheck(ctx(store), identity('B0BL8BC8MF'));
    expect(o).toMatchObject({ status: 'unknown', change: 'kept' });
    expect(await store.getMatch('RYOBI:PCL265B')).toMatchObject({ status: 'matched', grade: 'probable', asin: 'B0BL8BC8MF' });
    expect(await catalogChecksWanted(store, parts)).toEqual([]);
  });

  it("the owner's choice is never checked or changed", async () => {
    const store = new MemoryScanStore();
    await store.putMatch({ ...titleMatch('PCL235B', 'B0HFS4PFLN'), decidedBy: 'user' });
    expect(await applyCatalogCheck(ctx(store), identity('B0HFS4PFLN'))).toEqual([]);
    expect(await catalogChecksWanted(store, new Map([['RYOBI:PCL235B', { saving: 0 }]]))).toEqual([]);
  });
});

describe('a match question whose brand was not confirmed', () => {
  it('is withdrawn when the catalog confirms a listing it offers: the part is matched to it, verified', async () => {
    const store = await inReview('PCL235B', ['B0HL8FNQB5', 'B0BGYFTPGK']);
    expect((await catalogChecksWanted(store, new Map([['RYOBI:PCL235B', { saving: 0 }]]))).map((t) => [t.asin, t.holds])).toEqual([
      ['B0HL8FNQB5', 'question'], ['B0BGYFTPGK', 'question'],
    ]);
    await applyCatalogCheck(ctx(store), identity('B0BGYFTPGK'));
    expect(await store.getMatch('RYOBI:PCL235B')).toMatchObject({ status: 'matched', asin: 'B0BGYFTPGK', grade: 'strong', verifiedBy: 'keepa_catalog' });
    expect(await store.getReview('match:RYOBI:PCL235B')).toMatchObject({ answer: RESOLVED_BY_SCAN });
  });

  it('stops offering a listing of another brand, and with none left is withdrawn and the part has no listing', async () => {
    const store = await inReview('PCL235B', ['B0HL8FNQB5', 'B0HFS4PFLN']);
    await applyCatalogCheck(ctx(store), identity('B0HL8FNQB5'));
    expect((await store.getReview('match:RYOBI:PCL235B'))!.candidates.map((c) => c.asin)).toEqual(['B0HFS4PFLN']);
    expect((await store.getMatch('RYOBI:PCL235B'))!.status).toBe('review');
    await applyCatalogCheck(ctx(store), identity('B0HFS4PFLN'));
    expect(await store.getReview('match:RYOBI:PCL235B')).toMatchObject({ answer: RESOLVED_BY_SCAN, candidates: [] });
    expect(await store.getMatch('RYOBI:PCL235B')).toMatchObject({ status: 'none', rejectedAsins: ['B0HL8FNQB5', 'B0HFS4PFLN'] });
  });
});

describe('the Activity sentence', () => {
  it('says what was verified and what was removed', () => {
    expect(catalogSentence(6, 1)).toBe("Verified 6 listings from Amazon's catalog; 1 did not match and was removed.");
    expect(catalogSentence(1, 0)).toBe("Verified 1 listing from Amazon's catalog.");
    expect(catalogSentence(0, 2)).toBe("Verified 0 listings from Amazon's catalog; 2 did not match and were removed.");
    expect(catalogSentence(0, 0)).toBeNull();
  });
});

describe('replayed on the owner\'s third scan (scripts/replay-catalog.ts)', () => {
  it('29 title matches and 3 questions to check; the recorded pulls verify 3 matches; every question needs a live pull', async () => {
    const lines = await replayCatalog();
    const text = replayLines(lines);
    expect(text.slice(-3)).toEqual([
      'Title matches: 29 listings to check; 3 settled from recorded fields, 26 need a live pull.',
      'Match questions: 3 (DEWALT:DCF860B, DEWALT:DCH172B, RYOBI:A98401), 4 listings; 0 settled from recorded fields, 4 need a live pull.',
      'Cost: 1 Keepa token per listing, 33 for all of them.',
    ]);
    const verified = lines.flatMap((l) => (l.outcomes ?? []).filter((o) => o.change === 'verified').map((o) => `${o.key} ${o.asin}`));
    expect(verified.sort()).toEqual(['DEWALT:DCB606 B01H9BL8EO', 'DEWALT:DCF921B B09M3TL9BB', 'RYOBI:PCL235 B0BGYFTPGK']);
  });

  it('DCK540D1 on B0GQ6QKPWF needs a live pull, and its saved title already keeps it from being verified', async () => {
    const line = (await replayCatalog()).find((l) => l.target.model === 'DCK540D1')!;
    expect(line.outcomes).toBeNull();
    expect(line.ampHours).toBe('title says 5Ah, but in DCK540D1 D is 2.0Ah');
  });
});
