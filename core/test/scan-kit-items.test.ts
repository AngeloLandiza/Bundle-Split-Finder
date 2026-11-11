import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { type PageContent, parseBundlePage } from '../src/hdPage';
import { pick } from '../src/match';
import { DEFAULT_SETTINGS } from '../src/settings';
import { applyReviewAnswer, reviewSignature } from '../src/scan/answers';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { quotePaid, runPaid, savedAnswers } from '../src/scan/paid';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import {
  DEFAULT_SCAN_SETTINGS, type PageOutcome, partKey, type ReadPages, type ScanJob, type ScanSettings, type ScanStep, type ScanStore,
} from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import * as fx from './fixtures';
import { recorded } from './recorded';

// When a scan looks up the items of a kit inside a bundle (step 6, Task 3). The tests run the real
// pipeline over the recorded Home Depot searches and pages and the recorded Amazon searches; nothing
// reaches the network. The one hand-made record is the kit's active listing, which the replay has none of.

const T0 = Date.UTC(2026, 10, 11, 12);
const MINUTE = 60_000;
const P553 = 'homedepot:320243741';
const KIT = 'homedepot:317987591';
const QUESTION = `split:${P553}`;

const KITS: ScanSettings = {
  ...DEFAULT_SCAN_SETTINGS, brands: ['RYOBI'], catalogPagesPerScan: 0,
  queries: [{ q: 'ryobi 18v combo kit' }, { q: 'ryobi 18v combo kit', filterTokens: 'bwo64,m5d', bundlesOnly: true }],
};
const BRAND_PAGE: ScanSettings = { ...KITS, queries: [], catalogPagesPerScan: 1 };

/** PCL1600K2's items with a model number, as 317987591's page lists them. */
const KIT_MODELS = ['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL430', 'PCL660', 'PBP005', 'PBP002'];
const isItem = (label: string): boolean => KIT_MODELS.some((m) => label.endsWith(`:${m}`));
/**
 * The items the saved brand page answers, free: PBP005, and (Ruling 70) PCL235, PCL515 and PCL660, which
 * the page lists as PCL235B (B0BGYFTPGK), PCL515B (B0B88R7HWB) and PCL660B (B0B1GKJXNB).
 */
const FREE_ITEMS = ['PBP005', 'PCL235', 'PCL515', 'PCL660'];
/** The items a Look up searches for, in the page's order. */
const SEARCHED_ITEMS = KIT_MODELS.filter((m) => !FREE_ITEMS.includes(m));
/**
 * The items a scan plans once the kit is looked up with no listing: every item the saved brand page
 * does not answer. They share the kit's bundles, so the same saving: by part key.
 */
const ITEM_PLAN = ['PBP002', 'PCL206', 'PCL430', 'PCL500'].map((m) => `lookup:${m}`);

/** The run limits the plan names: 1, 3 and the default searches per scan (5). */
const CAPS = [1, 3, DEFAULT_SETTINGS.searchesPerScan];

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

const recordedPages: ReadPages = async (ids) => ids.map((itemId): PageOutcome => {
  const rec = PAGES.find((p) => p.itemId === itemId);
  const content = rec ? parseBundlePage(rec.text, itemId) : null;
  return content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' };
});

interface World {
  store: MemoryScanStore;
  cache: MemoryCache;
  replay: Replay;
  ledger: string[];
  /** Each scan's plan, as its planning saved it. */
  plans: Plan[];
}

/** A scan's plan of lookups and refreshes: what it queued to run now, and what it deferred, in order. */
interface Plan {
  queue: string[];
  deferred: string[];
}

function paid(w: World, policy: BudgetPolicy) {
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), policy);
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: w.replay.fetchFn, now: () => T0, onSpend: (e) => void w.ledger.push(e.label) });
  return { budget, client };
}

const stepLabel = (s: ScanStep): string => (s.kind === 'lookup' || s.kind === 'refresh' ? `${s.kind}:${s.model}` : s.kind);

