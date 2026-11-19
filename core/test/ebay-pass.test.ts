// Step 10, Task 5: the scan's eBay step, on the recorded eBay responses (fixtures/ebay/validation-2026-11-19.json:
// the real searches and item reads for the validation set's parts). No network: eBay is a port serving the
// recording, and the judge's answers are written here. A "match" the code-side checks reject is stored unsure.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EbayAuthError, EbayForbiddenError, EbayRateLimitedError, EbayServerError } from '../src/ebay/client';
import type { EbayListing, EbayListingSummary } from '../src/ebay/types';
import { PROMPT_VERSION } from '../src/judge/prompt';
import type { JudgeCall, JudgeInput, JudgeRaw, ListingJudge, NotJudgedReason } from '../src/judge/types';
import { applyEbayAnswer, ebayLabelsOf } from '../src/scan/ebayAnswers';
import { type EbayPort, EBAY_ITEM_READS_MAX, EBAY_SEARCHES_MAX, runEbayPass } from '../src/scan/ebayPass';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { judgementKey, type EbayValueRecord, type ScanJob } from '../src/scan/types';

interface Recorded { total: number; summaries: EbayListingSummary[]; items: Record<string, EbayListing> }
const recording = JSON.parse(readFileSync(new URL('../../fixtures/ebay/validation-2026-11-19.json', import.meta.url), 'utf8')) as {
  parts: Record<string, Recorded>;
};

const DCF = { key: 'DEWALT:DCF921B', brand: 'DEWALT', model: 'DCF921B' };
const NOW = 1_700_000_000_000;

const job = (counts: ScanJob['counts'] = {} as ScanJob['counts']): ScanJob => ({
  id: '1', startedAt: 1, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'listing', queue: [], deferred: [],
  searchesUsed: 0, counts,
});

/** eBay as recorded: the part's search, and an item read for each listing the recording read. */
function port(over: { failSearch?: Error; failItem?: (id: string) => Error | null; empty?: boolean } = {}): EbayPort & { searches: { q: string; opts: unknown }[]; reads: string[] } {
  const searches: { q: string; opts: unknown }[] = [];
  const reads: string[] = [];
  return {
    searches,
    reads,
    async search(query, opts) {
      searches.push({ q: query, opts });
      if (over.failSearch) throw over.failSearch;
      const model = query.split(' ').slice(1).join(' ');
      const r = over.empty ? undefined : recording.parts[model];
      return { total: r?.total ?? 0, summaries: r?.summaries ?? [] };
    },
    async getItem(itemId) {
      reads.push(itemId);
      const err = over.failItem?.(itemId);
      if (err) throw err;
      for (const r of Object.values(recording.parts)) if (r.items[itemId]) return r.items[itemId]!;
      throw new Error(`no recorded item ${itemId}`);
    },
  };
}

/** A well-formed claim of a match: the listing's own title as identity and contents. */
const matchAnswer = (title: string): JudgeRaw => ({
  evidence: [{ claim: 'identity', quote: title }, { claim: 'contents', quote: title }],
  contentsMatch: true, quantity: 1, condition: 'new', extras: [], missing: [], reason: 'The title names the model.', verdict: 'match',
});
const unsureAnswer = (title: string): JudgeRaw => ({
  evidence: [{ claim: 'identity', quote: title }], contentsMatch: null, quantity: 1, condition: 'new', extras: [], missing: [],
  reason: 'The listing does not say what it includes.', verdict: 'unsure',
});

