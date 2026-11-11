import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { type PageContent, parseBundlePage } from '../src/hdPage';
import { AnswerRefused, applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type PageOutcome, type ReadPages, type ReviewAnswer, type ReviewItem, type ScanSettings } from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';
import { recorded } from './recorded';

// The owner's answers to review questions, and the scans that follow them. Every search goes
// through the real SerpApiClient and SearchBudget over the replay of fixtures/recorded/, and
// bundle pages are the recorded ones. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 10, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OPEN: BudgetPolicy = { reserve: 0, maxPerRun: 10 };
const ONE_SEARCH: BudgetPolicy = { reserve: 0, maxPerRun: 1 };
const NO_SEARCH: BudgetPolicy = { reserve: 0, maxPerRun: 0 };
const STEP2: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0 };
/** No Home Depot page and no brand page: only what the store holds is split. */
const DEWALT_ONLY: ScanSettings = { ...STEP2, brands: ['DEWALT'], queries: [] };
/** The recorded "dewalt 20v combo kit" page: 337440459, 337440461, 343992132 and 343992133. */
const COMBO: ScanSettings = { ...STEP2, brands: ['DEWALT'], queries: [{ q: 'dewalt 20v combo kit' }] };
/** The same, with the recorded DEWALT brand page first. */
const COMBO_CATALOG: ScanSettings = { ...COMBO, catalogPagesPerScan: 1 };

const CHOSEN = 'parts chosen by you';
const NONE_NOTE = 'you answered none of these';
const NOT_FOUND = 'That question was not found.';
const ANSWERED = 'That question was already answered.';
const NOT_SHOWN = 'Choose one of the answers shown.';
const CHANGED = 'That question changed. Choose again.';

interface World {
  store: MemoryScanStore;
  cache: MemoryCache;
  replay: Replay;
  clock: number;
  /** Ledger label of every search that counted against the quota. */
  ledger: string[];
}

const world = (): World => ({ store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), clock: T0, ledger: [] });

function scan(w: World, opts: { settings: ScanSettings; policy?: BudgetPolicy; readPages?: ReadPages; fetchFn?: typeof fetch }) {
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), opts.policy ?? OPEN);
  const client = new SerpApiClient({
    apiKey: 'TEST', budget, cache: w.cache, fetchFn: opts.fetchFn ?? w.replay.fetchFn, now: () => w.clock, onSpend: (e) => void w.ledger.push(e.label),
  });
  return runScan({ client, budget, store: w.store, settings: opts.settings, now: () => w.clock, readPages: opts.readPages });
}

const PAGES = (
  JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: { itemId: string; text: string }[];
  }
).pages;

function page(itemId: string): PageContent {
  const rec = PAGES.find((p) => p.itemId === itemId);
  const content = rec ? parseBundlePage(rec.text, itemId) : null;
  if (!content) throw new Error(`no readable recorded page ${itemId}`);
  return content;
}

/** Reads each bundle's recorded page; `as` reads an id as another item's page (the misfit case of page-split.test.ts). */
const reader = (as: Record<string, string> = {}): ReadPages => async (ids) =>
  ids.map((itemId): PageOutcome => ({ itemId, kind: 'read', content: page(Object.hasOwn(as, itemId) ? as[itemId]! : itemId) }));

const lookup = (model: string) => ({ kind: 'lookup', brand: 'DEWALT', model }) as const;

/** An answer as the panel sends it: signed with the question as stored now, which is what the panel shows. */
async function shown(w: World, id: string, pick: { choice: number } | { none: true }): Promise<ReviewAnswer> {
  const item = await w.store.getReview(id);
  return { ...pick, seen: item ? reviewSignature(item) : '[]' };
}

// ---------------------------------------------------------------- split questions

const AMBIGUOUS = 'split:homedepot:ambiguous';

/** The real bundle whose '1B' fits DCF891B and DCF921B (core/test/fixtures.ts), split once: its question has two choices. */
async function ambiguous(w: World): Promise<ReviewItem> {
  const [model, title] = fx.HD_DEWALT_AMBIGUOUS;
  await w.store.putBundle({
    key: 'homedepot:ambiguous', retailer: 'homedepot', itemId: 'ambiguous', title, brand: 'DEWALT', model,
    upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0, split: null,
  });
  for (const m of ['DCF891B', 'DCF921B']) {
    await w.store.putCatalogEntry({ key: `DEWALT:${m}`, brand: 'DEWALT', model: m, title: `${m} (seeded for this test)`, kinds: ['impact wrench'], isKit: false, upc: null, seenAt: T0 - DAY });
  }
  await scan(w, { settings: DEWALT_ONLY });
  const item = (await w.store.getReview(AMBIGUOUS))!;
  expect(item).toMatchObject({ answer: null, choices: [['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']] });
  return item;
}