/** The world's store, recording each job's plan when its planning first saves it in the parts phase. */
function recording(w: World): ScanStore {
  const seen = new Set<string>();
  return new Proxy(w.store, {
    get(target, prop) {
      if (prop === 'putScan') {
        return async (job: ScanJob) => {
          if (job.phase === 'parts' && !seen.has(job.id)) {
            seen.add(job.id);
            w.plans.push({ queue: job.queue.map(stepLabel), deferred: job.deferred.map(stepLabel) });
          }
          return target.putScan(job);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let clock = 0;
/**
 * One scan of the two listing pages (from the cache within the hour) at a run limit of `cap`, at `at`
 * (default: a minute after the last); returns its plan, what it spent, and every search it sent to the
 * client in order, whether the cache or the network answered it.
 */
async function scan(
  w: World, cap: number, settings: ScanSettings = KITS, at?: number,
): Promise<Plan & { plan: string[]; spent: string[]; ran: string[] }> {
  const before = w.ledger.length;
  clock += 1;
  const { budget, client } = paid(w, { reserve: 0, maxPerRun: cap });
  const ran: string[] = [];
  const watched = { search: (params: Parameters<typeof client.search>[0], options?: Parameters<typeof client.search>[1]) => {
    ran.push(options?.label ?? '');
    return client.search(params, options);
  } };
  await runScan({ budget, client: watched, store: recording(w), settings, now: () => at ?? T0 + clock * MINUTE, readPages: recordedPages });
  const { queue, deferred } = w.plans.at(-1)!;
  return { queue, deferred, plan: [...queue, ...deferred], spent: w.ledger.slice(before), ran };
}

/**
 * The brand page (unless `brandPage` is false), then both listing pages with the bundles' recorded
 * pages; every lookup waits. Then the owner answers PCL1600K2-P553's split question with its one choice.
 */
async function answered(opts: { brandPage?: boolean } = {}): Promise<World> {
  const w: World = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), ledger: [], plans: [] };
  if (opts.brandPage !== false) await runScan({ ...paid(w, { reserve: 0, maxPerRun: 5 }), store: w.store, settings: BRAND_PAGE, now: () => T0 });
  await runScan({ ...paid(w, { reserve: 0, maxPerRun: 2 }), store: w.store, settings: KITS, now: () => T0, readPages: recordedPages });
  const question = (await w.store.getReview(QUESTION))!;
  await applyReviewAnswer(w.store, QUESTION, { choice: 0, seen: reviewSignature(question) }, T0);
  return w;
}

/** The owner's Look up in the panel, as the worker runs it. */
async function lookUp(w: World, models: string[]): Promise<void> {
  await runPaid({ ...paid(w, { reserve: 0, maxPerRun: 20 }), store: w.store, now: () => T0, settings: KITS }, {
    kind: 'lookUp', parts: models.map((model) => ({ brand: 'RYOBI', model })),
  });
}

/** Hand-made: the owner chose a listing for PCL1600K2, and its price was seen at the last check. */
async function kitListed(w: World): Promise<void> {
  const asin = 'B0KITLISTED';
  await w.store.putMatch({
    key: partKey('RYOBI', 'PCL1600K2'), brand: 'RYOBI', model: 'PCL1600K2', status: 'matched', asin, grade: null, alternatives: [],
    decidedBy: 'user', updatedAt: T0, waitingSince: null,
  });
  await w.store.putPrice({ asin, price: 249, reviews: 10, seenAt: T0, checkedAt: T0 });
}

/** The lookups the scan after the owner's answer plans today, before the kit is looked up (oldest waiting first, then by saving). */
const TODAY = ['PCL2200K3N', 'PCL2001K3N', 'PCL1600K2', 'PCL1800K3N', 'PCL1201K2', 'PCL1200K2', 'PCL1400K2', 'P553'].map((m) => `lookup:${m}`);
/** The same once the panel has looked up PCL1600K2. */
const TODAY_AFTER_KIT = TODAY.filter((s) => s !== 'lookup:PCL1600K2');
const modelOf = (label: string): string => label.slice(label.indexOf(':') + 1);

/** The bundles PCL1600K2-P553 and the plain kit, with everything else the world saved, in a store of their own. */
async function twoBundles(w: World): Promise<World> {
  const store = new MemoryScanStore();
  for (const key of [P553, KIT]) await store.putBundle((await w.store.getBundle(key))!);
  for (const c of await w.store.listCatalog()) await store.putCatalogEntry(c);
  for (const l of await w.store.listListings()) await store.putListing(l);
  for (const m of await w.store.listMatches()) await store.putMatch(m);
  const asins = new Set([...(await w.store.listListings()).map((l) => l.asin), ...(await w.store.listMatches()).flatMap((m) => (m.asin ? [m.asin] : []))]);
  for (const asin of asins) {
    const price = await w.store.getPrice(asin);
    if (price) await store.putPrice(price);
  }
  for (const r of await w.store.listReview()) await store.putReview(r);
  return { ...w, store, plans: [] };
}
/** No listing page: a scan of the bundles stored. */
const STORED: ScanSettings = { ...KITS, queries: [] };

describe('kit items in a scan, on the replay', () => {
  for (const cap of CAPS) {
    describe(`at a run limit of ${cap}`, () => {
      it('before the kit is looked up, no item is planned, and the kit is planned as today', async () => {
        const w = await answered();
        expect(await w.store.getMatch(partKey('RYOBI', 'PCL1600K2'))).toMatchObject({ status: 'waiting' });
        const s = await scan(w, cap);
        expect(s.plan).toEqual(TODAY);
        expect(s.queue).toEqual(TODAY.slice(0, cap));
        expect(s.spent.filter(isItem)).toEqual([]);
      });

      it('after the kit is looked up with no listing, its items are planned after every other lookup and refresh', async () => {
        const w = await answered();
        await lookUp(w, ['PCL1600K2']);
        expect(await w.store.getMatch(partKey('RYOBI', 'PCL1600K2'))).toMatchObject({ status: 'none' });
        const s = await scan(w, cap);
        expect(s.plan).toEqual([...TODAY_AFTER_KIT, ...ITEM_PLAN]);
        // Nothing else moved: the queue is the first steps of today's order.
        expect(s.queue).toEqual(TODAY_AFTER_KIT.slice(0, cap));
        // Deferred items wait, as any deferred lookup does.
        for (const label of ITEM_PLAN) expect((await w.store.getMatch(partKey('RYOBI', modelOf(label))))?.status).toBe('waiting');
      });

      it('with an active listing for the kit, its items are never planned in a scan', async () => {
        const w = await answered();
        await kitListed(w);
        for (let i = 0; i < 3; i++) {
          const s = await scan(w, cap);
          expect(s.plan.filter(isItem)).toEqual([]);
          expect(s.spent.filter(isItem)).toEqual([]);
        }
        // Nor are they marked waiting: no scan is going to look.
        for (const label of ITEM_PLAN) expect(await w.store.getMatch(partKey('RYOBI', modelOf(label)))).toBeUndefined();
      });
    });
  }

  it('with nothing else to do, the default limit spends on the items, the waiting ones first next scan', async () => {
    const w = await twoBundles(await answered());
    await lookUp(w, ['PCL1600K2', 'P553']);
    const cap = DEFAULT_SETTINGS.searchesPerScan;
    const first = await scan(w, cap, STORED);
    // P553 is in review and the kit has no listing: only the items are left, and five of them run.
    expect(first.plan).toEqual(ITEM_PLAN);
    expect(first.spent).toEqual(ITEM_PLAN.slice(0, cap).map((l) => `scan:${l}`));
    const second = await scan(w, cap, STORED);
    expect(second.plan).toEqual(ITEM_PLAN.slice(cap));
    expect(second.spent).toEqual(ITEM_PLAN.slice(cap).map((l) => `scan:${l}`));
    expect((await scan(w, cap, STORED)).plan).toEqual([]);
  });

  it('the kit looked up by a scan: its items are planned from the next scan, never by the same one', async () => {
    const w = await twoBundles(await answered());
    const first = await scan(w, 20, STORED);
    expect(first.plan).toEqual(['lookup:PCL1600K2', 'lookup:P553']);
    expect(first.spent).toEqual(['scan:lookup:PCL1600K2', 'scan:lookup:P553']);
    expect((await scan(w, 20, STORED)).plan).toEqual(ITEM_PLAN);
  });

  describe('free matches from saved listings', () => {
    // The brand page is read after the kit is in each state, so the scan that reads it matches PBP005 with 0 searches.
    const states: [string, (w: World) => Promise<void>][] = [
      ['not looked up', async () => {}],
      ['looked up, no listing', (w) => lookUp(w, ['PCL1600K2'])],
      ['with an active listing', kitListed],
    ];
    for (const [name, setUp] of states) {
      it(`PBP005 is matched from the saved brand page, whatever the kit's state: ${name}`, async () => {
        const w = await answered({ brandPage: false });
        await setUp(w);
        expect(await w.store.getMatch(partKey('RYOBI', 'PBP005'))).toBeUndefined();
        const before = w.ledger.length;
        await runScan({ ...paid(w, { reserve: 0, maxPerRun: 5 }), store: w.store, settings: BRAND_PAGE, now: () => T0 + MINUTE });
        expect(w.ledger.slice(before)[0]).toBe('scan:catalog:RYOBI:p1');
        expect(w.ledger.slice(before)).not.toContain('scan:lookup:PBP005');
        expect(await w.store.getMatch(partKey('RYOBI', 'PBP005'))).toMatchObject({ status: 'matched', decidedBy: 'auto' });
      });
    }
  });
});

describe('the panel\'s Look up on a kit\'s items', () => {
  const splitParts = async (w: World) =>
    (await buildReport(w.store, KITS)).bundles.find((b) => b.key === P553)!.options.find((o) => o.id === 'split:PCL1600K2')!.parts
      .map((p) => ({ brand: 'RYOBI', model: p.model }));

  it('the quote on the split option\'s parts is the number no saved listing answers, and the Look up spends exactly that', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'P553']);
    const parts = await splitParts(w);
    expect(parts.map((p) => p.model)).toEqual([...KIT_MODELS, 'P553']);
    // Four items have a saved listing (Ruling 70 for three of them) and P553 was looked up (in review): the four other items are searches.
    const { budget } = paid(w, { reserve: 0, maxPerRun: 20 });
    expect(quotePaid({ kind: 'lookUp', parts }, await savedAnswers(w.store), budget)).toEqual({ searches: 4, refusal: null });
    const before = w.ledger.length;
    await lookUp(w, parts.map((p) => p.model));
    // In a scan's order (Ruling 72): the items tie on waiting and saving, so they go by model.
    expect(w.ledger.slice(before)).toEqual([...SEARCHED_ITEMS].sort().map((m) => `panel:lookup:${m}`));
  });

  it('before the kit is looked up, the quote counts the items no saved listing answers, and P553', async () => {
    const w = await answered();
    const parts = await splitParts(w);
    const { budget } = paid(w, { reserve: 0, maxPerRun: 20 });
    expect(quotePaid({ kind: 'lookUp', parts }, await savedAnswers(w.store), budget).searches).toBe(SEARCHED_ITEMS.length + 1);
  });
});

describe('a kit item\'s match question', () => {
  /** The world after the owner looked up the kit, P553 and every item. */
  async function allLookedUp(): Promise<World> {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'P553', ...KIT_MODELS]);
    return w;
  }
  const questions = async (w: World) => (await buildReport(w.store, KITS)).review.filter((r) => r.kind === 'match').map((r) => r.model).sort();

  it('reaches Review while a bundle splits the kit in one of its options', async () => {
    const w = await allLookedUp();
    // PCL430 has listings that may be it, the brand not confirmed; P553 is a part of the split itself. PCL235
    // and PCL515 are matched to their tool-only listings (Ruling 70), so they ask nothing.
    expect(await questions(w)).toEqual(['P553', 'PCL430']);
  });

  it('the kit\'s page read again without PCL430: its question is left out', async () => {
    const w = await allLookedUp();
    await withoutPCL430(w);
    expect(await questions(w)).toEqual(['P553']);
    const row = (await buildReport(w.store, KITS)).bundles.find((b) => b.key === P553)!;
    expect(row.options.find((o) => o.id === 'split:PCL1600K2')!.parts.map((p) => p.model)).not.toContain('PCL430');
  });
});

