import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { type PageContent, parseBundlePage } from '../src/hdPage';
import { AnswerRefused, applyReviewAnswer, reopenReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { wantedFor } from '../src/scan/classify';
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
    expect(await w.store.getReview(AMBIGUOUS)).toEqual({ ...open, answer: 'DCKTS650D1P1,DCF921B', answerParts: ['DCKTS650D1P1', 'DCF921B'], answeredAt: T0 + MINUTE });
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
    const answered = { ...open, answer: 'none', answerParts: null, answeredAt: T0 + MINUTE };
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
    expect(await w.store.getReview(AMBIGUOUS)).toEqual({ ...old, choices: [], answer: 'none', answerParts: null, answeredAt: T0 + MINUTE });
  });
});

describe('a split question offers the reading a RYOBI model number spells out (Ruling 29)', () => {
  /** The recorded "ryobi 18v combo kit" page: eleven hyphen bundles and special buys, none resolved by the model number. */
  const RYOBI_COMBO: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
  /** No Home Depot page and no brand page: only what the store holds is split. */
  const RYOBI_ONLY: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [] };
  /** Reads the recorded page of each bundle that has one; the others are unreadable, as a page with no data is. */
  const recordedPages: ReadPages = async (ids) => ids.map((itemId): PageOutcome => {
    const rec = PAGES.find((p) => p.itemId === itemId);
    const content = rec ? parseBundlePage(rec.text, itemId) : null;
    return content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' };
  });
  const P553 = 'split:homedepot:320243741';
  const HYPHEN = 'hyphen split, but a part is not in the catalog';

  it('PCL1600K2-P553 from the recorded search offers PCL1600K2 + P553, with or without its page, which names no models', async () => {
    for (const readPages of [undefined, recordedPages]) {
      const w = world();
      await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH, readPages });
      expect(w.ledger).toEqual(['scan:listing:ryobi 18v combo kit:p1']);
      expect(await w.store.getReview(P553)).toMatchObject({
        model: 'PCL1600K2-P553', reason: readPages ? `${HYPHEN}; page names no models` : HYPHEN, answer: null, choices: [['PCL1600K2', 'P553']],
      });
      expect((await w.store.getBundle('homedepot:320243741'))!.split).toMatchObject({ components: ['PCL1600K2', 'P553'], status: 'needs_review' });
      // An accessory part is offered as the model number writes it.
      expect(await w.store.getReview('split:homedepot:345178210')).toMatchObject({ model: 'PCL1600K2-A983002', choices: [['PCL1600K2', 'A983002']] });
    }
  });

  it('PBLRC2501SB with an empty catalog offers its expansion; read with its page, it resolves and no question remains', async () => {
    const seed = async (w: World) => w.store.putBundle({
      key: 'homedepot:328814689', retailer: 'homedepot', itemId: fx.HD_BUNDLE.productID, title: fx.HD_BUNDLE.title, brand: 'RYOBI', model: fx.HD_BUNDLE.model,
      upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0, split: null,
    });
    const bare = world();
    await seed(bare);
    await scan(bare, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect(await bare.store.listCatalog()).toEqual([]);
    expect(await bare.store.getReview('split:homedepot:328814689')).toMatchObject({
      reason: 'special-buy pattern, parts not in catalog', answer: null, choices: [['PBLRC25B', 'PBLRC01B']],
    });

    const read = world();
    await seed(read);
    const job = await scan(read, { settings: RYOBI_ONLY, policy: NO_SEARCH, readPages: reader() });
    expect((await read.store.getBundle('homedepot:328814689'))!.split).toMatchObject({ status: 'resolved', notes: ['split read from the page'] });
    expect(await read.store.getReview('split:homedepot:328814689')).toBeUndefined();
    expect(job.counts.reviewsOpened).toBe(0);
  });

  it('an open question stored before this change gains the choice on the next scan, and keeps when it was opened', async () => {
    const w = world();
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    const now = (await w.store.getReview(P553))!;
    // As the question was stored before Ruling 29: no choices.
    await w.store.putReview({ ...now, choices: [] });

    w.clock = T0 + DAY;
    const job = await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    expect(await w.store.getReview(P553)).toEqual({ ...now, choices: [['PCL1600K2', 'P553']], openedAt: T0, answer: null });
    expect(job.counts.reviewsOpened).toBe(0);
  });

  it('answering it resolves the bundle to those parts; a later scan keeps them and plans their lookups', async () => {
    const w = world();
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    await applyReviewAnswer(w.store, P553, await shown(w, P553, { choice: 0 }), T0 + MINUTE);
    const chosen = { components: ['PCL1600K2', 'P553'], status: 'resolved', notes: [CHOSEN] };
    expect((await w.store.getBundle('homedepot:320243741'))!.split).toEqual(chosen);
    const answered = (await w.store.getReview(P553))!;
    expect(answered).toMatchObject({ answer: 'PCL1600K2,P553', answeredAt: T0 + MINUTE });

    w.clock = T0 + DAY;
    // Its page, read now, names no models; the owner's answer stands whatever the readings say.
    const job = await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH, readPages: recordedPages });
    expect((await w.store.getBundle('homedepot:320243741'))!.page).toBeTruthy();
    expect((await w.store.getBundle('homedepot:320243741'))!.split).toEqual(chosen);
    expect(await w.store.getReview(P553)).toEqual(answered);
    expect(job.counts).toMatchObject({ bundlesResolved: 1, reviewsOpened: 0 });
    // This budget allows no search, so both parts wait for their lookups.
    expect(job.deferred).toEqual([{ kind: 'lookup', brand: 'RYOBI', model: 'P553' }, { kind: 'lookup', brand: 'RYOBI', model: 'PCL1600K2' }]);
    expect(w.ledger).toEqual(['scan:listing:ryobi 18v combo kit:p1']);
  });

  it('a DEWALT short code that matches nothing still offers no choice: its kit alone is not a whole reading', async () => {
    const w = world();
    await scan(w, { settings: COMBO });
    const nothing = (await w.store.listReview()).filter((r) => r.kind === 'split' && r.reason.endsWith('matches nothing in the catalog'));
    expect(nothing.map((r) => r.model)).toContain('DCK540D1WCS334B');
    for (const r of nothing) expect(r.choices, r.model).toEqual([]);
  });
});