describe('applyReviewAnswer: a split question', () => {
  it('a choice resolves the bundle with the parts chosen and closes the question', async () => {
    const w = world();
    const open = await ambiguous(w);
    await applyReviewAnswer(w.store, AMBIGUOUS, await shown(w, AMBIGUOUS, { choice: 1 }), T0 + MINUTE);
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual({ components: ['DCKTS650D1P1', 'DCF921B'], status: 'resolved', notes: [CHOSEN] });
    expect(await w.store.getReview(AMBIGUOUS)).toEqual({ ...open, answer: 'DCKTS650D1P1,DCF921B', answeredAt: T0 + MINUTE });
    const report = await buildReport(w.store, DEWALT_ONLY);
    expect(report.review).toEqual([]);
    // Nothing is matched yet: the bundle has left "Contents not known" for "missing listing".
    expect(report.bundles.map((b) => [b.model, b.section, b.parts.map((p) => p.model)])).toEqual([['DCKTS650D1P1W1B', 'missing_listing', ['DCKTS650D1P1', 'DCF921B']]]);
  });

  it('every later scan keeps the chosen split, and plans its parts like any resolved bundle\'s', async () => {
    const w = world();
    await ambiguous(w);
    await applyReviewAnswer(w.store, AMBIGUOUS, await shown(w, AMBIGUOUS, { choice: 1 }), T0 + MINUTE);
    const answered = await w.store.getReview(AMBIGUOUS);

    for (const day of [1, 2]) {
      w.clock = T0 + day * DAY;
      const job = await scan(w, { settings: DEWALT_ONLY, policy: NO_SEARCH });
      expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual({ components: ['DCKTS650D1P1', 'DCF921B'], status: 'resolved', notes: [CHOSEN] });
      expect(await w.store.getReview(AMBIGUOUS)).toEqual(answered);
      expect(job.counts).toMatchObject({ bundlesResolved: 1, reviewsOpened: 0 });
      // This budget allows no search, so both parts wait for their lookups.
      expect(job.deferred).toEqual([lookup('DCF921B'), lookup('DCKTS650D1P1')]);
    }
    expect(w.replay.calls).toEqual([]);
  });

  it('a chosen split stands instead of the model number and the page', async () => {
    const w = world();
    // 337440461 (DCK200D1P1WB606) read as 337440459's page: the model number says DCB606, the page DCF921B.
    await w.store.putCatalogEntry({ key: 'DEWALT:DCB606', brand: 'DEWALT', model: 'DCB606', title: 'DCB606 (seeded for this test)', kinds: ['battery'], isKit: false, upc: null, seenAt: T0 - DAY });
    await scan(w, { settings: COMBO, policy: ONE_SEARCH, readPages: reader({ '337440461': '337440459' }) });
    const id = 'split:homedepot:337440461';
    expect(await w.store.getReview(id)).toMatchObject({ answer: null, choices: [['DCK200D1P1', 'DCB606'], ['DCK200D1P1', 'DCF921B']] });

    // The owner takes the page's reading, which the model number contradicts.
    await applyReviewAnswer(w.store, id, await shown(w, id, { choice: 1 }), T0 + MINUTE);
    w.clock = T0 + DAY;
    const job = await scan(w, { settings: COMBO, policy: ONE_SEARCH, readPages: reader() });
    expect((await w.store.getBundle('homedepot:337440461'))!.split).toEqual({ components: ['DCK200D1P1', 'DCF921B'], status: 'resolved', notes: [CHOSEN] });
    expect(await w.store.getReview(id)).toMatchObject({ answer: 'DCK200D1P1,DCF921B', answeredAt: T0 + MINUTE });
    expect(job.counts).toMatchObject({ bundlesResolved: 4, reviewsOpened: 0 });
  });

  it('"none" leaves the bundle in Contents not known on every later scan, even one that would resolve it, and its question stays closed', async () => {
    const w = world();
    // No brand page: 343992133 (DCK540D1WCS334B) goes to review, with no reading to offer.
    await scan(w, { settings: COMBO });
    const id = 'split:homedepot:343992133';
    const open = (await w.store.getReview(id))!;
    expect(open).toMatchObject({ reason: "'CS334B' matches nothing in the catalog", choices: [], answer: null });
    const before = (await w.store.getBundle('homedepot:343992133'))!.split!;

    await applyReviewAnswer(w.store, id, await shown(w, id, { none: true }), T0 + MINUTE);
    const answered = { ...open, answer: 'none', answeredAt: T0 + MINUTE };
    expect(await w.store.getReview(id)).toEqual(answered);
    expect((await w.store.getBundle('homedepot:343992133'))!.split).toEqual({ ...before, notes: [...before.notes, NONE_NOTE] });

    // The DEWALT brand page saves DCS334B's listing, which resolves this bundle when nobody has answered (scan-runner, N1).
    w.clock = T0 + DAY;
    const job = await scan(w, { settings: COMBO_CATALOG });
    const split = (await w.store.getBundle('homedepot:343992133'))!.split!;
    expect(split).toMatchObject({ components: ['DCK540D1', 'DCS334B'], status: 'needs_review' });
    expect(split.notes.at(-1)).toBe(NONE_NOTE);
    expect(await w.store.getReview(id)).toEqual(answered);
    expect(job.counts.reviewsOpened).toBe(0);
    // Its bonus part is in no other bundle: it is never looked up or matched.
    expect(await w.store.getMatch('DEWALT:DCS334B')).toBeUndefined();
    const report = await buildReport(w.store, COMBO_CATALOG);
    expect(report.bundles.find((b) => b.model === 'DCK540D1WCS334B')).toMatchObject({ section: 'split', status: 'needs_review', parts: [] });
    expect(report.review.map((r) => r.id)).not.toContain(id);
  });

  it('accepts "none" for a question saved before choices existed, and refuses a choice', async () => {
    const w = world();
    const { choices, ...old } = await ambiguous(w);
    expect(choices).toHaveLength(2);
    await w.store.putReview(old as ReviewItem);
    await expect(applyReviewAnswer(w.store, AMBIGUOUS, await shown(w, AMBIGUOUS, { choice: 0 }), T0 + MINUTE)).rejects.toThrow(NOT_SHOWN);
    await applyReviewAnswer(w.store, AMBIGUOUS, await shown(w, AMBIGUOUS, { none: true }), T0 + MINUTE);
    expect(await w.store.getReview(AMBIGUOUS)).toEqual({ ...old, choices: [], answer: 'none', answeredAt: T0 + MINUTE });
  });
});