/** The kit's own page as if read again a minute later, its Includes list without PCL430. Nothing else is changed. */
async function withoutPCL430(w: World): Promise<void> {
  const kit = (await w.store.getBundle(KIT))!;
  const content = page('317987591');
  const bullets = content.bullets.map((b) => b.replace(', (1) PCL430 Multi-Tool', ''));
  expect(bullets).not.toEqual(content.bullets);
  await w.store.putBundle({ ...kit, page: { ...content, bullets, readAt: T0 + MINUTE } });
}

describe('a kit\'s page read again with a different list', () => {
  it('the next scan plans the items of the new list', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2']);
    await withoutPCL430(w);
    expect((await scan(w, 1)).plan).toEqual([...TODAY_AFTER_KIT, ...ITEM_PLAN.filter((l) => l !== 'lookup:PCL430')]);
  });
});

const KIT_QUESTION = `match:${partKey('RYOBI', 'PCL1600K2')}`;

/**
 * Hand-made, as the replay's PCL1600K2 search has no listing that could be it: the kit's match in review,
 * with a match question offering one saved RYOBI listing, as a lookup or a Verify opens one.
 */
async function kitInReview(w: World): Promise<void> {
  const l = (await w.store.listListings()).find((x) => x.brand === 'RYOBI')!;
  await w.store.putReview({
    id: KIT_QUESTION, kind: 'match', subject: partKey('RYOBI', 'PCL1600K2'), brand: 'RYOBI', model: 'PCL1600K2', title: null,
    reason: '1 listing(s) show the model number, but the brand is not confirmed',
    candidates: [{ asin: l.asin, title: l.title, price: l.price, reviews: l.reviews, reasons: ['brand not confirmed'], seenAt: T0 }],
    choices: [], openedAt: T0, answer: null, answeredAt: null,
  });
  await w.store.putMatch({
    key: partKey('RYOBI', 'PCL1600K2'), brand: 'RYOBI', model: 'PCL1600K2', status: 'review', asin: null, grade: null, alternatives: [],
    decidedBy: 'auto', updatedAt: T0, waitingSince: null,
  });
}

