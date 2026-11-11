import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { PaidProblem, quotePaid, refusalFor, runPaid, savedAnswers } from '../src/scan/paid';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type MatchRecord, type PaidAction, type ScanSettings } from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient, SerpApiError } from '../src/serpapi/client';
import * as fx from './fixtures';
import { recorded } from './recorded';

// The side panel's paid actions, replayed: every search goes through the real SerpApiClient
// and SearchBudget over fixtures/recorded/. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 10, 12);
const MINUTE = 60_000;
const account = (over = {}) => parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, ...over });
/** The ratchet page alone, as the runner tests scan it: two bundles, parts PBLRC25B and PBLRC01B. */
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };
/** The manual-trigger budget with searches per scan 5: reserve 0 (budgetPolicyFor(s, 'manual', 0)). */
const MANUAL: BudgetPolicy = { reserve: 0, maxPerRun: 5 };

const LISTING = 'engine=home_depot&page=1&q=ryobi extended reach ratchet';
const LOOKUP_01B = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC01B';
const LOOKUP_25B = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC25B';
const PRODUCT_25B = 'amazon_domain=amazon.com&asin=B0B3JWF5ZV&engine=amazon_product';

const LOOK_01B: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC01B' }] };
const LOOK_25B: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC25B' }] };
const LOOK_BOTH: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC01B' }, { brand: 'RYOBI', model: 'PBLRC25B' }] };
const VERIFY_25B: PaidAction = { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' };

/** Ruling 53: a paid action that needs more searches than a scan may use says so, and what to do. */
const RUN_CAP = 'This needs 2 searches, and a scan may use 1. Raise the searches per scan in settings to do it here.';
const RESERVE = 'Stopped: spending more would dip into the search reserve.';
const HOURLY = "Stopped: the plan's hourly search limit is reached. Try again next hour.";

interface World {
  store: MemoryScanStore;
  cache: MemoryCache;
  replay: Replay;
  clock: number;
  /** Ledger label of every search that counted against the quota. */
  ledger: string[];
  /** Answers each search; default the replay. */
  fetchFn: typeof fetch;
}

function world(): World {
  const replay = replayRecorded();
  return { store: new MemoryScanStore(), cache: new MemoryCache(), replay, clock: T0, ledger: [], fetchFn: replay.fetchFn };
}

function clientFor(w: World, policy: BudgetPolicy, acct = account()) {
  const budget = new SearchBudget(acct, policy);
  const client = new SerpApiClient({
    apiKey: 'TEST', budget, cache: w.cache, fetchFn: (input, init) => w.fetchFn(input, init), now: () => w.clock,
    onSpend: (entry) => void w.ledger.push(entry.label),
  });
  return { budget, client };
}

/** A scan allowed one search: the ratchet page is read and both parts are left waiting (run_cap). */
async function waiting(): Promise<World> {
  const w = world();
  const { budget, client } = clientFor(w, { reserve: 0, maxPerRun: 1 });
  const job = await runScan({ client, budget, store: w.store, settings: RATCHET, now: () => w.clock });
  expect(job).toMatchObject({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 1 });
  expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'waiting', waitingSince: T0 });
  expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'waiting', waitingSince: T0 });
  return w;
}

const paid = (w: World, action: PaidAction, policy = MANUAL, acct = account()) => {
  const { budget, client } = clientFor(w, policy, acct);
  return runPaid({ client, budget, store: w.store, now: () => w.clock, settings: RATCHET }, action);
};

async function quote(w: World, action: PaidAction, policy = MANUAL, acct = account()) {
  return quotePaid(action, await savedAnswers(w.store), new SearchBudget(acct, policy));
}

/** Both parts matched from the panel at T0 + 1 minute: PBLRC01B looked up, PBLRC25B from the listings that lookup saved. */
async function bothMatched(): Promise<World> {
  const w = await waiting();
  w.clock = T0 + MINUTE;
  await paid(w, LOOK_01B);
  await paid(w, LOOK_25B);
  return w;
}

/** The recorded detail page of B0B3JWF5ZV, changed by `edit`, answering the verify request; everything else is replayed. */
function productPage(w: World, edit: (page: Record<string, Record<string, unknown>>) => void): void {
  const page = structuredClone(recorded('amazon-product-B0B3JWF5ZV')) as Record<string, Record<string, unknown>>;
  edit(page);
  const replay = w.fetchFn;
  w.fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.searchParams.get('engine') !== 'amazon_product') return replay(input, init);
    w.replay.calls.push(PRODUCT_25B);
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
}

// ---------------------------------------------------------------- Look up