// ---------------------------------------------------------------- match questions

const MATCH = 'match:DEWALT:DCF891B';

/**
 * The bundle DCK940D2WCF891B and the recorded DCF891B search without its one confirmed listing
 * (as in scan-runner's rule 6 test): the part's question lists 7 unconfirmed listings.
 */
async function unconfirmed() {
  const w = world();
  const [model, title] = fx.HD_DEWALT_BUNDLES[0]!;
  await w.store.putBundle({
    key: 'homedepot:seeded', retailer: 'homedepot', itemId: 'seeded', title, brand: 'DEWALT', model,
    upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0, split: null,
  });
  await w.store.putCatalogEntry({
    key: 'DEWALT:DCF891B', brand: 'DEWALT', model: 'DCF891B', title: 'DCF891B (catalog entry seeded for this test)', kinds: ['impact wrench'], isKit: false, upc: null, seenAt: T0,
  });
  // The kit is not what this test is about: it was looked up before and nothing was found.
  await w.store.putMatch({ key: 'DEWALT:DCK940D2', brand: 'DEWALT', model: 'DCK940D2', status: 'none', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
  const data = recorded('amazon-search-DCF891B') as { organic_results: { asin: string }[] };
  const response = { ...data, organic_results: data.organic_results.filter((row) => row.asin !== 'B09YXXFPBJ') };
  const fetchFn = (async (input: string | URL | Request) =>
    String(input).includes('k=DEWALT+DCF891B') ? new Response(JSON.stringify(response), { status: 200 }) : w.replay.fetchFn(input)) as typeof fetch;
  await scan(w, { settings: DEWALT_ONLY, fetchFn });
  const item = (await w.store.getReview(MATCH))!;
  expect(item).toMatchObject({ kind: 'match', answer: null, choices: [] });
  expect(item.candidates).toHaveLength(7);
  expect(w.ledger).toEqual(['scan:lookup:DCF891B']);
  return { w, fetchFn, item };
}

const userMatch = (over: object) => ({
  key: 'DEWALT:DCF891B', brand: 'DEWALT', model: 'DCF891B', grade: null, alternatives: [], decidedBy: 'user', updatedAt: T0 + MINUTE, waitingSince: null, ...over,
});

describe('applyReviewAnswer: a match question', () => {
  it('a choice saves that listing as the user\'s match, and a later scan keeps it and looks nothing up', async () => {
    const { w, fetchFn, item } = await unconfirmed();
    await applyReviewAnswer(w.store, MATCH, await shown(w, MATCH, { choice: 0 }), T0 + MINUTE);
    const decided = userMatch({ status: 'matched', asin: 'B0HQGDLWH9' });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toEqual(decided);
    expect(await w.store.getReview(MATCH)).toEqual({ ...item, answer: 'B0HQGDLWH9', answeredAt: T0 + MINUTE });

    w.clock = T0 + 10 * MINUTE;
    const job = await scan(w, { settings: DEWALT_ONLY, fetchFn });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toEqual(decided);
    // The listing has no price yet, so it is refreshed, from the lookup's saved response: nothing is paid.
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 1, reviewsOpened: 0 });
    expect(w.ledger).toEqual(['scan:lookup:DCF891B']);
    expect(await w.store.getPrice('B0HQGDLWH9')).toMatchObject({ price: 100.83, seenAt: T0, checkedAt: T0 });
    expect((await buildReport(w.store, DEWALT_ONLY)).review).toEqual([]);
  });

  it('"none" saves that the part has no listing, decided by the user, and a later scan does not look it up', async () => {
    const { w, fetchFn, item } = await unconfirmed();
    await applyReviewAnswer(w.store, MATCH, await shown(w, MATCH, { none: true }), T0 + MINUTE);
    const decided = userMatch({ status: 'none', asin: null });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toEqual(decided);
    expect(await w.store.getReview(MATCH)).toEqual({ ...item, answer: 'none', answeredAt: T0 + MINUTE });

    w.clock = T0 + 10 * MINUTE;
    const job = await scan(w, { settings: DEWALT_ONLY, fetchFn });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toEqual(decided);
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 0, reviewsOpened: 0 });
    expect(w.ledger).toEqual(['scan:lookup:DCF891B']);
  });

  it('refuses a choice beyond the listings shown', async () => {
    const { w } = await unconfirmed();
    const before = await w.store.getMatch('DEWALT:DCF891B');
    await expect(applyReviewAnswer(w.store, MATCH, await shown(w, MATCH, { choice: 7 }), T0 + MINUTE)).rejects.toThrow(NOT_SHOWN);
    expect(await w.store.getMatch('DEWALT:DCF891B')).toEqual(before);
    expect((await w.store.getReview(MATCH))!.answer).toBeNull();
  });
});