describe('Ruling 69: a kit in review holds its items', () => {
  for (const cap of CAPS) {
    it(`at a run limit of ${cap}: no item is planned while the kit is in review; after "None of these", they are planned last`, async () => {
      const w = await twoBundles(await answered());
      await kitInReview(w);
      const first = await scan(w, cap, STORED);
      expect(first.plan).toEqual(['lookup:P553']);
      expect(first.spent).toEqual(['scan:lookup:P553']);
      // The owner says no listing is the kit: it has no listing, so its items are looked up.
      const item = (await w.store.getReview(KIT_QUESTION))!;
      await applyReviewAnswer(w.store, KIT_QUESTION, { none: true, seen: reviewSignature(item) }, T0 + MINUTE);
      expect(await w.store.getMatch(partKey('RYOBI', 'PCL1600K2'))).toMatchObject({ status: 'none', decidedBy: 'user' });
      const second = await scan(w, cap, STORED);
      expect(second.plan).toEqual(ITEM_PLAN);
      expect(second.spent).toEqual(ITEM_PLAN.slice(0, cap).map((l) => `scan:${l}`));
    });
  }

  it('the panel\'s Look up on the items still works while the kit is in review', async () => {
    const w = await answered();
    await kitInReview(w);
    const parts = KIT_MODELS.map((model) => ({ brand: 'RYOBI', model }));
    const { budget } = paid(w, { reserve: 0, maxPerRun: 20 });
    expect(quotePaid({ kind: 'lookUp', parts }, await savedAnswers(w.store), budget).searches).toBe(SEARCHED_ITEMS.length);
    const before = w.ledger.length;
    await lookUp(w, KIT_MODELS);
    expect(w.ledger.slice(before)).toEqual([...SEARCHED_ITEMS].sort().map((m) => `panel:lookup:${m}`));
  });
});