describe('runPaid lookUp: the scan\'s own lookup step for parts left waiting', () => {
  it('PBLRC01B: one search, labelled panel:lookup, matched from the recorded search as a scan matches it', async () => {
    const w = await waiting();
    expect(await quote(w, LOOK_01B)).toEqual({ searches: 1, refusal: null });
    w.clock = T0 + MINUTE;
    await paid(w, LOOK_01B);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'panel:lookup:PBLRC01B']);
    const match = await w.store.getMatch('RYOBI:PBLRC01B');
    expect(match).toEqual({
      key: 'RYOBI:PBLRC01B', brand: 'RYOBI', model: 'PBLRC01B', status: 'matched', asin: 'B0B6Z2ZGVK', grade: 'probable', alternatives: [],
      decidedBy: 'auto', updatedAt: T0 + MINUTE, waitingSince: null,
    });
    expect(await w.store.getPrice('B0B6Z2ZGVK')).toEqual({ asin: 'B0B6Z2ZGVK', price: 146.94, reviews: 212, seenAt: T0 + MINUTE, checkedAt: T0 + MINUTE });
    // Every RYOBI row of the response is saved, as a scan's lookup saves it.
    expect((await w.store.listListings()).length).toBeGreaterThan(1);
    // The other part was not asked for: it still waits.
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'waiting', waitingSince: T0 });

    // The same lookup run by a scan gives the same record, apart from when it was decided.
    const scanned = world();
    const { budget, client } = clientFor(scanned, MANUAL);
    await runScan({ client, budget, store: scanned.store, settings: RATCHET, now: () => scanned.clock });
    expect(await scanned.store.getMatch('RYOBI:PBLRC01B')).toEqual({ ...match, updatedAt: T0 });
    expect(await scanned.store.getPrice('B0B6Z2ZGVK')).toMatchObject({ price: 146.94, reviews: 212 });
  });

  it('a part a saved listing answers costs 0: Look up applies that match and sends nothing', async () => {
    const w = await waiting();
    expect(await quote(w, LOOK_BOTH)).toEqual({ searches: 2, refusal: null });
    w.clock = T0 + MINUTE;
    await paid(w, LOOK_01B);
    // The PBLRC01B search saved B0B3JWF5ZV, whose title carries PBLRC25B (2c rule 5).
    expect(await quote(w, LOOK_25B)).toEqual({ searches: 0, refusal: null });
    // With nothing to spend, a closed budget refuses nothing.
    const closed = account({ total_searches_left: 0 });
    expect(await quote(w, LOOK_25B, MANUAL, closed)).toEqual({ searches: 0, refusal: null });
    w.clock = T0 + 2 * MINUTE;
    await paid(w, LOOK_25B, MANUAL, closed);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
    expect(w.ledger).toHaveLength(2);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({
      status: 'matched', asin: 'B0B3JWF5ZV', grade: 'probable', decidedBy: 'auto', updatedAt: T0 + 2 * MINUTE, waitingSince: null,
    });
    // Priced from the saved listing, as old as that listing.
    expect(await w.store.getPrice('B0B3JWF5ZV')).toEqual({ asin: 'B0B3JWF5ZV', price: 169, reviews: 221, seenAt: T0 + MINUTE, checkedAt: T0 + MINUTE });
  });

  it('a part twice in one request is one search', async () => {
    const w = await waiting();
    const twice: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC01B' }, { brand: ' ryobi', model: 'pblrc01b ' }] };
    expect(await quote(w, twice)).toEqual({ searches: 1, refusal: null });
    await paid(w, twice);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
  });

  it('never looks up a part the owner decided, a part already matched, or a part in no resolved bundle', async () => {
    const w = await bothMatched();
    const calls = w.replay.calls.length;
    const decided: MatchRecord = {
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'waiting', asin: null, grade: null, alternatives: [],
      decidedBy: 'user', updatedAt: T0, waitingSince: T0,
    };
    await w.store.putMatch(decided);
    const unknown: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'P999' }] };
    for (const action of [LOOK_25B, LOOK_01B, unknown]) {
      expect(await quote(w, action), JSON.stringify(action)).toEqual({ searches: 0, refusal: null });
      await paid(w, action);
    }
    expect(w.replay.calls).toHaveLength(calls);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(decided);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', updatedAt: T0 + MINUTE });
    expect(await w.store.getMatch('RYOBI:P999')).toBeUndefined();
  });

  /** The caller's sentence: core knows nothing of why it stops. */
  const STOP = 'Stopped for this test.';

  it('shouldStop is asked before each lookup: a sentence after the first of two stops it, the second waits, having spent 1', async () => {
    const w = await waiting();
    const { budget, client } = clientFor(w, MANUAL);
    w.clock = T0 + MINUTE;
    // The ledger holds the scan's listing page; a second entry is the first lookup.
    const shouldStop = () => (w.ledger.length >= 2 ? STOP : null);
    const stopped = runPaid({ client, budget, store: w.store, now: () => w.clock, settings: RATCHET, shouldStop }, LOOK_BOTH);
    await expect(stopped).rejects.toThrow(new PaidProblem(STOP));
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'panel:lookup:PBLRC01B']);
    expect(budget.spentThisRun).toBe(1);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK' });
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'waiting', waitingSince: T0, updatedAt: T0 + MINUTE });
  });

  it('a stop asked for before the first search sends nothing, and a Verify asks it too', async () => {
    const w = await waiting();
    const { budget, client } = clientFor(w, MANUAL);
    const deps = { client, budget, store: w.store, now: () => w.clock, settings: RATCHET, shouldStop: () => STOP };
    await expect(runPaid(deps, LOOK_BOTH)).rejects.toThrow(new PaidProblem(STOP));
    expect(w.replay.calls).toEqual([LISTING]);
    for (const key of ['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']) expect(await w.store.getMatch(key)).toMatchObject({ status: 'waiting' });
    const matched = await bothMatched();
    const again = clientFor(matched, MANUAL);
    const verifying = { client: again.client, budget: again.budget, store: matched.store, now: () => matched.clock, settings: RATCHET, shouldStop: () => STOP };
    await expect(runPaid(verifying, VERIFY_25B)).rejects.toThrow(new PaidProblem(STOP));
    expect(matched.replay.calls).not.toContain(PRODUCT_25B);
  });

  it('a failed lookup is not retried: it and the parts after it wait, and the error is thrown', async () => {
    const w = await waiting();
    const replay = w.fetchFn;
    w.fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.searchParams.get('k') === 'RYOBI PBLRC01B') {
        w.replay.calls.push(LOOKUP_01B);
        return new Response('{}', { status: 500 });
      }
      return replay(input, init);
    }) as typeof fetch;
    w.clock = T0 + MINUTE;
    const failed = paid(w, LOOK_BOTH);
    await expect(failed).rejects.toBeInstanceOf(SerpApiError);
    await expect(failed).rejects.toThrow('SerpApi returned HTTP 500.');
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
    expect(w.ledger).toHaveLength(1);
    for (const key of ['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']) expect(await w.store.getMatch(key)).toMatchObject({ status: 'waiting', waitingSince: T0 });
  });
});