describe('applyReviewAnswer: the owner types the parts of a split question (owner\'s decision, Nov 11)', () => {
  /** The recorded "ryobi 18v combo kit" page: PCL500525SB (328690510) is on it, a special buy with no split rule. */
  const RYOBI_COMBO: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
  const RYOBI_ONLY: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [] };
  const recordedPages: ReadPages = async (ids) => ids.map((itemId): PageOutcome => {
    const rec = PAGES.find((p) => p.itemId === itemId);
    const content = rec ? parseBundlePage(rec.text, itemId) : null;
    return content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' };
  });
  const SB = 'split:homedepot:328690510';
  const SB_KEY = 'homedepot:328690510';
  const ENTERED = 'parts entered by you';
  const INVALID = 'Enter model numbers like PCL500B, separated by commas.';
  const NOT_FOR_MATCH = 'Parts can be entered only for a question about what a bundle contains.';
  const SELF = 'Enter the parts inside the bundle, not the bundle\'s own model number.';
  const typed = { components: ['PCL500B', 'PCL526B'], status: 'resolved', notes: [ENTERED] };

  /** PCL500525SB from the recorded search: its question offers no reading, only "None of these". */
  async function special(w: World): Promise<ReviewItem> {
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    const item = (await w.store.getReview(SB))!;
    expect(item).toMatchObject({ model: 'PCL500525SB', reason: 'no known RYOBI bundle pattern', choices: [], answer: null });
    expect((await w.store.getBundle(SB_KEY))!.split).toMatchObject({ status: 'needs_review' });
    return item;
  }

  const snapshot = async (w: World) => ({ bundles: await w.store.listBundles(), review: await w.store.listReview(), matches: await w.store.listMatches() });

  it('PCL500525SB answered with PCL500B, PCL526B resolves to those parts, noted as entered by the owner', async () => {
    const w = world();
    const open = await special(w);
    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B'], seen: reviewSignature(open) }, T0 + MINUTE);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual(typed);
    expect(await w.store.getReview(SB)).toEqual({ ...open, answer: 'PCL500B,PCL526B', answerParts: ['PCL500B', 'PCL526B'], answeredAt: T0 + MINUTE });
    const report = await buildReport(w.store, RYOBI_COMBO);
    expect(report.review.map((r) => r.id)).not.toContain(SB);
    // Its parts were never looked up: the bundle waits for those lookups.
    expect(report.bundles.find((b) => b.key === SB_KEY)).toMatchObject({ section: 'waiting', estimate: null, parts: [{ model: 'PCL500B', status: 'unmatched' }, { model: 'PCL526B', status: 'unmatched' }] });
  });

  it('upper-cases and trims the parts typed', async () => {
    const w = world();
    const open = await special(w);
    await applyReviewAnswer(w.store, SB, { parts: [' pcl500b ', 'Pcl526B '], seen: reviewSignature(open) }, T0 + MINUTE);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual(typed);
    expect(await w.store.getReview(SB)).toMatchObject({ answer: 'PCL500B,PCL526B', answerParts: ['PCL500B', 'PCL526B'] });
  });

  it('keeps a part typed twice: the bundle holds two of it, and the report counts qty 2', async () => {
    const w = world();
    const open = await special(w);
    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'pcl526b', ' PCL526B'], seen: reviewSignature(open) }, T0 + MINUTE);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual({ ...typed, components: ['PCL500B', 'PCL526B', 'PCL526B'] });
    expect(await w.store.getReview(SB)).toMatchObject({ answer: 'PCL500B,PCL526B,PCL526B', answerParts: ['PCL500B', 'PCL526B', 'PCL526B'] });
    const row = (await buildReport(w.store, RYOBI_COMBO)).bundles.find((b) => b.key === SB_KEY)!;
    expect(row.parts.map((p) => [p.model, p.qty])).toEqual([['PCL500B', 1], ['PCL526B', 2]]);
    // A later scan keeps the repeat.
    w.clock = T0 + DAY;
    await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect((await w.store.getBundle(SB_KEY))!.split!.components).toEqual(['PCL500B', 'PCL526B', 'PCL526B']);
  });

  it('survives later scans, which plan lookups for its parts', async () => {
    const w = world();
    const open = await special(w);
    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B'], seen: reviewSignature(open) }, T0 + MINUTE);
    const answered = await w.store.getReview(SB);

    for (const day of [1, 2]) {
      w.clock = T0 + day * DAY;
      // The page is read on the first of these scans; the owner's entry stands whatever it says.
      const job = await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH, readPages: recordedPages });
      expect((await w.store.getBundle(SB_KEY))!.split).toEqual(typed);
      expect(await w.store.getReview(SB)).toEqual(answered);
      expect(job.counts.reviewsOpened).toBe(0);
      // This budget allows no search, so both parts wait for their lookups.
      expect(job.deferred.filter((s) => s.kind === 'lookup' && s.model.startsWith('PCL5'))).toEqual([
        { kind: 'lookup', brand: 'RYOBI', model: 'PCL500B' },
        { kind: 'lookup', brand: 'RYOBI', model: 'PCL526B' },
      ]);
    }
    expect((await w.store.getBundle(SB_KEY))!.page).toBeTruthy();
    expect(await w.store.getMatch('RYOBI:PCL500B')).toMatchObject({ status: 'waiting' });
    expect(w.ledger).toEqual(['scan:listing:ryobi 18v combo kit:p1']);
  });

  it('refuses an entry that is not 1 to 8 model numbers, with one plain sentence, and writes nothing', async () => {
    const w = world();
    const open = await special(w);
    const seen = reviewSignature(open);
    const before = await snapshot(w);
    const nine = ['PCL500B', 'PCL526B', 'PCL515B', 'PCL430B', 'P553', 'PBP003', 'PBP004', 'A983002', 'PBLRC25B'];
    const invalid: unknown[] = [
      [], [''], ['  '], ['KIT'], ['PCL500B', '-2'], ['PCL500B', '18V'], ['PCL500B', 'V2'], ['PCL500B, PCL526B'], ['2PK'], nine,
      // Nine entries, one a repeat: the limit counts entries.
      [...nine.slice(0, 8), 'pcl500b'],
      'PCL500B, PCL526B', null, {}, [5], ['PCL500B', null],
    ];
    for (const parts of invalid) {
      const refused = applyReviewAnswer(w.store, SB, { parts, seen } as unknown as ReviewAnswer, T0 + MINUTE);
      await expect(refused, JSON.stringify(parts)).rejects.toBeInstanceOf(AnswerRefused);
      await expect(applyReviewAnswer(w.store, SB, { parts, seen } as unknown as ReviewAnswer, T0 + MINUTE), JSON.stringify(parts)).rejects.toThrow(INVALID);
    }
    // Typed parts with a choice or "none" as well is not an answer the panel sends.
    for (const answer of [{ parts: ['PCL500B'], choice: 0, seen }, { parts: ['PCL500B'], none: true, seen }]) {
      await expect(applyReviewAnswer(w.store, SB, answer as unknown as ReviewAnswer, T0 + MINUTE)).rejects.toThrow(NOT_SHOWN);
    }
    expect(await snapshot(w)).toEqual(before);
    // Eight entries, one of them typed twice, is fine.
    await applyReviewAnswer(w.store, SB, { parts: [...nine.slice(0, 7), 'pcl500b'], seen }, T0 + MINUTE);
    expect((await w.store.getBundle(SB_KEY))!.split!.components).toEqual([...nine.slice(0, 7), 'PCL500B']);
  });

  it('refuses the bundle\'s own model number as one of its parts, and writes nothing (Ruling 43)', async () => {
    const w = world();
    const open = await special(w);
    const seen = reviewSignature(open);
    const before = await snapshot(w);
    for (const parts of [['PCL500525SB'], [' pcl500525sb '], ['PCL500B', 'PCL500525SB']]) {
      const refused = applyReviewAnswer(w.store, SB, { parts, seen }, T0 + MINUTE);
      await expect(refused, JSON.stringify(parts)).rejects.toBeInstanceOf(AnswerRefused);
      await expect(applyReviewAnswer(w.store, SB, { parts, seen }, T0 + MINUTE), JSON.stringify(parts)).rejects.toThrow(SELF);
    }
    expect(await snapshot(w)).toEqual(before);
    expect((await w.store.getReview(SB))!.answer).toBeNull();
  });

  it('refuses a hyphen bundle\'s own model number typed with or without its hyphen, typed or stored (Ruling 43)', async () => {
    const P553 = 'split:homedepot:320243741';
    const w = world();
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    const open = (await w.store.getReview(P553))!;
    expect(open.model).toBe('PCL1600K2-P553');
    const before = await snapshot(w);
    for (const parts of [['PCL1600K2P553'], ['pcl1600k2p553 '], ['P553', 'PCL1600K2P553']]) {
      await expect(applyReviewAnswer(w.store, P553, { parts, seen: reviewSignature(open) }, T0 + MINUTE), JSON.stringify(parts)).rejects.toThrow(SELF);
    }
    expect(await snapshot(w)).toEqual(before);

    // Typed with its hyphen, which the format rule alone refuses, it still gets this sentence (QA 3, N2).
    const PBP003 = 'split:homedepot:341644756';
    const own = (await w.store.getReview(PBP003))!;
    expect(own.model).toBe('PCL1600K2-PBP003');
    for (const parts of [['PCL1600K2-PBP003'], [' pcl1600k2-pbp003'], ['PCL1600K2', 'PCL1600K2-PBP003']]) {
      await expect(applyReviewAnswer(w.store, PBP003, { parts, seen: reviewSignature(own) }, T0 + MINUTE), JSON.stringify(parts)).rejects.toThrow(SELF);
    }
    expect(await snapshot(w)).toEqual(before);

    // Stored, it decides nothing: the question stays as stored and the bundle as the model number reads it.
    const stored = { ...open, answer: 'PCL1600K2P553', answerParts: ['PCL1600K2P553'], answeredAt: T0 + MINUTE };
    await w.store.putReview(stored);
    w.clock = T0 + DAY;
    await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect((await w.store.getBundle('homedepot:320243741'))!.split).toMatchObject({ components: ['PCL1600K2', 'P553'], status: 'needs_review' });
    expect(await w.store.getReview(P553)).toEqual(stored);
  });

  it('stored parts holding the bundle\'s own model number are ignored by later scans (Ruling 43)', async () => {
    const w = world();
    const open = await special(w);
    const stored = { ...open, answer: 'PCL500525SB', answerParts: ['PCL500525SB'], answeredAt: T0 + MINUTE };
    await w.store.putReview(stored);
    w.clock = T0 + DAY;
    await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect((await w.store.getBundle(SB_KEY))!.split).toMatchObject({ status: 'needs_review', notes: ['no known RYOBI bundle pattern'] });
    expect(await w.store.getReview(SB)).toEqual(stored);
  });

  it('a DEWALT battery pack may be typed as the splitter writes it, DCB205-2, and is looked up as a pack of 2 (Ruling 47)', async () => {
    const w = world();
    const open = await ambiguous(w);
    await applyReviewAnswer(w.store, AMBIGUOUS, { parts: ['DCKTS650D1P1', ' dcb205-2 '], seen: reviewSignature(open) }, T0 + MINUTE);
    const split = { components: ['DCKTS650D1P1', 'DCB205-2'], status: 'resolved', notes: [ENTERED] };
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual(split);
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: 'DCKTS650D1P1,DCB205-2', answerParts: ['DCKTS650D1P1', 'DCB205-2'] });

    // A later scan keeps it and plans the pack's lookup exactly as for a pack the splitter returned.
    w.clock = T0 + DAY;
    const job = await scan(w, { settings: DEWALT_ONLY, policy: NO_SEARCH });
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual(split);
    expect(job.deferred).toContainEqual(lookup('DCB205-2'));
    expect(wantedFor('DEWALT', 'DCB205-2', new Map())).toEqual({ brand: 'DEWALT', model: 'DCB205-2', packQty: 2 });

    // With the recorded DEWALT brand page saved, the pack is matched from it as any part is: the
    // 2-pack listing, "20V MAX 5 Ah Lithium Ion Battery 2-Pack (DCB205-2)".
    w.clock = T0 + 2 * DAY;
    await scan(w, { settings: { ...DEWALT_ONLY, catalogPagesPerScan: 1 }, policy: OPEN });
    expect(await w.store.getMatch('DEWALT:DCB205-2')).toMatchObject({ status: 'matched', asin: 'B00KQU1ENG', grade: 'probable', decidedBy: 'auto' });
  });

  it('refuses every other hyphen form, and the pack form for a RYOBI question (Ruling 47)', async () => {
    const w = world();
    const open = await ambiguous(w);
    const before = await snapshot(w);
    // A pack is of 2 to 9: `-0` and `-1` are refused too.
    for (const pack of ['DCB205-', 'DCB205-0', 'DCB205-1', 'DCB205-22', 'DCB205-2PK', 'DCB205-2-2', 'DCF891B-2', 'DCB-2', 'DCB205 -2', 'DCKTS650D1P1-DCB205']) {
      const parts = ['DCKTS650D1P1', pack];
      await expect(applyReviewAnswer(w.store, AMBIGUOUS, { parts, seen: reviewSignature(open) }, T0 + MINUTE), pack).rejects.toThrow(INVALID);
    }
    expect(await snapshot(w)).toEqual(before);
    // The top of the range, -9, passes.
    await applyReviewAnswer(w.store, AMBIGUOUS, { parts: ['DCKTS650D1P1', 'DCB205-9'], seen: reviewSignature(open) }, T0 + MINUTE);
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split!.components).toEqual(['DCKTS650D1P1', 'DCB205-9']);

    const r = world();
    const sb = await special(r);
    await expect(applyReviewAnswer(r.store, SB, { parts: ['PCL500B', 'DCB205-2'], seen: reviewSignature(sb) }, T0 + MINUTE)).rejects.toThrow(INVALID);
  });

  it('stored parts follow the same rule: the pack form decides a DEWALT answer, never a RYOBI one (Ruling 47)', async () => {
    const w = world();
    const open = await ambiguous(w);
    await w.store.putReview({ ...open, answer: 'DCKTS650D1P1,DCB205-2', answerParts: ['DCKTS650D1P1', 'DCB205-2'], answeredAt: T0 + MINUTE });
    w.clock = T0 + DAY;
    await scan(w, { settings: DEWALT_ONLY, policy: NO_SEARCH });
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual({ components: ['DCKTS650D1P1', 'DCB205-2'], status: 'resolved', notes: [ENTERED] });

    for (const answerParts of [['DCKTS650D1P1', 'DCB205-2PK'], ['DCKTS650D1P1', 'DCF891B-2'], ['DCKTS650D1P1', 'DCB205-1'], ['DCKTS650D1P1', 'DCB205-0']]) {
      const x = world();
      const q = await ambiguous(x);
      await x.store.putReview({ ...q, answer: answerParts.join(','), answerParts, answeredAt: T0 + MINUTE });
      x.clock = T0 + DAY;
      await scan(x, { settings: DEWALT_ONLY, policy: NO_SEARCH });
      expect((await x.store.getBundle('homedepot:ambiguous'))!.split, JSON.stringify(answerParts)).toMatchObject({ status: 'needs_review' });
    }

    const r = world();
    const sb = await special(r);
    await r.store.putReview({ ...sb, answer: 'PCL500B,DCB205-2', answerParts: ['PCL500B', 'DCB205-2'], answeredAt: T0 + MINUTE });
    r.clock = T0 + DAY;
    await scan(r, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect((await r.store.getBundle(SB_KEY))!.split).toMatchObject({ status: 'needs_review', notes: ['no known RYOBI bundle pattern'] });
  });

  it('refuses an entry made on the question before a scan changed it', async () => {
    const w = world();
    await special(w);
    const before = await snapshot(w);
    await expect(applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B'], seen: '[["PCL500B","PCL526B"]]' }, T0 + MINUTE)).rejects.toThrow(CHANGED);
    expect(await snapshot(w)).toEqual(before);
  });

  it('refuses typed parts for a match question, and writes nothing', async () => {
    const { w, item } = await unconfirmed();
    const before = await snapshot(w);
    for (const parts of [['DCF891B'], ['KIT']]) {
      const refused = applyReviewAnswer(w.store, MATCH, { parts, seen: reviewSignature(item) }, T0 + MINUTE);
      await expect(refused).rejects.toBeInstanceOf(AnswerRefused);
      await expect(applyReviewAnswer(w.store, MATCH, { parts, seen: reviewSignature(item) }, T0 + MINUTE)).rejects.toThrow(NOT_FOR_MATCH);
    }
    expect(await snapshot(w)).toEqual(before);
  });

  it('an answer stored before typed parts existed behaves as before: a chosen reading stands, free text is ignored', async () => {
    // A chosen reading stored without answerParts still decides the split.
    const chose = world();
    await ambiguous(chose);
    await applyReviewAnswer(chose.store, AMBIGUOUS, await shown(chose, AMBIGUOUS, { choice: 1 }), T0 + MINUTE);
    const { answerParts: _parts, ...old } = (await chose.store.getReview(AMBIGUOUS))!;
    await chose.store.putReview(old as ReviewItem);
    chose.clock = T0 + DAY;
    await scan(chose, { settings: DEWALT_ONLY, policy: NO_SEARCH });
    expect((await chose.store.getBundle('homedepot:ambiguous'))!.split).toEqual({ components: ['DCKTS650D1P1', 'DCF921B'], status: 'resolved', notes: [CHOSEN] });
    expect(await chose.store.getReview(AMBIGUOUS)).toEqual(old);

    // Free text naming none of the choices, stored without answerParts, decides nothing.
    const w = world();
    const open = await special(w);
    const freeText = { ...open, answer: 'PCL500B,PCL526B', answeredAt: T0 + MINUTE };
    await w.store.putReview(freeText);
    w.clock = T0 + DAY;
    await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect((await w.store.getBundle(SB_KEY))!.split).toMatchObject({ status: 'needs_review', notes: ['no known RYOBI bundle pattern'] });
    expect(await w.store.getReview(SB)).toEqual(freeText);
  });

  it('stored parts that fail the rule are ignored: the answer counts only by today\'s rule', async () => {
    // Stored data is untrusted. An entry that is not a model number, or more than eight: the marker decides nothing.
    for (const answerParts of [['PCL500B', 'KIT'], ['PCL500B', 'pcl526b'], Array.from({ length: 9 }, () => 'PCL500B')]) {
      const w = world();
      const open = await special(w);
      const stored = { ...open, answer: answerParts.join(','), answerParts, answeredAt: T0 + MINUTE };
      await w.store.putReview(stored);
      w.clock = T0 + DAY;
      await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
      expect((await w.store.getBundle(SB_KEY))!.split, JSON.stringify(answerParts)).toMatchObject({ status: 'needs_review', notes: ['no known RYOBI bundle pattern'] });
      expect(await w.store.getReview(SB)).toEqual(stored);
    }

    // Stored parts that are not the answer, on an answer that equals one of the choices: the choice still stands, as before.
    const chose = world();
    await ambiguous(chose);
    await applyReviewAnswer(chose.store, AMBIGUOUS, await shown(chose, AMBIGUOUS, { choice: 1 }), T0 + MINUTE);
    const answered = (await chose.store.getReview(AMBIGUOUS))!;
    await chose.store.putReview({ ...answered, answerParts: ['DCKTS650D1P1', 'DCF921B', '-2'] });
    chose.clock = T0 + DAY;
    await scan(chose, { settings: DEWALT_ONLY, policy: NO_SEARCH });
    expect((await chose.store.getBundle('homedepot:ambiguous'))!.split).toEqual({ components: ['DCKTS650D1P1', 'DCF921B'], status: 'resolved', notes: [CHOSEN] });
  });
});