describe('ordinary lookups and kit items in one scan', () => {
  it('with room left after the ordinary lookups, the same scan runs both, the ordinary first', async () => {
    const w = await twoBundles(await answered());
    await lookUp(w, ['PCL1600K2']);
    const s = await scan(w, DEFAULT_SETTINGS.searchesPerScan, STORED);
    expect(s.plan).toEqual(['lookup:P553', ...ITEM_PLAN]);
    expect(s.queue).toEqual(['lookup:P553', ...ITEM_PLAN.slice(0, 4)]);
    expect(s.spent).toEqual(['scan:lookup:P553', ...ITEM_PLAN.slice(0, 4).map((l) => `scan:${l}`)]);
  });

  it('a top-up from a step the cache answers (Ruling 48) reaches a deferred refresh before any item', async () => {
    const w = await twoBundles(await answered());
    // Both searches are saved now (the replay's cache holds them), so a refresh of either is answered free.
    await lookUp(w, ['PCL1600K2', 'P553']);
    // The owner chose P553's first listing, priced at T0.
    const q553 = (await w.store.getReview(`match:${partKey('RYOBI', 'P553')}`))!;
    await applyReviewAnswer(w.store, q553.id, { choice: 0, seen: reviewSignature(q553) }, T0);
    // Hand-made: the owner chose a listing for the kit too, and its last check did not see it (inactive).
    const asin = 'B0KITINACTIVE';
    await w.store.putMatch({
      key: partKey('RYOBI', 'PCL1600K2'), brand: 'RYOBI', model: 'PCL1600K2', status: 'matched', asin, grade: null, alternatives: [],
      decidedBy: 'user', updatedAt: T0, waitingSince: null,
    });
    await w.store.putPrice({ asin, price: 249, reviews: 10, seenAt: T0 - 24 * 60 * MINUTE, checkedAt: T0 });
    // Four days on, every price is stale. At a run limit of 1 the queue holds one refresh.
    const s = await scan(w, 1, STORED, T0 + 4 * 24 * 60 * MINUTE);
    const refreshes = ['refresh:P553', 'refresh:PCL1600K2'];
    expect([...s.queue, s.deferred[0]].sort()).toEqual(refreshes);
    expect(s.deferred.slice(1)).toEqual([...ITEM_PLAN, ...FREE_ITEMS.map((m) => `refresh:${m}`)]);
    // The queued refresh comes from the cache and gives its slot to the deferred refresh, also from the
    // cache, which gives it to the first item: the one search the scan pays for.
    expect(s.ran.slice(0, 2).sort()).toEqual(refreshes.map((r) => `scan:${r}`));
    expect(s.ran.slice(2)).toEqual(['scan:lookup:PBP002']);
    expect(s.spent).toEqual(['scan:lookup:PBP002']);
  });
});

// ---------------------------------------------------------------- Rulings 70 and 71, on the replay

/** PCL1201K2-PCL430B: in review in this world, its one reading PCL1201K2 + PCL430B. */
const PCL430B_BUNDLE = 'homedepot:324904496';
/** PCL1201K2-PCL515B: resolved in this world, so PCL515B is a part of a split. */
const PCL515B_BUNDLE = 'homedepot:324903619';

/** The owner answers PCL1201K2-PCL430B's split question with its one reading. */
async function answerPCL430B(w: World): Promise<void> {
  const id = `split:${PCL430B_BUNDLE}`;
  const q = (await w.store.getReview(id))!;
  expect(q.choices).toEqual([['PCL1201K2', 'PCL430B']]);
  await applyReviewAnswer(w.store, id, { choice: 0, seen: reviewSignature(q) }, T0);
}

/** The panel's quote for a Look up of these RYOBI models. Spends nothing. */
async function quoteFor(w: World, models: string[]) {
  const { budget } = paid(w, { reserve: 0, maxPerRun: 20 });
  return quotePaid({ kind: 'lookUp', parts: models.map((model) => ({ brand: 'RYOBI', model })) }, await savedAnswers(w.store), budget);
}