// ---------------------------------------------------------------- Verify

describe('runPaid verify: one detail page upgrades or rejects a title match', () => {
  it('B0B3JWF5ZV for PBLRC25B: one search, labelled panel:verify; the recorded page upgrades the title match to strong', async () => {
    const w = await bothMatched();
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ asin: 'B0B3JWF5ZV', grade: 'probable' });
    expect(await quote(w, VERIFY_25B)).toEqual({ searches: 1, refusal: null });
    expect(await refusalFor(w.store, VERIFY_25B)).toBeNull();
    w.clock = T0 + 2 * MINUTE;
    await paid(w, VERIFY_25B);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, PRODUCT_25B]);
    expect(w.ledger.at(-1)).toBe('panel:verify:PBLRC25B');
    // The page names the part number PBLRC25B and the brand RYOBI: manufacturer part number match.
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual({
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'matched', asin: 'B0B3JWF5ZV', grade: 'strong', alternatives: [],
      decidedBy: 'auto', updatedAt: T0 + 2 * MINUTE, waitingSince: null,
    });
    // The price the page shows, at the time SerpApi answered.
    expect(await w.store.getPrice('B0B3JWF5ZV')).toEqual({ asin: 'B0B3JWF5ZV', price: 169, reviews: 221, seenAt: T0 + 2 * MINUTE, checkedAt: T0 + 2 * MINUTE });
    expect(await w.store.listReview()).not.toContainEqual(expect.objectContaining({ id: 'match:RYOBI:PBLRC25B' }));

    // Verified once: asked again, it is refused and spends nothing.
    await expect(paid(w, VERIFY_25B)).rejects.toThrow(new PaidProblem('This listing is already verified.'));
    expect(await refusalFor(w.store, VERIFY_25B)).toBe('This listing is already verified.');
    expect(w.replay.calls).toHaveLength(3);
  });

  it('a page that does not confirm the part sends the match to review, with the grading\'s reasons', async () => {
    // A title match pointing at the wrong listing: the recorded page of B0B6Z2ZGVK is the PBLRC01B ratchet.
    const w = await bothMatched();
    await w.store.putMatch({ ...(await w.store.getMatch('RYOBI:PBLRC25B'))!, asin: 'B0B6Z2ZGVK' });
    w.clock = T0 + 2 * MINUTE;
    await paid(w, { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B6Z2ZGVK' });
    expect(w.replay.calls.at(-1)).toBe('amazon_domain=amazon.com&asin=B0B6Z2ZGVK&engine=amazon_product');
    expect(w.ledger.at(-1)).toBe('panel:verify:PBLRC25B');
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual({
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'review', asin: null, grade: null, alternatives: [],
      decidedBy: 'auto', updatedAt: T0 + 2 * MINUTE, waitingSince: null,
    });
    const item = await w.store.getReview('match:RYOBI:PBLRC25B');
    expect(item).toEqual({
      id: 'match:RYOBI:PBLRC25B', kind: 'match', subject: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B',
      title: 'ONE+ HP 18V Brushless Cordless 3/8 in. Extended Reach Ratchet (Tool Only)',
      reason: "The listing's Amazon page does not confirm the part",
      candidates: [{
        asin: 'B0B6Z2ZGVK', title: 'RYOBI ONEAND HP 18V BRUSHLESS Cordless 1/4 in. Extended Reach Ratchet Tool ONLY PBLRC01B', price: 160, reviews: 212,
        reasons: ['no identifier matches'], seenAt: T0 + 2 * MINUTE,
      }],
      choices: [], openedAt: T0 + 2 * MINUTE, answer: null, answeredAt: null,
    });
    expect(await w.store.getPrice('B0B6Z2ZGVK')).toEqual({ asin: 'B0B6Z2ZGVK', price: 160, reviews: 212, seenAt: T0 + 2 * MINUTE, checkedAt: T0 + 2 * MINUTE });
    // In review, the part is not looked up again; the owner answers the question as any other.
    expect(await quote(w, LOOK_25B)).toEqual({ searches: 0, refusal: null });
    await applyReviewAnswer(w.store, item!.id, { none: true, seen: reviewSignature(item!) }, T0 + 3 * MINUTE);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'none', decidedBy: 'user' });
  });

  it('a page that shows no part number or barcode match confirms no more than the title: the match stays as it was', async () => {
    const w = await bothMatched();
    productPage(w, (page) => {
      delete page.product_details!.manufacturer_part_number;
      delete page.product_details!.model_number;
    });
    const before = await w.store.getMatch('RYOBI:PBLRC25B');
    w.clock = T0 + 2 * MINUTE;
    await paid(w, VERIFY_25B);
    expect(w.ledger.at(-1)).toBe('panel:verify:PBLRC25B');
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(before);
    expect(await w.store.getPrice('B0B3JWF5ZV')).toMatchObject({ price: 169, checkedAt: T0 + 2 * MINUTE });
    expect(await w.store.getReview('match:RYOBI:PBLRC25B')).toBeUndefined();
  });

  it('a page that says non-retail packaging goes to review, saying so', async () => {
    const w = await bothMatched();
    productPage(w, (page) => {
      page.product_results!.title = `${String(page.product_results!.title)} (Bulk Packaged)`;
    });
    await paid(w, VERIFY_25B);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'review', asin: null, grade: null });
    expect((await w.store.getReview('match:RYOBI:PBLRC25B'))!.candidates).toEqual([
      expect.objectContaining({ asin: 'B0B3JWF5ZV', reasons: ['manufacturer part number match', 'the listing says non-retail packaging'] }),
    ]);
  });

  it('a page that cannot be read, or that shows another listing, changes nothing and says so', async () => {
    for (const [edit, sentence] of [
      [(page: Record<string, Record<string, unknown>>) => void delete page.product_results, "Amazon's page for this listing could not be read."],
      [(page: Record<string, Record<string, unknown>>) => void (page.product_results!.asin = 'B0OTHER000'), 'Amazon answered with a different listing.'],
    ] as const) {
      const w = await bothMatched();
      productPage(w, edit);
      const before = await w.store.getMatch('RYOBI:PBLRC25B');
      const price = await w.store.getPrice('B0B3JWF5ZV');
      await expect(paid(w, VERIFY_25B)).rejects.toThrow(new PaidProblem(sentence));
      // SerpApi answered, so the search counted.
      expect(w.ledger.at(-1)).toBe('panel:verify:PBLRC25B');
      expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(before);
      expect(await w.store.getPrice('B0B3JWF5ZV')).toEqual(price);
      expect(await w.store.getReview('match:RYOBI:PBLRC25B')).toBeUndefined();
    }
  });

  it('refuses a listing the owner chose, a listing that is not the match, and a part with no match, spending nothing', async () => {
    const w = await bothMatched();
    const chosen: MatchRecord = { ...(await w.store.getMatch('RYOBI:PBLRC25B'))!, decidedBy: 'user', grade: null };
    await w.store.putMatch(chosen);
    const cases: [PaidAction, string][] = [
      [VERIFY_25B, 'You chose this listing yourself.'],
      [{ kind: 'verify', brand: 'RYOBI', model: 'PBLRC01B', asin: 'B0B3JWF5ZV' }, "This listing is no longer the part's match."],
      [{ kind: 'verify', brand: 'RYOBI', model: 'P999', asin: 'B0B3JWF5ZV' }, "This listing is no longer the part's match."],
    ];
    const calls = w.replay.calls.length;
    for (const [action, sentence] of cases) {
      expect(await refusalFor(w.store, action)).toBe(sentence);
      await expect(paid(w, action)).rejects.toThrow(new PaidProblem(sentence));
    }
    expect(w.replay.calls).toHaveLength(calls);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(chosen);
  });
});

