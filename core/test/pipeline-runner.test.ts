// Step 11, P1: the scan's pipeline record, built by running the real runner over the replayed SerpApi responses (the
// ratchet bundle the eBay and part price tests use). Nothing reaches the network; the eBay port and the model are
// written here. The clock ticks, so the measured seconds are real numbers.

import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import type { EbayListing } from '../src/ebay/types';
import type { JudgeCall, ListingJudge } from '../src/judge/types';
import type { EbayPort } from '../src/scan/ebayPass';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { addSamples, estimate, type PipelineStep, pipelineView, samplesOf, STEP_IDS, type UnitRates } from '../src/scan/pipeline';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type PageOutcome, type PartPriceReading, type ReadPages, type ScanJob, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

const T0 = Date.UTC(2026, 10, 19, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

type Deps = Parameters<typeof runScan>[0];

/** Every call to the clock moves it a quarter of a second, so every timed unit has a measured duration. */
function ticking(stepMs = 250): () => number {
  let t = T0;
  return () => (t += stepMs);
}

async function world(opts: Partial<Deps> & { policy?: { reserve: number; maxPerRun: number } } = {}) {
  const store = new MemoryScanStore();
  const cache = new MemoryCache();
  const replay = replayRecorded();
  const now = ticking();
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), opts.policy ?? { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache, fetchFn: replay.fetchFn, now });
  const { policy: _p, ...rest } = opts;
  const job = await runScan({ client, budget, store, settings: RATCHET, now, ...rest });
  return { store, job, replay };
}

const notFound = (parts: { brand: string; model: string }[]): PartPriceReading[] =>
  parts.map((p) => ({ brand: p.brand, model: p.model, status: 'not_found', itemId: null, matchedModel: null, price: null, title: null, link: null }) as PartPriceReading);
const unreadable: ReadPages = async (ids) => ids.map((itemId): PageOutcome => ({ itemId, kind: 'unreadable' }));

const listing = (n: number): EbayListing => ({
  itemId: `v1|${n}|0`, title: `RYOBI PBLRC25B 18V ONE+ ratchet (${n})`, price: 40 + n, currency: 'USD', conditionId: '1000', categoryIds: [], aspects: [],
  descriptionText: 'New, in the box.', soldQuantity: 10 * n, url: `https://www.ebay.com/itm/${n}`,
});

/** An eBay port that finds `n` listings for each part; `onSearch` sees the job as the store has it when the call is made. */
function ebayWith(n: number, onSearch?: (query: string) => Promise<void>): EbayPort {
  return {
    async search(q) {
      await onSearch?.(q);
      const model = q.split(' ')[1]!;
      return { total: n, summaries: Array.from({ length: n }, (_, i) => ({ ...listing(i + 1), title: `RYOBI ${model} 18V ONE+ (${i + 1})` })) as never };
    },
    async getItem(itemId) {
      return listing(Number(itemId.split('|')[1]));
    },
  };
}

/** A judge that answers every listing "unsure" with the usage of a short call: only the money and the count matter here. */
const judgeOf = (model: string): ListingJudge => ({
  id: 'claude', model,
  async judge(): Promise<JudgeCall> {
    return { judgeId: 'claude', model, promptVersion: 'x', ok: false, notJudged: { reason: 'bad_response', message: 'test' }, usage: { inputTokens: 1700, outputTokens: 500 } } as JudgeCall;
  },
});

const byId = (job: ScanJob, id: string): PipelineStep => job.pipeline!.find((s) => s.id === id)!;
const states = (job: ScanJob): string[] => job.pipeline!.map((s) => `${s.id}:${s.state}`);