// ---------------------------------------------------------------- the report names the owner's answer

describe('BundleRow.answer: the report says when a split is the owner\'s answer', () => {
  const RYOBI_COMBO: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
  const RYOBI_ONLY: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [] };
  const SB = 'split:homedepot:328690510';
  const P553 = 'split:homedepot:320243741';
  const rowOf = async (w: World, settings: ScanSettings, key: string) => (await buildReport(w.store, settings)).bundles.find((b) => b.key === key)!;

  it('is null for every bundle a scan split or left open', async () => {
    const w = world();
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    const report = await buildReport(w.store, RYOBI_COMBO);
    expect(report.bundles.length).toBeGreaterThan(0);
    for (const b of report.bundles) expect(b.answer, b.model).toBeNull();
  });

  it('names a chosen reading, typed parts and None of these, and survives a later scan', async () => {
    const w = world();
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    await applyReviewAnswer(w.store, P553, await shown(w, P553, { choice: 0 }), T0 + MINUTE);
    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B'], seen: reviewSignature((await w.store.getReview(SB))!) }, T0 + MINUTE);
    const A983002 = 'split:homedepot:345178210';
    await applyReviewAnswer(w.store, A983002, await shown(w, A983002, { none: true }), T0 + MINUTE);
    const expected = async () => {
      expect((await rowOf(w, RYOBI_ONLY, 'homedepot:320243741')).answer).toEqual({ reviewId: P553, kind: 'chosen' });
      expect((await rowOf(w, RYOBI_ONLY, 'homedepot:328690510')).answer).toEqual({ reviewId: SB, kind: 'entered' });
      expect((await rowOf(w, RYOBI_ONLY, 'homedepot:345178210')).answer).toEqual({ reviewId: A983002, kind: 'none' });
    };
    await expected();
    w.clock = T0 + DAY;
    await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    await expected();
  });

  it('typed parts that are one of the choices read as chosen', async () => {
    const w = world();
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    await applyReviewAnswer(w.store, P553, { parts: ['pcl1600k2', 'p553'], seen: reviewSignature((await w.store.getReview(P553))!) }, T0 + MINUTE);
    expect((await rowOf(w, RYOBI_ONLY, 'homedepot:320243741')).answer).toEqual({ reviewId: P553, kind: 'chosen' });
  });

  it('is null for a question a scan closed and for a stored answer that decides nothing', async () => {
    const closed = world();
    await scan(closed, { settings: COMBO });
    closed.clock = T0 + DAY;
    await scan(closed, { settings: COMBO, policy: ONE_SEARCH, readPages: reader() });
    expect(await closed.store.getReview('split:homedepot:337440459')).toMatchObject({ answer: 'resolved by a later scan' });
    expect((await rowOf(closed, COMBO, 'homedepot:337440459')).answer).toBeNull();

    const w = world();
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    await w.store.putReview({ ...(await w.store.getReview(SB))!, answer: 'PCL500B,PCL526B', answeredAt: T0 + MINUTE });
    w.clock = T0 + DAY;
    await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect((await rowOf(w, RYOBI_ONLY, 'homedepot:328690510')).answer).toBeNull();
  });
});