describe('Ruling 70: a RYOBI part and its tool-only form are one product, looked up once', () => {
  it('PCL515, an item of the kit, has the match of PCL515B, a part of PCL1201K2-PCL515B: one listing, no lookup', async () => {
    const w = await answered();
    expect((await w.store.getBundle(PCL515B_BUNDLE))!.split).toMatchObject({ status: 'resolved', components: ['PCL1201K2', 'PCL515B'] });
    const b = await w.store.getMatch(partKey('RYOBI', 'PCL515B'));
    expect(b).toMatchObject({ status: 'matched', asin: 'B0B88R7HWB', decidedBy: 'auto' });
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515'))).toMatchObject({ status: 'matched', asin: 'B0B88R7HWB', grade: b!.grade, decidedBy: 'auto' });
    expect(w.ledger.filter((l) => l.includes(':PCL515'))).toEqual([]);
  });

  it('the owner\'s choice for PCL430 stands for PCL430B: quote 0, nothing spent, never planned, and the answer is kept', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'P553', ...KIT_MODELS]);
    const id = `match:${partKey('RYOBI', 'PCL430')}`;
    const q = (await w.store.getReview(id))!;
    await applyReviewAnswer(w.store, id, { choice: 0, seen: reviewSignature(q) }, T0);
    const chosen = q.candidates[0]!.asin;
    await answerPCL430B(w);
    expect(await quoteFor(w, ['PCL430B'])).toEqual({ searches: 0, refusal: null });
    const before = w.ledger.length;
    await lookUp(w, ['PCL430B']);
    expect(w.ledger.slice(before)).toEqual([]);
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL430B'))).toMatchObject({ status: 'matched', asin: chosen, decidedBy: 'user' });
    expect(await w.store.getReview(id)).toMatchObject({ answer: chosen });
    const s = await scan(w, 20);
    expect(s.plan.filter((l) => l.includes('PCL430'))).toEqual([]);
    expect(s.spent.filter((l) => l.includes('PCL430'))).toEqual([]);
  });

  it('the owner\'s "None of these" for PCL430 stands for PCL430B too, and a scan plans no lookup for it', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'PCL430']);
    const id = `match:${partKey('RYOBI', 'PCL430')}`;
    await applyReviewAnswer(w.store, id, { none: true, seen: reviewSignature((await w.store.getReview(id))!) }, T0);
    await answerPCL430B(w);
    expect((await quoteFor(w, ['PCL430B'])).searches).toBe(0);
    const s = await scan(w, 20);
    expect(s.plan).not.toContain('lookup:PCL430B');
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL430B'))).toMatchObject({ status: 'none', asin: null, decidedBy: 'user' });
  });

  it('both forms wanted, neither looked up: one search in the quote, and one lookup in a scan\'s plan', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2']);
    await answerPCL430B(w);
    expect(await quoteFor(w, ['PCL430', 'PCL430B'])).toEqual({ searches: 1, refusal: null });
    // A scan plans PCL430B, a part of a split, with the ordinary lookups; the kit's item PCL430 is not planned.
    const plan = (await scan(w, 1)).plan;
    expect(plan).toContain('lookup:PCL430B');
    expect(plan).not.toContain('lookup:PCL430');
  });

  it('the panel\'s Look up of both forms spends one search, the first asked; the other takes its result, review included', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2']);
    await answerPCL430B(w);
    const before = w.ledger.length;
    await lookUp(w, ['PCL430', 'PCL430B']);
    expect(w.ledger.slice(before)).toEqual(['panel:lookup:PCL430']);
    // PCL430's search finds only listings in review (fix round 1, Important 2): PCL430B is in review with it, asking nothing of its own.
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL430'))).toMatchObject({ status: 'review', decidedBy: 'auto' });
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL430B'))).toMatchObject({ status: 'review', asin: null, decidedBy: 'auto' });
    expect(await w.store.getReview(`match:${partKey('RYOBI', 'PCL430B')}`)).toBeUndefined();
  });

  it('Important 2: PCL430 in automatic review stands for PCL430B: quote 0, no search, and one question in Review', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'PCL430']);
    await answerPCL430B(w);
    expect(await quoteFor(w, ['PCL430B'])).toEqual({ searches: 0, refusal: null });
    const before = w.ledger.length;
    await lookUp(w, ['PCL430B']);
    const s = await scan(w, 20);
    expect([...w.ledger.slice(before)].filter((l) => l.includes('PCL430'))).toEqual([]);
    expect(s.plan.filter((l) => l.includes('PCL430'))).toEqual([]);
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL430B'))).toMatchObject({ status: 'review', decidedBy: 'auto' });
    const review = (await buildReport(w.store, KITS)).review.filter((r) => r.kind === 'match').map((r) => r.model);
    expect(review.filter((m) => m.startsWith('PCL430'))).toEqual(['PCL430']);
  });

  it('Important 2: the question stays in Review while only its twin is held (the kit\'s page read again without PCL430)', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'PCL430']);
    await answerPCL430B(w);
    await lookUp(w, ['PCL430B']);
    await withoutPCL430(w);
    const review = (await buildReport(w.store, KITS)).review.filter((r) => r.kind === 'match').map((r) => r.model);
    expect(review).toContain('PCL430');
  });

  it('Important 1: the owner\'s answer on PCL430 replaces PCL430B\'s automatic record', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'PCL430']);
    await answerPCL430B(w);
    // Hand-made: PCL430B in automatic review, as a Look up of it writes it from PCL430's (Important 2).
    await w.store.putMatch({
      key: partKey('RYOBI', 'PCL430B'), brand: 'RYOBI', model: 'PCL430B', status: 'review', asin: null, grade: null, alternatives: [],
      decidedBy: 'auto', updatedAt: T0, waitingSince: null,
    });
    const id = `match:${partKey('RYOBI', 'PCL430')}`;
    const q = (await w.store.getReview(id))!;
    await applyReviewAnswer(w.store, id, { choice: 1, seen: reviewSignature(q) }, T0 + MINUTE);
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL430B'))).toMatchObject({
      status: 'matched', asin: q.candidates[1]!.asin, decidedBy: 'user', updatedAt: T0 + MINUTE,
    });
  });

  it('Important 1: an owner\'s own answer on the twin is never replaced by an answer on the other form', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'PCL430']);
    // Hand-made: the owner already said PCL430B has no listing.
    const mine = {
      key: partKey('RYOBI', 'PCL430B'), brand: 'RYOBI', model: 'PCL430B', status: 'none' as const, asin: null, grade: null, alternatives: [],
      decidedBy: 'user' as const, updatedAt: T0, waitingSince: null,
    };
    await w.store.putMatch(mine);
    const id = `match:${partKey('RYOBI', 'PCL430')}`;
    await applyReviewAnswer(w.store, id, { choice: 0, seen: reviewSignature((await w.store.getReview(id))!) }, T0 + MINUTE);
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL430B'))).toEqual(mine);
  });

  it('one refresh for the listing two forms share: PCL515B\'s, not PCL515\'s', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2']);
    const s = await scan(w, 1, KITS, T0 + 4 * 24 * 60 * MINUTE);
    expect(s.plan).toContain('refresh:PCL515B');
    expect(s.plan).not.toContain('refresh:PCL515');
  });
});

/**
 * Hand-made: the panel's Verify of `model`'s match B0B88R7HWB, answered by the recorded detail page of
 * B0B3JWF5ZV with its listing changed to B0B88R7HWB, `title`, and `details` as its part numbers. The
 * replay has no detail page for B0B88R7HWB. Everything else is replayed.
 */