describe('the scan records its stages on the job', () => {
  it('a plain scan: the stages in run order, the pages it cannot read and the eBay step skipped with their reasons', async () => {
    const { job } = await world();
    expect(job.status).toBe('done');
    expect(job.pipeline!.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(states(job)).toEqual([
      'hdPages:done', 'bundlePages:skipped', 'kitPages:skipped', 'partPrices:skipped', 'ebay:skipped', 'judge:skipped', 'amazon:done', 'finish:done',
    ]);
    expect(byId(job, 'bundlePages').skippedReason).toBe('no page reader');
    expect(byId(job, 'partPrices').skippedReason).toBe('no price reader');
    expect(byId(job, 'ebay').skippedReason).toBe('not in this run');
    // The listing page and the lookups are searches; the searches the network answered are the job's searches.
    expect(byId(job, 'hdPages').unitsDone).toBe(1);
    expect(byId(job, 'hdPages').unitsTotal).toBe(1);
    expect(byId(job, 'hdPages').unitsMeasured).toBe(1);
    expect(byId(job, 'amazon').unitsMeasured).toBe(2);
    expect(byId(job, 'hdPages').unitsMeasured! + byId(job, 'amazon').unitsMeasured!).toBe(job.searchesUsed);
    expect(byId(job, 'amazon').unitsDone).toBe(job.counts.lookupsDone + job.counts.refreshesDone);
  });

  it('every skipped reason is four words or fewer', async () => {
    const runs = [await world(), await world({ ebay: { kind: 'skip', notice: 'n', missing: ['ebay', 'anthropic'] }, readPages: async () => { throw new Error('x'); } })];
    for (const { job } of runs) for (const s of job.pipeline!) if (s.skippedReason) expect(s.skippedReason.split(' ').length).toBeLessThanOrEqual(4);
  });

  it('with every reader and eBay: each stage ran, the pages are counted, and eBay and the listing check ran together', async () => {
    const { job } = await world({
      readPages: unreadable, readPartPrices: async (parts) => notFound(parts),
      ebay: { kind: 'run', ebay: ebayWith(2), judge: judgeOf('claude-haiku-5-5'), listingsJudgedPerScan: 60 },
    });
    // The ratchet has no kit, so the kit pages had nothing to read: skipped, "none found", not "done, 0 read".
    expect(states(job).filter((s) => !s.endsWith(':done'))).toEqual(['kitPages:skipped']);
    expect(byId(job, 'kitPages').skippedReason).toBe('none found');
    expect(byId(job, 'partPrices').unitsDone).toBe(job.counts.partPricesRead);
    expect(byId(job, 'partPrices').unitsDone).toBeGreaterThan(0);
    // Two parts: two searches and two item reads each, every one timed.
    expect(byId(job, 'ebay').unitsDone).toBe(job.counts.ebaySearches! + job.counts.ebayItemReads!);
    expect(byId(job, 'ebay').unitsMeasured).toBe(job.counts.ebaySearches! + job.counts.ebayItemReads!);
    // The model failed every call ("not judged"), so no call was timed; the cost is still what its tokens cost.
    expect(byId(job, 'judge').unitsDone).toBe(job.counts.listingsJudged);
    expect(byId(job, 'judge').model).toBe('claude-haiku-5-5');
    expect(byId(job, 'judge').costSoFar).toBeCloseTo((job.counts.judgeTokensIn! * 0.1 + job.counts.judgeTokensOut! * 0.5) / 1e6, 10);
    expect(byId(job, 'judge').costEstimate).toBeGreaterThan(0);
    // Every step that ran ended no earlier than it started.
    for (const s of job.pipeline!) if (s.state === 'done') expect(s.endedAt!).toBeGreaterThanOrEqual(s.startedAt!);
  });

  it('a missing key names the key that is missing, on the step it blocks and on the model step', async () => {
    const none = await world({ ebay: { kind: 'skip', notice: 'n', missing: ['ebay', 'anthropic'] } });
    expect([byId(none.job, 'ebay').skippedReason, byId(none.job, 'judge').skippedReason]).toEqual(['no eBay keys', 'no Anthropic key']);
    const noClaude = await world({ ebay: { kind: 'skip', notice: 'n', missing: ['anthropic'] } });
    expect([byId(noClaude.job, 'ebay').skippedReason, byId(noClaude.job, 'judge').skippedReason]).toEqual(['no Anthropic key', 'no Anthropic key']);
    const noEbay = await world({ ebay: { kind: 'skip', notice: 'n', missing: ['ebay'] } });
    expect([byId(noEbay.job, 'ebay').skippedReason, byId(noEbay.job, 'judge').skippedReason]).toEqual(['no eBay keys', 'no eBay keys']);
  });

  it('Home Depot refusing a page skips the kit pages and the part prices, and says so', async () => {
    const refuse: ReadPages = async (ids) => ids.map((itemId): PageOutcome => ({ itemId, kind: 'refused' }));
    const { job } = await world({ readPages: refuse, readPartPrices: async (parts) => notFound(parts) });
    expect(states(job).slice(0, 4)).toEqual(['hdPages:done', 'bundlePages:done', 'kitPages:skipped', 'partPrices:skipped']);
    expect(byId(job, 'kitPages').skippedReason).toBe('Home Depot refused');
    expect(byId(job, 'bundlePages').unitsDone).toBe(0);
  });

  it('a reader that throws skips the same steps with its own reason', async () => {
    const { job } = await world({ readPages: async () => { throw new Error('tab closed'); }, readPartPrices: async (parts) => notFound(parts) });
    expect(byId(job, 'bundlePages').state).toBe('done');
    expect(byId(job, 'kitPages').skippedReason).toBe('page reader failed');
  });

  it('a stop asked for at the start: the steps that did not run say "stopped" and the scan still ends in a record', async () => {
    const { job } = await world({ shouldStop: () => true, readPages: unreadable, readPartPrices: async (parts) => notFound(parts), ebay: { kind: 'run', ebay: ebayWith(1), judge: judgeOf('claude-haiku-5-5'), listingsJudgedPerScan: 60 } });
    expect(job.status).toBe('stopped');
    expect(job.stopReason).toBe('user');
    expect(states(job).every((s) => /:(done|skipped)$/.test(s))).toBe(true);
    expect(byId(job, 'amazon').skippedReason).toBe('stopped');
    expect(byId(job, 'ebay').skippedReason).toBe('stopped');
    expect(byId(job, 'finish').state).toBe('done');
  });

  it('a search limit: the lookups it left undone are skipped as "search limit"', async () => {
    // Room for the listing page and no lookup.
    const { job } = await world({ policy: { reserve: 0, maxPerRun: 1 } });
    expect(byId(job, 'hdPages').state).toBe('done');
    expect(byId(job, 'amazon').state).toBe('skipped');
    expect(byId(job, 'amazon').skippedReason).toBe('search limit');
  });

  it('a job saved without a record (an earlier build) is shown from its phase and counts, and gets a record when it is continued', async () => {
    const { job } = await world();
    const old = { ...job };
    delete old.pipeline;
    const view = pipelineView(old, {}, T0);
    expect(view.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done']);
  });
});

describe('the record mid-scan, as the panel reads it', () => {
  /** The job as the store holds it when the eBay port is called for the nth time. */
  async function snapshots(n: number, model: string) {
    const seen: ScanJob[] = [];
    let calls = 0;
    const holder: { store?: MemoryScanStore } = {};
    const store = new MemoryScanStore();
    holder.store = store;
    const ebay = ebayWith(3, async () => {
      calls += 1;
      if (calls === n) seen.push((await store.listScans())[0]!);
    });
    const cache = new MemoryCache();
    const replay = replayRecorded();
    const now = ticking();
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache, fetchFn: replay.fetchFn, now });
    await runScan({
      client, budget, store, settings: RATCHET, now, readPages: unreadable, readPartPrices: async (parts) => notFound(parts),
      ebay: { kind: 'run', ebay, judge: judgeOf(model), listingsJudgedPerScan: 60 },
    });
    return seen[0]!;
  }

  it('while the second part is searched: Home Depot done, the eBay step and the listing check going, the lookups not planned yet', async () => {
    const job = await snapshots(2, 'claude-opus-5-5');
    expect(job.status).toBe('running');
    expect(states(job)).toEqual([
      'hdPages:done', 'bundlePages:done', 'kitPages:skipped', 'partPrices:done', 'ebay:now', 'judge:now', 'amazon:next', 'finish:next',
    ]);
    // A model call measured at 30 s on an earlier scan: the three listings the second part is expected to keep make 90 s.
    const rates: UnitRates = { 'judgeCall:claude-opus-5-5': [30] };
    const view = pipelineView(job, rates, T0);
    expect(view.current.label).toBe('Checking eBay listings');
    expect(view.steps.map((s) => [s.label, s.state])).toEqual([
      ['Home Depot deals pages', 'done'], ['Bundle pages', 'done'], ['Kit pages', 'skipped'], ['Home Depot part prices', 'done'],
      ['eBay listings', 'now'], ['Listing check (Claude)', 'now'], ['Amazon lookups', 'next'], ['Finish', 'next'],
    ]);
    // The lookups are not planned until the free steps end, so what is left is a lower bound.
    expect(estimate(job, rates, T0).kind).toBe('atLeast');
    expect(view.estimateText).toBe('at least 2 min');
    // With nothing but the seeds the same job is a lower bound under a minute, which is not worth a number.
    expect(pipelineView(job, {}, T0).estimateText).toBe('estimating');
    expect(view.ariaValueText).toBe('Step 5 of 8, checking eBay listings, at least 2 minutes left');
    expect(view.stepsDone).toBe(4);
    expect(view.stepsTotal).toBe(8);
    expect(view.fraction).toBeGreaterThan(0);
    expect(view.fraction).toBeLessThan(1);
  });

  it('the figures: the eBay step counts calls out of a projected total, the listing check shows its cost so far or an estimate', async () => {
    const job = await snapshots(2, 'claude-opus-5-5');
    // Search 1 and its 3 reads are done, search 2 is being made: 5 calls counted; 3 reads follow.
    expect(byId(job, 'ebay').unitsDone).toBe(5);
    expect(byId(job, 'ebay').unitsTotal).toBe(8);
    const view = pipelineView(job, {}, T0);
    expect(view.current.count).toBe('5 of 8');
    const judge = view.steps.find((s) => s.label === 'Listing check (Claude)')!;
    expect(judge.state).toBe('now');
    expect(judge.figure).toMatch(/^\$\d+\.\d\d so far$/);
    const next = pipelineView({ ...job, pipeline: job.pipeline!.map((s) => (s.id === 'judge' ? { ...s, state: 'next', costSoFar: undefined } : s)) }, {}, T0);
    expect(next.steps.find((s) => s.label === 'Listing check (Claude)')!.figure).toMatch(/^est\. \$\d+\.\d\d$/);
  });

  it('measured seconds per unit come out of the finished job, one sample per timed step, and a rolling median takes them', async () => {
    const { job } = await world({ readPages: unreadable, readPartPrices: async (parts) => notFound(parts), ebay: { kind: 'run', ebay: ebayWith(2), judge: judgeOf('claude-haiku-5-5'), listingsJudgedPerScan: 60 } });
    const samples = samplesOf(job);
    const kinds = samples.map((s) => s.kind).sort();
    expect(kinds).toEqual(['ebayCall', 'hdPageRead', 'hdPageRead', 'serpapiSearch', 'serpapiSearch']);
    // The clock moves 250 ms each time it is read, so every timed unit took some time.
    for (const s of samples) expect(s.seconds).toBeGreaterThan(0);
    const rates: UnitRates = addSamples({}, samples);
    expect(rates.serpapiSearch).toHaveLength(2);
    expect(rates.ebayCall).toHaveLength(1);
    expect(estimate({ ...job, pipeline: job.pipeline!.map((s) => (s.id === 'finish' ? s : s)) }, rates, T0).kind).toBe('underMinute');
  });
});