// ---------------------------------------------------------------- the budget

describe('quotePaid and runPaid: the manual-trigger budget', () => {
  it('a quote above the budget refuses with the budget\'s own sentence, and runPaid then spends nothing', async () => {
    const cases: [PaidAction, BudgetPolicy, ReturnType<typeof account>, number, string][] = [
      [LOOK_BOTH, { reserve: 0, maxPerRun: 1 }, account(), 2, RUN_CAP],
      [LOOK_BOTH, MANUAL, account({ total_searches_left: 1 }), 2, RESERVE],
      [LOOK_01B, MANUAL, account({ this_hour_searches: 50 }), 1, HOURLY],
    ];
    for (const [action, policy, acct, searches, sentence] of cases) {
      const w = await waiting();
      const before = await w.store.listMatches();
      expect(await quote(w, action, policy, acct)).toEqual({ searches, refusal: sentence });
      await expect(paid(w, action, policy, acct)).rejects.toThrow(new PaidProblem(sentence));
      expect(w.replay.calls).toEqual([LISTING]);
      expect(w.ledger).toHaveLength(1);
      expect(await w.store.listMatches()).toEqual(before);
    }
  });

  it('a verify above the budget is refused before its search', async () => {
    const w = await bothMatched();
    const closed = account({ total_searches_left: 0 });
    expect(await quote(w, VERIFY_25B, MANUAL, closed)).toEqual({ searches: 1, refusal: RESERVE });
    await expect(paid(w, VERIFY_25B, MANUAL, closed)).rejects.toThrow(new PaidProblem(RESERVE));
    expect(w.replay.calls).not.toContain(PRODUCT_25B);
  });

  it('a Verify above a per-scan limit of 0 says it needs 1 search, in the singular (Ruling 53)', async () => {
    const w = await bothMatched();
    const sentence = 'This needs 1 search, and a scan may use 0. Raise the searches per scan in settings to do it here.';
    expect(await quote(w, VERIFY_25B, { reserve: 0, maxPerRun: 0 }, account())).toEqual({ searches: 1, refusal: sentence });
    await expect(paid(w, VERIFY_25B, { reserve: 0, maxPerRun: 0 }, account())).rejects.toThrow(new PaidProblem(sentence));
    expect(w.replay.calls).not.toContain(PRODUCT_25B);
  });

  it('the reserve may be used down to zero: the last search on the account pays for a Look up', async () => {
    const w = await waiting();
    const last = account({ total_searches_left: 1 });
    expect(await quote(w, LOOK_01B, MANUAL, last)).toEqual({ searches: 1, refusal: null });
    await paid(w, LOOK_01B, MANUAL, last);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched' });
  });

  it('a request that is not a paid action the panel offers is refused', async () => {
    const w = await waiting();
    for (const action of [
      { kind: 'lookUp', parts: [] },
      { kind: 'lookUp', parts: [{ brand: 'RYOBI' }] },
      { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B' },
      { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: '  ' },
      { kind: 'refresh' },
      null,
    ]) {
      await expect(paid(w, action as unknown as PaidAction), JSON.stringify(action)).rejects.toThrow(new PaidProblem('That request could not be read.'));
      expect(await refusalFor(w.store, action as unknown as PaidAction)).toBe('That request could not be read.');
    }
    expect(w.replay.calls).toEqual([LISTING]);
  });
});