// ---------------------------------------------------------------- refusals

describe('applyReviewAnswer: refusals', () => {
  it('refuses an unknown question, an answered one and an answer not shown, each with a plain sentence, and changes nothing', async () => {
    const w = world();
    await ambiguous(w);
    const snapshot = async () => ({ bundles: await w.store.listBundles(), review: await w.store.listReview(), matches: await w.store.listMatches() });
    const before = await snapshot();

    const unknown = applyReviewAnswer(w.store, 'split:homedepot:nothing', { none: true, seen: '[]' }, T0 + MINUTE);
    await expect(unknown).rejects.toBeInstanceOf(AnswerRefused);
    await expect(unknown).rejects.toThrow(NOT_FOUND);
    const seen = reviewSignature((await w.store.getReview(AMBIGUOUS))!);
    const notShown = [
      ...[{ choice: 2 }, { choice: -1 }, { choice: 0.5 }, { choice: '0' }, {}, { none: false }, { none: true, choice: 0 }].map((a) => ({ ...a, seen })),
      // No signature, or one that is not text: not an answer the panel sends.
      { choice: 0 }, { none: true }, { choice: 0, seen: 7 }, null, 'none',
    ];
    for (const answer of notShown) {
      await expect(applyReviewAnswer(w.store, AMBIGUOUS, answer as ReviewAnswer, T0 + MINUTE), JSON.stringify(answer)).rejects.toThrow(NOT_SHOWN);
    }
    expect(await snapshot()).toEqual(before);

    await applyReviewAnswer(w.store, AMBIGUOUS, await shown(w, AMBIGUOUS, { choice: 0 }), T0 + MINUTE);
    const answered = await snapshot();
    await expect(applyReviewAnswer(w.store, AMBIGUOUS, await shown(w, AMBIGUOUS, { choice: 1 }), T0 + 2 * MINUTE)).rejects.toThrow(ANSWERED);
    await expect(applyReviewAnswer(w.store, AMBIGUOUS, await shown(w, AMBIGUOUS, { none: true }), T0 + 2 * MINUTE)).rejects.toThrow(ANSWERED);
    expect(await snapshot()).toEqual(answered);
  });

  it('refuses a question a scan closed itself', async () => {
    const w = world();
    // Without pages 337440459 goes to review; read with its page a day later, it resolves and its question is closed.
    await scan(w, { settings: COMBO });
    w.clock = T0 + DAY;
    await scan(w, { settings: COMBO, policy: ONE_SEARCH, readPages: reader() });
    const id = 'split:homedepot:337440459';
    expect(await w.store.getReview(id)).toMatchObject({ answer: 'resolved by a later scan' });
    await expect(applyReviewAnswer(w.store, id, await shown(w, id, { none: true }), T0 + DAY + MINUTE)).rejects.toThrow(ANSWERED);
    expect(await w.store.getReview(id)).toMatchObject({ answer: 'resolved by a later scan', answeredAt: T0 + DAY });
  });
});