async function verifyRecipSaw(w: World, model: string, title: string, details: Record<string, unknown>): Promise<void> {
  const page = structuredClone(recorded('amazon-product-B0B3JWF5ZV')) as Record<string, Record<string, unknown>>;
  page.product_results = { ...page.product_results, asin: 'B0B88R7HWB', title };
  page.product_details = details;
  page.item_specifications = {};
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.searchParams.get('engine') === 'amazon_product') return new Response(JSON.stringify(page), { status: 200 });
    return w.replay.fetchFn(input, init);
  }) as typeof fetch;
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 20 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn, now: () => T0, onSpend: (e) => void w.ledger.push(e.label) });
  await runPaid({ budget, client, store: w.store, now: () => T0 + MINUTE, settings: KITS }, { kind: 'verify', brand: 'RYOBI', model, asin: 'B0B88R7HWB' });
}

const SAW = 'ONE+ 18V Cordless Reciprocating Saw - 3,400 SPM Variable Speed, 1 in. Stroke Length, Tool Only (Battery Not Included) - PCL515B';

describe('fix round 1, Important 1: a Verify writes its outcome to the twin that holds the same listing', () => {
  it('a Verify that sends PCL515B to review (non-retail packaging) sends PCL515, matched to the same listing automatically, with it', async () => {
    const w = await answered();
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515'))).toMatchObject({ status: 'matched', asin: 'B0B88R7HWB', decidedBy: 'auto' });
    await verifyRecipSaw(w, 'PCL515B', `${SAW}, Bulk Packaged`, {});
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515B'))).toMatchObject({ status: 'review', asin: null });
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515'))).toMatchObject({ status: 'review', asin: null, decidedBy: 'auto', updatedAt: T0 + MINUTE });
    // One question, PCL515B's.
    expect(await w.store.getReview(`match:${partKey('RYOBI', 'PCL515')}`)).toBeUndefined();
    const row = (await buildReport(w.store, KITS)).bundles.find((b) => b.key === P553)!;
    expect(row.options.find((o) => o.id === 'split:PCL1600K2')!.parts.find((p) => p.model === 'PCL515')).toMatchObject({ status: 'review', availability: 'missing' });
  });

  it('fix round 2: no scan undoes it: two scans later both forms are still in review, the question open, nothing searched for them', async () => {
    const w = await answered();
    await verifyRecipSaw(w, 'PCL515B', `${SAW}, Bulk Packaged`, {});
    const id = `match:${partKey('RYOBI', 'PCL515B')}`;
    const question = await w.store.getReview(id);
    expect(question).toMatchObject({ answer: null, candidates: [{ asin: 'B0B88R7HWB' }] });
    for (let i = 0; i < 2; i++) {
      const s = await scan(w, 20, KITS);
      expect(s.ran.filter((l) => l.includes('PCL515'))).toEqual([]);
      for (const model of ['PCL515B', 'PCL515']) {
        expect(await w.store.getMatch(partKey('RYOBI', model))).toMatchObject({ status: 'review', asin: null, decidedBy: 'auto' });
      }
      expect(await w.store.getReview(id)).toEqual(question);
      expect(await w.store.getReview(`match:${partKey('RYOBI', 'PCL515')}`)).toBeUndefined();
    }
  });

  it('fix round 2: a listing a page rejected for PCL515B is never chosen for its twin from a search row', async () => {
    const w = await answered();
    await verifyRecipSaw(w, 'PCL515B', `${SAW}, Bulk Packaged`, {});
    // Hand-made: PCL515 holds an automatic "none" of its own, written from a search, which Ruling 73 judges again.
    const none = {
      key: partKey('RYOBI', 'PCL515'), brand: 'RYOBI', model: 'PCL515', status: 'none' as const, asin: null, grade: null, alternatives: [],
      decidedBy: 'auto' as const, updatedAt: T0, waitingSince: null,
    };
    await w.store.putMatch(none);
    await scan(w, 20, KITS);
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515'))).toEqual(none);
  });

  it('a Verify that finds the part number upgrades PCL515B to strong, and PCL515 with it', async () => {
    const w = await answered();
    await verifyRecipSaw(w, 'PCL515B', SAW, { manufacturer_part_number: 'PCL515B' });
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515B'))).toMatchObject({ status: 'matched', asin: 'B0B88R7HWB', grade: 'strong' });
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515'))).toMatchObject({ status: 'matched', asin: 'B0B88R7HWB', grade: 'strong', decidedBy: 'auto' });
  });

  it('the owner\'s own choice on the twin is never changed by a Verify of the other form', async () => {
    const w = await answered();
    // Hand-made: the owner chose B0B88R7HWB for PCL515 themselves.
    const mine = { ...(await w.store.getMatch(partKey('RYOBI', 'PCL515')))!, decidedBy: 'user' as const, grade: null };
    await w.store.putMatch(mine);
    await verifyRecipSaw(w, 'PCL515B', `${SAW}, Bulk Packaged`, {});
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL515'))).toEqual(mine);
  });
});