/** A judge that claims "match" on every listing, with a canned usage; `fail` makes chosen items not judged. */
function judge(over: { answer?: (input: JudgeInput) => JudgeRaw; fail?: (itemId: string) => NotJudgedReason | null; model?: string } = {}): ListingJudge & { calls: string[] } {
  const calls: string[] = [];
  const model = over.model ?? 'claude-haiku-5-5';
  return {
    id: 'claude', model, calls,
    async judge(input): Promise<JudgeCall> {
      calls.push(input.listing.itemId);
      const base = { judgeId: 'claude', model, promptVersion: PROMPT_VERSION };
      const reason = over.fail?.(input.listing.itemId);
      if (reason) return { ...base, ok: false, notJudged: { reason, message: 'A plain sentence.' } };
      const raw = (over.answer ?? ((i) => matchAnswer(i.listing.title)))(input);
      return { ...base, ok: true, answer: JSON.stringify(raw), usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
}

const run = async (o: {
  store?: MemoryScanStore; job?: ScanJob; parts?: { key: string; brand: string; model: string }[]; ebay?: EbayPort; judge?: ListingJudge; cap?: number; stopAfter?: number;
} = {}) => {
  const store = o.store ?? new MemoryScanStore();
  const j = o.job ?? job();
  let saved = 0;
  await runEbayPass({
    store, job: j, save: async () => { saved += 1; await store.putScan(j); }, parts: o.parts ?? [DCF], ebay: o.ebay ?? port(), judge: o.judge ?? judge(),
    listingsJudgedPerScan: o.cap ?? 60, now: () => NOW, shouldStop: () => false,
  });
  return { store, job: j, saved };
};

describe('the eBay step: DEWALT DCF921B on the real search', () => {
  it('searches New, fixed price, Power Tools, 200; reads the 8 listings the pre-filter keeps; stores a value from the verified matches that have sold', async () => {
    const e = port();
    const j = judge();
    const { store, job: after } = await run({ ebay: e, judge: j });
    expect(e.searches).toEqual([{ q: 'DEWALT DCF921B', opts: { categoryIds: ['3247'], conditionNew: true, fixedPrice: true, limit: 200 } }]);
    expect(e.reads).toHaveLength(8);
    expect(j.calls).toHaveLength(8);
    const r = (await store.getEbayValue(DCF.key))!;
    // The model said "match" on all eight. Three the code rejects: a "branded" brand, and item specifics naming DCF911B twice.
    expect(r.listings.map((l) => l.verdict)).toEqual(['match', 'match', 'match', 'match', 'match', 'unsure', 'unsure', 'unsure']);
    expect(r.listings[5]!.reasons).toContain('The brand is given as "branded", not DEWALT.');
    expect(r.listings[6]!.reasons).toContain('The listing details name DCF911B, a different model.');
    expect(r.value).toEqual({
      listings: 5, unitsSold: 345, low: 64.99, high: 137.99, medianPrice: 119.99,
      links: ['https://www.ebay.com/itm/356061995376', 'https://www.ebay.com/itm/306552991202', 'https://www.ebay.com/itm/137923389067'],
    });
    expect(r.complete).toBe(true);
    expect(r.notJudged).toBe(0);
    expect(r.checkedAt).toBe(NOW);
    expect(after.counts).toMatchObject({ ebaySearches: 1, ebayItemReads: 8, listingsJudged: 8, judgeTokensIn: 800, judgeTokensOut: 160 });
    expect(after.ebayNotice ?? null).toBeNull();
  });

  it('keeps the model\'s raw answer, and verifies it again on every read: a saved answer is never a saved verdict', async () => {
    const store = new MemoryScanStore();
    await run({ store });
    const saved = (await store.getJudgement(judgementKey('v1|840092869695|0', recording.parts.DCF921B!.items['v1|840092869695|0']!.revision, PROMPT_VERSION, 'claude-haiku-5-5', DCF.key)))!;
    expect(JSON.parse(saved.answer)).toMatchObject({ verdict: 'match' });
    expect(saved).toMatchObject({ model: 'claude-haiku-5-5', promptVersion: PROMPT_VERSION, part: DCF.key, usage: { inputTokens: 100, outputTokens: 20 }, judgedAt: NOW });
    // A second pass asks the model nothing, and reaches the same verdicts by verifying the saved answers.
    const j2 = judge();
    const again = await run({ store, judge: j2, job: job() });
    expect(j2.calls).toEqual([]);
    expect(again.job.counts.listingsJudged ?? 0).toBe(0);
    expect((await store.getEbayValue(DCF.key))!.listings.map((l) => l.verdict)).toEqual(['match', 'match', 'match', 'match', 'match', 'unsure', 'unsure', 'unsure']);
  });

  it('a saved answer that no longer verifies is read as what verification now says (the rules change without a prompt version)', async () => {
    const store = new MemoryScanStore();
    const item = recording.parts.DCF921B!.items['v1|356061995376|0']!;
    // Said "match" with a quote that is not in the listing: verification refuses it, whenever it was saved.
    await store.putJudgement({
      key: judgementKey(item.itemId, item.revision, PROMPT_VERSION, 'claude-haiku-5-5', DCF.key), itemId: item.itemId, revision: item.revision ?? '',
      promptVersion: PROMPT_VERSION, model: 'claude-haiku-5-5', part: DCF.key, usage: { inputTokens: 1, outputTokens: 1 }, judgedAt: 1,
      answer: JSON.stringify(matchAnswer('DEWALT DCF921B made-up title that is not in the listing')),
    });
    const j = judge();
    await run({ store, judge: j });
    expect(j.calls).not.toContain(item.itemId);
    const l = (await store.getEbayValue(DCF.key))!.listings.find((x) => x.itemId === item.itemId)!;
    expect(l.verdict).toBe('unsure');
    expect(l.reasons.join(' ')).toContain('is not found in the listing');
  });

  it('a judgement is kept per model: another model asks again', async () => {
    const store = new MemoryScanStore();
    await run({ store });
    const opus = judge({ model: 'claude-opus-5-5' });
    await run({ store, judge: opus, job: job() });
    expect(opus.calls).toHaveLength(8);
  });

  it('an unsure answer becomes an unsure listing that does not count', async () => {
    const { store } = await run({ judge: judge({ answer: (i) => unsureAnswer(i.listing.title) }) });
    const r = (await store.getEbayValue(DCF.key))!;
    expect(r.listings.every((l) => l.verdict === 'unsure')).toBe(true);
    expect(r.value).toBeNull();
  });

  it('a listing the call did not judge has no verdict and is not stored as a judgement: the part is asked for again next scan', async () => {
    const { store, job: after } = await run({ judge: judge({ fail: (id) => (id === 'v1|356061995376|0' ? 'server' : null) }) });
    const r = (await store.getEbayValue(DCF.key))!;
    expect(r.listings).toHaveLength(7);
    expect(r.listings.some((l) => l.itemId === 'v1|356061995376|0')).toBe(false);
    expect(r.notJudged).toBe(1);
    expect(r.complete).toBe(false);
    // The 253-unit listing is missing, so the value is the four that were judged.
    expect(r.value!.unitsSold).toBe(92);
    expect(await store.getJudgement(judgementKey('v1|356061995376|0', recording.parts.DCF921B!.items['v1|356061995376|0']!.revision, PROMPT_VERSION, 'claude-haiku-5-5', DCF.key))).toBeUndefined();
    expect(after.ebayNotice ?? null).toBeNull();
  });

  it('a judge that throws is a listing not judged, not a failed scan', async () => {
    const bad: ListingJudge = { id: 'claude', model: 'm', judge: () => Promise.reject(new Error('boom')) };
    const { store } = await run({ judge: bad });
    const r = (await store.getEbayValue(DCF.key));
    // Nothing was judged: the part keeps what it had, here nothing.
    expect(r).toBeUndefined();
  });

  it('an invalid key (401 or 403) stops the step with a plain notice and leaves the part as it was', async () => {
    const store = new MemoryScanStore();
    const earlier: EbayValueRecord = { key: DCF.key, brand: 'DEWALT', model: 'DCF921B', value: null, listings: [], notJudged: 0, complete: true, checkedAt: 5 };
    await store.putEbayValue(earlier);
    const e = port();
    const { job: after } = await run({ store, ebay: e, judge: judge({ fail: () => 'auth' }), parts: [DCF, { key: 'DEWALT:DCB205', brand: 'DEWALT', model: 'DCB205' }] });
    expect(after.ebayNotice).toBe('Claude did not accept the Anthropic key, so eBay listings were not judged. Check the key in Settings.');
    expect(await store.getEbayValue(DCF.key)).toEqual(earlier);
    // One call was made, and no search for the next part.
    expect(e.searches).toHaveLength(1);
    expect(after.counts.listingsJudged).toBe(1);
  });

  it('a rate limit (429) stops the step with a plain notice', async () => {
    const e = port();
    const { job: after } = await run({ ebay: e, judge: judge({ fail: () => 'rate_limited' }), parts: [DCF, { key: 'DEWALT:DCB205', brand: 'DEWALT', model: 'DCB205' }] });
    expect(after.ebayNotice).toBe("Claude's rate limit was reached, so the rest of the eBay listings wait for the next scan.");
    expect(e.searches).toHaveLength(1);
  });

  it('other failures of the model (overloaded, cut off, refused) skip the listing and go on', async () => {
    const j = judge({ fail: (id) => (id.includes('356061995376') ? 'overloaded' : id.includes('137923389067') ? 'max_tokens' : id.includes('306552991202') ? 'refusal' : null) });
    const { store } = await run({ judge: j });
    expect(j.calls).toHaveLength(8);
    expect((await store.getEbayValue(DCF.key))!.notJudged).toBe(3);
  });

  it('eBay refusing the keys, or limiting calls, stops the step with a plain notice', async () => {
    const auth = await run({ ebay: port({ failSearch: new EbayAuthError('refused', 401) }) });
    expect(auth.job.ebayNotice).toBe('eBay did not accept the App ID and Cert ID, so eBay reference values were not checked. Check them in Settings.');
    const forbidden = await run({ ebay: port({ failSearch: new EbayForbiddenError('no') }) });
    expect(forbidden.job.ebayNotice).toBe('eBay says these keys may not make this call, so eBay reference values were not checked.');
    const limited = await run({ ebay: port({ failItem: () => new EbayRateLimitedError('slow') }) });
    expect(limited.job.ebayNotice).toBe('eBay is limiting calls, so the rest of the eBay reference values wait for the next scan.');
    expect(await limited.store.getEbayValue(DCF.key)).toBeUndefined();
  });

  it('an eBay server error on one part leaves it for the next scan and the step goes on', async () => {
    const e = port({ failSearch: undefined });
    const flaky: EbayPort = { ...e, search: async (q, o) => { if (q.includes('DCF921B')) throw new EbayServerError('down', 503); return e.search(q, o); }, getItem: e.getItem };
    const parts = [DCF, { key: 'DEWALT:DCS391B', brand: 'DEWALT', model: 'DCS391B' }];
    const { store, job: after } = await run({ ebay: flaky, parts });
    expect(await store.getEbayValue(DCF.key)).toBeUndefined();
    expect(await store.getEbayValue('DEWALT:DCS391B')).toBeDefined();
    expect(after.ebayNotice ?? null).toBeNull();
  });

  it('a limit of listings judged stops asking the model, says so, and leaves the rest for the next scan, which asks only for them', async () => {
    const store = new MemoryScanStore();
    const j1 = judge();
    const first = await run({ store, judge: j1, cap: 3 });
    expect(j1.calls).toHaveLength(3);
    expect(first.job.counts.listingsJudged).toBe(3);
    expect(first.job.ebayNotice).toBe('The limit of 3 listings judged a scan was reached. The rest wait for the next scan.');
    const partial = (await store.getEbayValue(DCF.key))!;
    expect(partial.listings).toHaveLength(3);
    expect(partial.notJudged).toBe(5);
    expect(partial.complete).toBe(false);

    const j2 = judge();
    const second = await run({ store, judge: j2, job: job() });
    expect(j2.calls).toHaveLength(5);
    expect(second.job.ebayNotice ?? null).toBeNull();
    expect((await store.getEbayValue(DCF.key))!.complete).toBe(true);
    expect((await store.getEbayValue(DCF.key))!.listings).toHaveLength(8);
  });

  it('the caps count across a continued job: 40 searches and 300 item reads a scan', async () => {
    const searched = await run({ job: job({ ebaySearches: EBAY_SEARCHES_MAX } as ScanJob['counts']), ebay: port() });
    expect(searched.job.counts.ebaySearches).toBe(EBAY_SEARCHES_MAX);
    expect(searched.job.ebayNotice).toBe('The limit of 40 eBay searches a scan was reached. The rest wait for the next scan.');
    expect(await searched.store.getEbayValue(DCF.key)).toBeUndefined();

    const e = port();
    const read = await run({ job: job({ ebayItemReads: EBAY_ITEM_READS_MAX - 1 } as ScanJob['counts']), ebay: e });
    expect(e.reads).toHaveLength(1);
    expect(read.job.ebayNotice).toBe('The limit of 300 eBay listing reads a scan was reached. The rest wait for the next scan.');
    expect((await read.store.getEbayValue(DCF.key))!.complete).toBe(false);
  });

  it('forty searches over forty-one parts: the forty-first waits', async () => {
    const parts = Array.from({ length: 41 }, (_, i) => ({ key: `DEWALT:DCX${i}`, brand: 'DEWALT', model: `DCX${i}` }));
    const e = port({ empty: true });
    const { job: after, store } = await run({ parts, ebay: e });
    expect(e.searches).toHaveLength(40);
    expect(after.counts.ebaySearches).toBe(40);
    expect(await store.getEbayValue('DEWALT:DCX39')).toBeDefined();
    expect(await store.getEbayValue('DEWALT:DCX40')).toBeUndefined();
  });

  it('a part with no listing that passes the pre-filter has a record with no value (never $0), and is checked again only when it is stale', async () => {
    const { store } = await run({ parts: [{ key: 'DEWALT:DCK420D2', brand: 'DEWALT', model: 'DCK420D2' }] });
    expect(await store.getEbayValue('DEWALT:DCK420D2')).toMatchObject({ value: null, listings: [], notJudged: 0, complete: true });
  });

  it('the owner\'s answer is its own record and stays on a listing through a new check, even one that stops partway', async () => {
    const store = new MemoryScanStore();
    await run({ store });
    const unsure = (await store.getEbayValue(DCF.key))!.listings.find((l) => l.itemId === 'v1|840092869695|0')!;
    expect(unsure.verdict).toBe('unsure');
    const before = (await store.getEbayValue(DCF.key))!.value!;
    await applyEbayAnswer(store, { key: DCF.key, itemId: unsure.itemId, answer: 'yes' }, 99);
    const answered = (await store.getEbayValue(DCF.key))!.value!;
    expect(answered.listings).toBe(before.listings + 1);
    expect(answered.unitsSold).toBe(before.unitsSold + 4);

    // A check with another model asks everything again; the model is limited at its third call.
    // The listings it did not reach are carried from the last check, and the answer, the value and the label stand.
    const opus = judge({ model: 'claude-opus-5-5', fail: (id) => (id === 'v1|306552991202|0' ? 'rate_limited' : null) });
    const second = await run({ store, judge: opus, job: job() });
    expect(second.job.ebayNotice).toBe("Claude's rate limit was reached, so the rest of the eBay listings wait for the next scan.");
    expect(opus.calls).toHaveLength(3);
    const r = (await store.getEbayValue(DCF.key))!;
    expect(r.complete).toBe(false);
    expect(r.listings).toHaveLength(8);
    expect(r.listings.find((l) => l.itemId === unsure.itemId)).toMatchObject({ verdict: 'unsure', owner: 'match', ownerAt: 99 });
    expect(r.value).toEqual(answered);
    expect(ebayLabelsOf(await store.listEbayAnswers())).toEqual([
      expect.objectContaining({ itemId: unsure.itemId, model: 'DCF921B', verdict: 'match', labelledBy: 'owner', judged: 'unsure', answeredAt: 99 }),
    ]);
  });

  it('an answer given for a listing\'s revision does not hold for another', async () => {
    const store = new MemoryScanStore();
    await run({ store });
    const item = recording.parts.DCF921B!.items['v1|840092869695|0']!;
    await applyEbayAnswer(store, { key: DCF.key, itemId: item.itemId, answer: 'yes' }, 1);
    const base = port();
    const changed: EbayPort = { search: base.search, getItem: async (id) => (id === item.itemId ? { ...item, revision: 'newer' } : base.getItem(id)) };
    await run({ store, ebay: changed, job: job() });
    const l = (await store.getEbayValue(DCF.key))!.listings.find((x) => x.itemId === item.itemId)!;
    expect(l).toMatchObject({ revision: 'newer', verdict: 'unsure' });
    expect(l.owner).toBeUndefined();
  });

  it('a part\'s name is part of the saved answer\'s key: a changed name asks the model again', async () => {
    const store = new MemoryScanStore();
    await run({ store });
    await store.putCatalogEntry({ key: DCF.key, brand: 'DEWALT', model: 'DCF921B', title: 'A new name for the part', kinds: [], isKit: false, upc: null, seenAt: 1 });
    const j = judge();
    await run({ store, judge: j, job: job() });
    expect(j.calls).toHaveLength(8);
  });

  it('a model call is given an abort signal that ends it at the timeout: not judged, never a verdict', async () => {
    const hang: ListingJudge = {
      id: 'claude', model: 'claude-haiku-5-5',
      judge: (_i, signal) => new Promise<JudgeCall>((resolve) => signal?.addEventListener('abort', () => resolve({ judgeId: 'claude', model: 'claude-haiku-5-5', promptVersion: PROMPT_VERSION, ok: false, notJudged: { reason: 'aborted', message: 'cancelled' } }))),
    };
    const store = new MemoryScanStore();
    const j = job();
    await runEbayPass({ store, job: j, save: async () => {}, parts: [DCF], ebay: port(), judge: hang, listingsJudgedPerScan: 60, now: () => NOW, shouldStop: () => false, callTimeoutMs: 5 });
    expect(await store.getEbayValue(DCF.key)).toBeUndefined();
    expect(j.counts.listingsJudged).toBe(8);
  });

  it('a stop aborts the model call in flight', async () => {
    const stop = new AbortController();
    const seen: AbortSignal[] = [];
    const hang: ListingJudge = {
      id: 'claude', model: 'claude-haiku-5-5',
      judge: (_i, signal) => new Promise<JudgeCall>((resolve) => {
        seen.push(signal!);
        signal!.addEventListener('abort', () => resolve({ judgeId: 'claude', model: 'claude-haiku-5-5', promptVersion: PROMPT_VERSION, ok: false, notJudged: { reason: 'aborted', message: 'cancelled' } }));
        setTimeout(() => stop.abort(), 1);
      }),
    };
    const j = job();
    await runEbayPass({ store: new MemoryScanStore(), job: j, save: async () => {}, parts: [DCF], ebay: port(), judge: hang, listingsJudgedPerScan: 60, now: () => NOW, shouldStop: () => stop.signal.aborted, signal: stop.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(true);
  });

  it('a 400 from the model (unknown model, no credit) stops the step with a plain notice', async () => {
    const e = port();
    const { job: after } = await run({ ebay: e, judge: judge({ fail: () => 'bad_request' }), parts: [DCF, { key: 'DEWALT:DCB205', brand: 'DEWALT', model: 'DCB205' }] });
    expect(after.ebayNotice).toBe('Claude refused the request (an unknown model, no credit or a bad request), so eBay listings were not judged. Check the model and your Anthropic account.');
    expect(e.searches).toHaveLength(1);
  });

  it('saves the job after every call, so a count is kept if the worker is evicted in the middle', async () => {
    const store = new MemoryScanStore();
    const j = job();
    const seen: number[] = [];
    await runEbayPass({
      store, job: j, save: async () => void seen.push((j.counts.ebaySearches ?? 0) * 1000 + (j.counts.ebayItemReads ?? 0) * 10 + (j.counts.listingsJudged ?? 0)),
      parts: [DCF], ebay: port(), judge: judge(), listingsJudgedPerScan: 60, now: () => NOW, shouldStop: () => false,
    });
    // One save for the search, then for each of the 8 listings one for the read and one for the model call (and its tokens).
    expect(seen.length).toBeGreaterThanOrEqual(1 + 8 * 2);
    expect(seen[0]).toBe(1000);
    expect(seen).toContain(1000 + 8 * 10 + 7);
  });

  it('a stop asked for ends the step without a search', async () => {
    const store = new MemoryScanStore();
    const e = port();
    await runEbayPass({ store, job: job(), save: async () => {}, parts: [DCF], ebay: e, judge: judge(), listingsJudgedPerScan: 60, now: () => NOW, shouldStop: () => true });
    expect(e.searches).toEqual([]);
  });

  it('sends the model the part\'s name from the catalog and the RYOBI twin; nothing of a seller', async () => {
    const store = new MemoryScanStore();
    await store.putCatalogEntry({
      key: 'RYOBI:PCL500B', brand: 'RYOBI', model: 'PCL500B', title: 'ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only)', kinds: [], isKit: false, upc: null, seenAt: 1,
    });
    const seen: JudgeInput[] = [];
    const spy = judge({ answer: (i) => { seen.push(i); return unsureAnswer(i.listing.title); } });
    await run({ store, judge: spy, parts: [{ key: 'RYOBI:PCL500B', brand: 'RYOBI', model: 'PCL500B' }] });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.part).toEqual({ brand: 'RYOBI', model: 'PCL500B', twin: 'PCL500', title: 'ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only)' });
    expect(JSON.stringify(seen)).not.toMatch(/seller|feedback/i);
  });
});