describe('applyReviewAnswer: an answer to a question as it was shown', () => {
  const id = 'split:homedepot:337440461';

  /** 337440461's question as first shown (no reading), then rewritten by a scan that reads 337440459's page for it. */
  async function rewritten(w: World): Promise<{ old: string; now: string }> {
    await scan(w, { settings: COMBO });
    const first = (await w.store.getReview(id))!;
    expect(first.choices).toEqual([]);
    w.clock = T0 + DAY;
    await scan(w, { settings: COMBO, policy: ONE_SEARCH, readPages: reader({ '337440461': '337440459' }) });
    const second = (await w.store.getReview(id))!;
    expect(second).toMatchObject({ answer: null, openedAt: T0, choices: [['DCK200D1P1', 'DCF921B']] });
    expect(reviewSignature(second)).not.toBe(reviewSignature(first));
    return { old: reviewSignature(first), now: reviewSignature(second) };
  }

  const snapshot = async (w: World) => ({ bundles: await w.store.listBundles(), review: await w.store.listReview(), matches: await w.store.listMatches() });

  it('signs a split question with its choices and a match question with its listings', async () => {
    const w = world();
    await ambiguous(w);
    expect(reviewSignature((await w.store.getReview(AMBIGUOUS))!)).toBe('[["DCKTS650D1P1","DCF891B"],["DCKTS650D1P1","DCF921B"]]');
    const { w: m, item } = await unconfirmed();
    expect(reviewSignature((await m.store.getReview(MATCH))!)).toBe(JSON.stringify(item.candidates.map((c) => c.asin)));
  });

  it('refuses a choice made on the question before a scan rewrote its choices, and writes nothing', async () => {
    const w = world();
    const { old } = await rewritten(w);
    const before = await snapshot(w);
    const stale = applyReviewAnswer(w.store, id, { choice: 0, seen: old }, T0 + DAY + MINUTE);
    await expect(stale).rejects.toBeInstanceOf(AnswerRefused);
    await expect(stale).rejects.toThrow(CHANGED);
    expect(await snapshot(w)).toEqual(before);
  });

  it('refuses "none" given to the question before it was rewritten, and writes nothing', async () => {
    const w = world();
    const { old } = await rewritten(w);
    const before = await snapshot(w);
    await expect(applyReviewAnswer(w.store, id, { none: true, seen: old }, T0 + DAY + MINUTE)).rejects.toThrow(CHANGED);
    expect(await snapshot(w)).toEqual(before);
  });

  it('accepts the same choice made on the question as it is now', async () => {
    const w = world();
    const { now } = await rewritten(w);
    await applyReviewAnswer(w.store, id, { choice: 0, seen: now }, T0 + DAY + MINUTE);
    expect((await w.store.getBundle('homedepot:337440461'))!.split).toEqual({ components: ['DCK200D1P1', 'DCF921B'], status: 'resolved', notes: [CHOSEN] });
    expect(await w.store.getReview(id)).toMatchObject({ answer: 'DCK200D1P1,DCF921B', answeredAt: T0 + DAY + MINUTE });
  });

  it('refuses a match answer made on other listings', async () => {
    const { w, item } = await unconfirmed();
    const before = await snapshot(w);
    const other = JSON.stringify(item.candidates.slice(1).map((c) => c.asin));
    await expect(applyReviewAnswer(w.store, MATCH, { choice: 0, seen: other }, T0 + MINUTE)).rejects.toThrow(CHANGED);
    expect(await snapshot(w)).toEqual(before);
  });
});