// ---------------------------------------------------------------- UI review of P2, fixes 2 and 3
describe('steps with nothing to do, and the job saved as each step starts', () => {
  /** A store that keeps a copy of every job it is given, as the panel would have seen it. */
  class RecordingStore extends MemoryScanStore {
    saved: ScanJob[] = [];
    override async putScan(job: ScanJob) {
      this.saved.push(structuredClone(job));
      return super.putScan(job);
    }
  }

  async function recorded(opts: Partial<Deps> = {}, store = new RecordingStore()) {
    const now = ticking();
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now });
    store.saved = [];
    const job = await runScan({ client, budget, store, settings: RATCHET, now, ...opts });
    return { store, job, saved: store.saved.filter((j) => j.status === 'running') };
  }
  const readers = (): Partial<Deps> => ({ readPages: unreadable, readPartPrices: async (parts) => notFound(parts) });

  it('a step that had nothing to do says "none found", in the record and in the step list', async () => {
    const { job } = await recorded(readers());
    expect(byId(job, 'kitPages')).toMatchObject({ state: 'skipped', skippedReason: 'none found' });
    const kit = pipelineView(job, {}, T0).steps.find((s) => s.label === 'Kit pages')!;
    expect(kit).toEqual({ label: 'Kit pages', state: 'skipped', figure: 'none found' });
  });

  it('no step starts with nothing to do, in a first scan or in a second over the same store', async () => {
    const first = await recorded(readers());
    const second = await recorded(readers(), first.store);
    for (const { saved } of [first, second]) {
      // "0 of 0" never shows: a step with nothing queued is skipped instead of started.
      for (const j of saved) for (const s of j.pipeline!) if (s.state === 'now' && s.id !== 'finish') expect(s.unitsTotal, `${s.id} ${states(j)}`).not.toBe(0);
    }
    // The second scan has its pages and prices already: what it had nothing to do for says so.
    const done = states(second.job);
    for (const s of second.job.pipeline!) if (s.state === 'skipped') expect(s.skippedReason, s.id).not.toBe('');
    expect(done.at(-1)).toBe('finish:done');
  });

  it('each paid or read step is saved as it starts, with its count from 0', async () => {
    const { saved } = await recorded(readers());
    for (const id of ['hdPages', 'bundlePages', 'partPrices', 'amazon'] as const) {
      // The first time the panel sees the step going, nothing of it is done yet, and its count shows.
      const first = saved.find((j) => byId(j, id).state === 'now');
      expect(first, id).toBeDefined();
      expect(byId(first!, id).unitsDone, id).toBe(0);
      expect(byId(first!, id).unitsTotal, id).toBeGreaterThan(0);
      expect(pipelineView(first!, {}, T0).current.count, id).toBe(`0 of ${byId(first!, id).unitsTotal}`);
    }
  });

  it('the Amazon step is saved as started before its first search is sent', async () => {
    const store = new RecordingStore();
    let atFirstLookup: ScanJob | undefined;
    const replay = replayRecorded();
    const fetchFn: typeof replay.fetchFn = async (url, init) => {
      if (String(url).includes('engine=amazon') && !atFirstLookup) atFirstLookup = structuredClone((await store.listScans())[0]!);
      return replay.fetchFn(url, init);
    };
    const now = ticking();
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn, now });
    await runScan({ client, budget, store, settings: RATCHET, now, ...readers() });
    expect(byId(atFirstLookup!, 'amazon')).toMatchObject({ state: 'now', unitsDone: 0 });
    expect(pipelineView(atFirstLookup!, {}, T0).current).toEqual({ label: 'Looking up parts', count: `0 of ${byId(atFirstLookup!, 'amazon').unitsTotal}` });
  });
});