describe('Ruling 73: every scan judges automatic "none" and "review" again from saved listings, free', () => {
  /**
   * Hand-made: the records a lookup wrote before Ruling 70, in the replay world. PCL660's search
   * found no PCL660 in a title (none); PCL235's showed only brandless accessories (review, with its
   * question). The owner said none for PCL206 and chose a listing for PCL500.
   */
  async function before70(w: World): Promise<void> {
    const base = { brand: 'RYOBI', grade: null, alternatives: [], updatedAt: T0, waitingSince: null };
    await w.store.putMatch({ ...base, key: partKey('RYOBI', 'PCL660'), model: 'PCL660', status: 'none', asin: null, decidedBy: 'auto' });
    await w.store.putMatch({ ...base, key: partKey('RYOBI', 'PCL235'), model: 'PCL235', status: 'review', asin: null, decidedBy: 'auto' });
    const rows = parseAmazonSearch(recorded('amazon-search-PCL235'));
    const hardCase = rows.find((r) => r.asin === 'B0HFS4PFLN')!;
    await w.store.putReview({
      id: `match:${partKey('RYOBI', 'PCL235')}`, kind: 'match', subject: partKey('RYOBI', 'PCL235'), brand: 'RYOBI', model: 'PCL235', title: null,
      reason: '1 listing(s) show the model number, but the brand is not confirmed',
      candidates: [{ asin: hardCase.asin, title: hardCase.title, price: hardCase.price ?? null, reviews: hardCase.reviews ?? null, reasons: ['model number in the title, brand not confirmed'], seenAt: T0 }],
      choices: [], openedAt: T0, answer: null, answeredAt: null,
    });
    await w.store.putMatch({ ...base, key: partKey('RYOBI', 'PCL206'), model: 'PCL206', status: 'none', asin: null, decidedBy: 'user' });
    await w.store.putMatch({ ...base, key: partKey('RYOBI', 'PCL500'), model: 'PCL500', status: 'matched', asin: 'B0B1GKJXNB', decidedBy: 'user' });
  }

  it('PCL660\'s automatic none becomes B0B1GKJXNB, PCL235\'s question closes as B0BGYFTPGK, with 0 searches; the owner\'s answers stay', async () => {
    const w = await answered();
    await before70(w);
    const owner = [await w.store.getMatch(partKey('RYOBI', 'PCL206')), await w.store.getMatch(partKey('RYOBI', 'PCL500'))];
    const s = await scan(w, 1, STORED);
    expect(s.spent.filter((l) => /PCL(660|235)/.test(l))).toEqual([]);
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL660'))).toMatchObject({ status: 'matched', asin: 'B0B1GKJXNB', grade: 'probable', decidedBy: 'auto' });
    expect(await w.store.getMatch(partKey('RYOBI', 'PCL235'))).toMatchObject({ status: 'matched', asin: 'B0BGYFTPGK', decidedBy: 'auto' });
    expect(await w.store.getReview(`match:${partKey('RYOBI', 'PCL235')}`)).toMatchObject({ answer: 'resolved by a later scan', answeredAt: T0 + clock * MINUTE });
    expect([await w.store.getMatch(partKey('RYOBI', 'PCL206')), await w.store.getMatch(partKey('RYOBI', 'PCL500'))]).toEqual(owner);
    expect((await buildReport(w.store, KITS)).review.map((r) => r.model)).not.toContain('PCL235');
  });

  it('an automatic review no saved listing answers stays as it was: P553 keeps its question', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'P553']);
    const id = `match:${partKey('RYOBI', 'P553')}`;
    const q = await w.store.getReview(id);
    const m = await w.store.getMatch(partKey('RYOBI', 'P553'));
    await scan(w, 1, STORED);
    expect(await w.store.getReview(id)).toEqual(q);
    expect(await w.store.getMatch(partKey('RYOBI', 'P553'))).toEqual(m);
  });
});

describe('Ruling 71: the P553 question on the replay', () => {
  it('offers 5 listings, best first, and says that more were cut and that a title says Replacement', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'P553']);
    const q = (await w.store.getReview(`match:${partKey('RYOBI', 'P553')}`))!;
    expect(q.candidates.map((c) => [c.asin, c.reviews])).toEqual([
      ['B0DXK73C59', 1], ['B0GY3L2LFP', null], ['B0HP6GFW3H', null], ['B0HL81J9GN', null], ['B0HN1FZ74T', null],
    ]);
    expect(q.reason).toBe(
      '22 listing(s) show the model number, but the brand is not confirmed; title says Replacement or OEM, which often marks a spare part; 17 more listing(s) not shown',
    );
  });

  it('a question stored before the cap keeps its listings through a scan, and its answer still applies', async () => {
    const w = await answered();
    await lookUp(w, ['PCL1600K2', 'P553']);
    const id = `match:${partKey('RYOBI', 'P553')}`;
    const now = (await w.store.getReview(id))!;
    // Built from the recorded rows: the question as a lookup wrote it before Ruling 71, all 22 listings.
    const rows = parseAmazonSearch(recorded('amazon-search-P553'));
    const review = pick({ brand: 'RYOBI', model: 'P553' }, rows).review;
    const asins = [...new Set(review.map((g) => g.asin))];
    const old = {
      ...now, reason: '22 listing(s) show the model number, but the brand is not confirmed',
      candidates: asins.map((asin) => {
        const r = rows.find((x) => x.asin === asin)!;
        return { asin, title: r.title, price: r.price ?? null, reviews: r.reviews ?? null, reasons: review.find((g) => g.asin === asin)!.reasons, seenAt: T0 };
      }),
    };
    expect(old.candidates).toHaveLength(22);
    await w.store.putReview(old);
    await scan(w, 20);
    expect(await w.store.getReview(id)).toEqual(old);
    await applyReviewAnswer(w.store, id, { choice: 21, seen: reviewSignature(old) }, T0 + MINUTE);
    expect(await w.store.getMatch(partKey('RYOBI', 'P553'))).toMatchObject({ status: 'matched', asin: asins[21], decidedBy: 'user' });
  });
});