// ---------------------------------------------------------------- changing an answer

describe('reopenReviewAnswer: the owner can change a split answer (Ruling 42)', () => {
  const RYOBI_COMBO: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
  const RYOBI_ONLY: ScanSettings = { ...STEP2, brands: ['RYOBI'], queries: [] };
  const SB = 'split:homedepot:328690510';
  const SB_KEY = 'homedepot:328690510';
  const P553 = 'split:homedepot:320243741';
  const P553_KEY = 'homedepot:320243741';
  const ENTERED = 'parts entered by you';
  const snapshot = async (w: World) => ({
    bundles: await w.store.listBundles(), review: await w.store.listReview(), matches: await w.store.listMatches(), catalog: await w.store.listCatalog(),
  });

  /** The recorded RYOBI search, as a scan leaves it: PCL500525SB offers no reading, PCL1600K2-P553 one. */
  async function scanned(w: World) {
    await scan(w, { settings: RYOBI_COMBO, policy: ONE_SEARCH });
    const sb = { item: (await w.store.getReview(SB))!, split: (await w.store.getBundle(SB_KEY))!.split! };
    const p553 = { item: (await w.store.getReview(P553))!, split: (await w.store.getBundle(P553_KEY))!.split! };
    expect(sb.item).toMatchObject({ model: 'PCL500525SB', choices: [], answer: null });
    expect(sb.split.status).toBe('needs_review');
    expect(p553.item).toMatchObject({ model: 'PCL1600K2-P553', choices: [['PCL1600K2', 'P553']], answer: null });
    expect(p553.split.status).toBe('needs_review');
    return { sb, p553 };
  }

  /** What the report shows for a bundle, and whether its question is asked. */
  async function shownFor(w: World, key: string, id: string) {
    const report = await buildReport(w.store, RYOBI_ONLY);
    const row = report.bundles.find((b) => b.key === key)!;
    return { section: row.section, status: row.status, answer: row.answer, asked: report.review.some((r) => r.id === id) };
  }
  const notKnownYet = { section: 'split', status: 'needs_review', answer: null, asked: true };

  it('PCL500525SB answered PCL500B, PCL526B is reopened: back in Contents not known, its question open, as the scan left it', async () => {
    const w = world();
    const { sb } = await scanned(w);
    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B'], seen: reviewSignature(sb.item) }, T0 + MINUTE);
    expect(await shownFor(w, SB_KEY, SB)).toMatchObject({ section: 'waiting', answer: { reviewId: SB, kind: 'entered' }, asked: false });

    await reopenReviewAnswer(w.store, SB, T0 + 2 * MINUTE);
    expect(await w.store.getReview(SB)).toEqual(sb.item);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual(sb.split);
    expect(await shownFor(w, SB_KEY, SB)).toEqual(notKnownYet);

    // Answered again, with a part listed twice: the new answer is the split.
    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B', 'PCL526B'], seen: reviewSignature((await w.store.getReview(SB))!) }, T0 + 3 * MINUTE);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual({ components: ['PCL500B', 'PCL526B', 'PCL526B'], status: 'resolved', notes: [ENTERED] });
    expect(await w.store.getReview(SB)).toEqual({ ...sb.item, answer: 'PCL500B,PCL526B,PCL526B', answerParts: ['PCL500B', 'PCL526B', 'PCL526B'], answeredAt: T0 + 3 * MINUTE });
    expect(await shownFor(w, SB_KEY, SB)).toMatchObject({ answer: { reviewId: SB, kind: 'entered' }, asked: false });
  });

  it('a None of these answer is reopened the same way, and can then be answered with parts', async () => {
    const w = world();
    const { sb } = await scanned(w);
    await applyReviewAnswer(w.store, SB, { none: true, seen: reviewSignature(sb.item) }, T0 + MINUTE);
    expect(await shownFor(w, SB_KEY, SB)).toMatchObject({ section: 'split', answer: { reviewId: SB, kind: 'none' }, asked: false });

    await reopenReviewAnswer(w.store, SB, T0 + 2 * MINUTE);
    expect(await w.store.getReview(SB)).toEqual(sb.item);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual(sb.split);
    expect(await shownFor(w, SB_KEY, SB)).toEqual(notKnownYet);

    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B'], seen: reviewSignature((await w.store.getReview(SB))!) }, T0 + 3 * MINUTE);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual({ components: ['PCL500B', 'PCL526B'], status: 'resolved', notes: [ENTERED] });
  });

  it('a chosen reading (PCL1600K2-P553) is reopened with its reading offered again', async () => {
    const w = world();
    const { p553 } = await scanned(w);
    await applyReviewAnswer(w.store, P553, await shown(w, P553, { choice: 0 }), T0 + MINUTE);
    expect(await shownFor(w, P553_KEY, P553)).toMatchObject({ answer: { reviewId: P553, kind: 'chosen' }, asked: false });

    await reopenReviewAnswer(w.store, P553, T0 + 2 * MINUTE);
    expect(await w.store.getReview(P553)).toEqual(p553.item);
    expect((await w.store.getBundle(P553_KEY))!.split).toEqual(p553.split);
    expect(await shownFor(w, P553_KEY, P553)).toEqual(notKnownYet);

    await applyReviewAnswer(w.store, P553, await shown(w, P553, { none: true }), T0 + 3 * MINUTE);
    expect(await shownFor(w, P553_KEY, P553)).toMatchObject({ section: 'split', answer: { reviewId: P553, kind: 'none' }, asked: false });
  });

  it('an answer survives a later scan and can still be reopened; the reopened question stays open across later scans', async () => {
    const w = world();
    const { sb } = await scanned(w);
    await applyReviewAnswer(w.store, SB, { parts: ['PCL500B', 'PCL526B'], seen: reviewSignature(sb.item) }, T0 + MINUTE);
    w.clock = T0 + DAY;
    await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual({ components: ['PCL500B', 'PCL526B'], status: 'resolved', notes: [ENTERED] });
    // The scan left the two parts waiting for their lookups: those records stay, unused.
    expect(await w.store.getMatch('RYOBI:PCL500B')).toMatchObject({ status: 'waiting' });

    await reopenReviewAnswer(w.store, SB, T0 + DAY + MINUTE);
    expect(await w.store.getReview(SB)).toEqual(sb.item);
    expect((await w.store.getBundle(SB_KEY))!.split).toEqual(sb.split);
    expect(await w.store.getMatch('RYOBI:PCL500B')).toMatchObject({ status: 'waiting' });

    for (const day of [2, 3]) {
      w.clock = T0 + day * DAY;
      const job = await scan(w, { settings: RYOBI_ONLY, policy: NO_SEARCH });
      expect(await w.store.getReview(SB)).toEqual(sb.item);
      expect((await w.store.getBundle(SB_KEY))!.split).toEqual(sb.split);
      expect(job.counts.reviewsOpened).toBe(0);
      // Its old parts are no longer planned for this bundle.
      expect(job.deferred.filter((s) => s.kind === 'lookup' && s.model.startsWith('PCL5'))).toEqual([]);
      expect(await shownFor(w, SB_KEY, SB)).toEqual(notKnownYet);
    }
    expect(w.ledger).toEqual(['scan:listing:ryobi 18v combo kit:p1']);
  });

  it('a reopened question takes the reading the data gives now, as a scan updates an open question, and keeps openedAt', async () => {
    const w = world();
    const id = 'split:homedepot:337440461';
    // Without pages, 337440461 (DCK200D1P1WB606) offers no reading; the owner answers None of these.
    await scan(w, { settings: COMBO });
    const first = (await w.store.getReview(id))!;
    expect(first).toMatchObject({ choices: [], answer: null, openedAt: T0 });
    await applyReviewAnswer(w.store, id, { none: true, seen: reviewSignature(first) }, T0 + MINUTE);
    // A later scan reads 337440459's page for it; the answer stands, so the question is not rewritten.
    w.clock = T0 + DAY;
    await scan(w, { settings: COMBO, policy: ONE_SEARCH, readPages: reader({ '337440461': '337440459' }) });
    expect(await w.store.getReview(id)).toMatchObject({ choices: [], answer: 'none' });

    await reopenReviewAnswer(w.store, id, T0 + DAY + MINUTE);
    const reopened = (await w.store.getReview(id))!;
    expect(reopened).toMatchObject({ answer: null, answeredAt: null, openedAt: T0, choices: [['DCK200D1P1', 'DCF921B']] });
    expect(reopened.reason).not.toBe(first.reason);
    expect(reopened.reason).toBe((await w.store.getBundle('homedepot:337440461'))!.split!.notes.join('; '));
    expect((await w.store.getBundle('homedepot:337440461'))!.split!.status).toBe('needs_review');

    // An answer made for the old choices is refused; one made for the new ones is taken.
    const before = await snapshot(w);
    await expect(applyReviewAnswer(w.store, id, { none: true, seen: reviewSignature(first) }, T0 + DAY + 2 * MINUTE)).rejects.toThrow(CHANGED);
    expect(await snapshot(w)).toEqual(before);
    await applyReviewAnswer(w.store, id, { choice: 0, seen: reviewSignature(reopened) }, T0 + DAY + 2 * MINUTE);
    expect((await w.store.getBundle('homedepot:337440461'))!.split).toEqual({ components: ['DCK200D1P1', 'DCF921B'], status: 'resolved', notes: [CHOSEN] });

    // A later scan leaves the reopened question as a scan leaves any open one: the same.
    await reopenReviewAnswer(w.store, id, T0 + DAY + 3 * MINUTE);
    const again = (await w.store.getReview(id))!;
    w.clock = T0 + 2 * DAY;
    const job = await scan(w, { settings: COMBO, policy: NO_SEARCH });
    expect(await w.store.getReview(id)).toEqual(again);
    expect(job.counts.reviewsOpened).toBe(0);
  });

  it('a bundle the data now resolves is split as a scan splits it, and its question closed as a scan closes it', async () => {
    const w = world();
    await scanned(w);
    await applyReviewAnswer(w.store, P553, await shown(w, P553, { choice: 0 }), T0 + MINUTE);
    // Both parts are now in the stored catalog, as they would be once known.
    for (const m of ['PCL1600K2', 'P553']) {
      await w.store.putCatalogEntry({ key: `RYOBI:${m}`, brand: 'RYOBI', model: m, title: `${m} (seeded for this test)`, kinds: [], isKit: false, upc: null, seenAt: T0 });
    }
    await reopenReviewAnswer(w.store, P553, T0 + 2 * MINUTE);
    const split = (await w.store.getBundle(P553_KEY))!.split!;
    expect(split).toMatchObject({ components: ['PCL1600K2', 'P553'], status: 'resolved' });
    expect(split.notes).not.toContain(CHOSEN);
    expect(await w.store.getReview(P553)).toMatchObject({ answer: 'resolved by a later scan', answeredAt: T0 + 2 * MINUTE });
    expect((await w.store.getReview(P553))!.answerParts).toBeUndefined();
    expect(await shownFor(w, P553_KEY, P553)).toMatchObject({ answer: null, asked: false });
  });

  it('refuses an unknown id, an open question, a match question, one a scan closed and an answer that decides nothing, and writes nothing', async () => {
    const w = world();
    const { sb } = await scanned(w);
    const before = await snapshot(w);
    const refusals: [unknown, string][] = [
      ['split:homedepot:nothing', NOT_FOUND], [7, NOT_FOUND], [SB, 'That question has not been answered yet.'],
    ];
    for (const [id, sentence] of refusals) {
      const refused = reopenReviewAnswer(w.store, id as string, T0 + MINUTE);
      await expect(refused, String(id)).rejects.toBeInstanceOf(AnswerRefused);
      await expect(reopenReviewAnswer(w.store, id as string, T0 + MINUTE), String(id)).rejects.toThrow(sentence);
    }
    expect(await snapshot(w)).toEqual(before);

    // A stored answer that names none of the choices (saved before step 5) decides nothing: there is nothing to change.
    await w.store.putReview({ ...sb.item, answer: 'PCL500B,PCL526B', answeredAt: T0 + MINUTE });
    const freeText = await snapshot(w);
    await expect(reopenReviewAnswer(w.store, SB, T0 + 2 * MINUTE)).rejects.toThrow('That question has no answer of yours to change.');
    expect(await snapshot(w)).toEqual(freeText);

    // A question a scan closed itself.
    const closed = world();
    await scan(closed, { settings: COMBO });
    closed.clock = T0 + DAY;
    await scan(closed, { settings: COMBO, policy: ONE_SEARCH, readPages: reader() });
    const id = 'split:homedepot:337440459';
    expect(await closed.store.getReview(id)).toMatchObject({ answer: 'resolved by a later scan' });
    const settled = await snapshot(closed);
    await expect(reopenReviewAnswer(closed.store, id, T0 + DAY + MINUTE)).rejects.toThrow('That question has no answer of yours to change.');
    expect(await snapshot(closed)).toEqual(settled);

    // A match question, open or answered.
    const { w: m } = await unconfirmed();
    const ONLY_SPLIT = 'Only an answer about what a bundle contains can be changed.';
    const openMatch = await snapshot(m);
    await expect(reopenReviewAnswer(m.store, MATCH, T0 + MINUTE)).rejects.toThrow(ONLY_SPLIT);
    expect(await snapshot(m)).toEqual(openMatch);
    await applyReviewAnswer(m.store, MATCH, await shown(m, MATCH, { choice: 0 }), T0 + MINUTE);
    const answeredMatch = await snapshot(m);
    await expect(reopenReviewAnswer(m.store, MATCH, T0 + 2 * MINUTE)).rejects.toBeInstanceOf(AnswerRefused);
    await expect(reopenReviewAnswer(m.store, MATCH, T0 + 2 * MINUTE)).rejects.toThrow(ONLY_SPLIT);
    expect(await snapshot(m)).toEqual(answeredMatch);
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
    // The answer saved the price the question showed, as the lookup saw it: it is fresh, so nothing is refreshed.
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 0, reviewsOpened: 0 });
    expect(w.ledger).toEqual(['scan:lookup:DCF891B']);
    expect(await w.store.getPrice('B0HQGDLWH9')).toEqual({ asin: 'B0HQGDLWH9', price: 100.83, reviews: null, seenAt: T0, checkedAt: T0 });
    expect((await buildReport(w.store, DEWALT_ONLY)).review).toEqual([]);
  });

  it('a choice saves the listing\'s price as the lookup saw it, so the part is active in the report at once', async () => {
    const { w, item } = await unconfirmed();
    // The question keeps when the lookup's response showed each listing.
    expect(item.candidates[0]).toMatchObject({ asin: 'B0HQGDLWH9', price: 100.83, seenAt: T0 });
    await applyReviewAnswer(w.store, MATCH, await shown(w, MATCH, { choice: 0 }), T0 + MINUTE);
    expect(await w.store.getPrice('B0HQGDLWH9')).toEqual({ asin: 'B0HQGDLWH9', price: 100.83, reviews: null, seenAt: T0, checkedAt: T0 });
    const row = (await buildReport(w.store, DEWALT_ONLY)).bundles.find((b) => b.key === 'homedepot:seeded')!;
    expect(row.parts.find((p) => p.model === 'DCF891B')).toMatchObject({ availability: 'active', asin: 'B0HQGDLWH9', price: 100.83, priceSeenAt: T0 });
  });

  it('a question saved before its listings carried a time saves no price, as before', async () => {
    const { w, item } = await unconfirmed();
    const old = { ...item, candidates: item.candidates.map(({ seenAt: _seenAt, ...c }) => c) } as unknown as ReviewItem;
    await w.store.putReview(old);
    await applyReviewAnswer(w.store, MATCH, await shown(w, MATCH, { choice: 0 }), T0 + MINUTE);
    expect(await w.store.getMatch('DEWALT:DCF891B')).toMatchObject({ status: 'matched', asin: 'B0HQGDLWH9', decidedBy: 'user' });
    expect(await w.store.getPrice('B0HQGDLWH9')).toBeUndefined();
    const row = (await buildReport(w.store, DEWALT_ONLY)).bundles.find((b) => b.key === 'homedepot:seeded')!;
    expect(row.parts.find((p) => p.model === 'DCF891B')).toMatchObject({ availability: 'inactive', price: null });
  });

  it('a choice never writes over a price checked after the lookup', async () => {
    const { w } = await unconfirmed();
    const newer = { asin: 'B0HQGDLWH9', price: 97.5, reviews: 3, seenAt: T0 + 5 * MINUTE, checkedAt: T0 + 5 * MINUTE };
    await w.store.putPrice(newer);
    await applyReviewAnswer(w.store, MATCH, await shown(w, MATCH, { choice: 0 }), T0 + 10 * MINUTE);
    expect(await w.store.getPrice('B0HQGDLWH9')).toEqual(newer);
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

describe('the report leaves out a match question no current split holds (final review)', () => {
  it('typed parts open a match question; after Change and other parts it leaves Review, kept as it was, and comes back with its part', async () => {
    const w = world();
    const split = await ambiguous(w);
    // The kit is not what this test is about: it was looked up before and nothing was found.
    await w.store.putMatch({ key: 'DEWALT:DCKTS650D1P1', brand: 'DEWALT', model: 'DCKTS650D1P1', status: 'none', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
    const asked = async () => (await buildReport(w.store, DEWALT_ONLY)).review.map((r) => r.id);

    // The owner types the parts; the next scan looks DCF891B up, and the recorded search without its
    // one confirmed listing opens its match question (as in scan-runner's rule 6 test).
    await applyReviewAnswer(w.store, AMBIGUOUS, { parts: ['DCKTS650D1P1', 'DCF891B'], seen: reviewSignature(split) }, T0 + MINUTE);
    const data = recorded('amazon-search-DCF891B') as { organic_results: { asin: string }[] };
    const response = { ...data, organic_results: data.organic_results.filter((row) => row.asin !== 'B09YXXFPBJ') };
    const fetchFn = (async (input: string | URL | Request) =>
      String(input).includes('k=DEWALT+DCF891B') ? new Response(JSON.stringify(response), { status: 200 }) : w.replay.fetchFn(input)) as typeof fetch;
    w.clock = T0 + 10 * MINUTE;
    await scan(w, { settings: DEWALT_ONLY, fetchFn });
    expect(w.ledger).toEqual(['scan:lookup:DCF891B']);
    const question = (await w.store.getReview(MATCH))!;
    expect(question).toMatchObject({ kind: 'match', subject: 'DEWALT:DCF891B', answer: null });
    expect(question.candidates).toHaveLength(7);
    expect(await asked()).toEqual([MATCH]);

    // Change: the bundle is back in Contents not known, so no bundle holds DCF891B.
    await reopenReviewAnswer(w.store, AMBIGUOUS, T0 + 11 * MINUTE);
    expect(await asked()).toEqual([AMBIGUOUS]);
    // Other parts typed: still no bundle holds DCF891B. Its question is left out of Review and its
    // count, but stored as it was.
    await applyReviewAnswer(w.store, AMBIGUOUS, { parts: ['DCKTS650D1P1', 'DCF921B'], seen: reviewSignature((await w.store.getReview(AMBIGUOUS))!) }, T0 + 12 * MINUTE);
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toMatchObject({ components: ['DCKTS650D1P1', 'DCF921B'], status: 'resolved' });
    expect(await asked()).toEqual([]);
    expect(await w.store.getReview(MATCH)).toEqual(question);

    // The part comes back: so does its question, as it was.
    await reopenReviewAnswer(w.store, AMBIGUOUS, T0 + 13 * MINUTE);
    await applyReviewAnswer(w.store, AMBIGUOUS, { parts: ['DCKTS650D1P1', 'DCF891B'], seen: reviewSignature((await w.store.getReview(AMBIGUOUS))!) }, T0 + 14 * MINUTE);
    const report = await buildReport(w.store, DEWALT_ONLY);
    expect(report.review.map((r) => r.id)).toEqual([MATCH]);
    expect(report.review[0]).toMatchObject({ openedAt: question.openedAt, candidates: question.candidates });
  });
});
