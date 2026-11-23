import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MemoryScanStore } from '@core/scan/memoryStore';
import { partKey, type CatalogRecord } from '@core/scan/types';
import type { ResearchTools } from '@core/research/types';
import { doorwayStateInTab, fetchPagesInTab, fetchPathInTab, type DoorwayState, type InTabResult, type ReaderEnv } from './hdReader';
import {
  createQuestionBudget, createResearchTools, homeDepotItemId, QUESTION_TOOL_LIMIT,
  type SearchPageResult, type SearchRow,
} from './researchTools';

const pages = (JSON.parse(readFileSync('fixtures/homedepot-pages/pages-2026-11-10.json', 'utf8')) as { pages: InTabResult[] }).pages;
const byId = new Map(pages.map((p) => [p.itemId, p]));
const ids = pages.map((p) => p.itemId);
const research = JSON.parse(readFileSync('fixtures/homedepot-pages/research-2026-11-20.json', 'utf8')) as {
  pages: Record<string, unknown>;
  searches: Record<string, { state: unknown }>;
};
const PAGE = '328814689'; // RYOBI PBLRC2501SB, a recorded 2-tool page

interface Fake { env: ReaderEnv; log: string[]; setNow(ms: number): void; now: () => number }

function fake(opts: {
  page?: (id: string) => InTabResult;
  search?: (query: string) => SearchPageResult;
  loadFails?: boolean;
  stored?: number | null;
  /** The doorway tab's own document at each check (default: its state is there). */
  doorway?: () => DoorwayState;
} = {}): Fake {
  const log: string[] = [];
  let stored: number | null = opts.stored ?? null;
  let t = 0;
  const page = opts.page ?? ((id) => byId.get(id) ?? { itemId: id, status: 404, text: null });
  const env: ReaderEnv = {
    origin: 'https://www.homedepot.com',
    openTab: async (url) => { log.push(`open ${url}`); return 7; },
    closeTab: async (id) => { log.push(`close ${id}`); },
    waitForLoad: async () => {
      log.push('wait');
      if (opts.loadFails) throw new Error('timeout');
    },
    runInTab: (async (_tab: number, func: unknown, args: unknown[]) => {
      if (func === fetchPagesInTab) {
        log.push(`fetch page ${(args[0] as string[]).join(',')}`);
        return (args[0] as string[]).map(page);
      }
      if (func === doorwayStateInTab) return opts.doorway ? opts.doorway() : { state: true, title: 'Home Depot' };
      if (func === fetchPathInTab) {
        const query = decodeURIComponent((args[0] as string).replace(/^\/s\//, ''));
        log.push(`fetch search ${query}`);
        return (opts.search ?? (() => ({ status: 200, text: '<html></html>' })))(query);
      }
      throw new Error('unexpected function');
    }) as ReaderEnv['runInTab'],
    remember: async (id) => { stored = id; },
    remembered: async () => stored,
    sleep: async (ms) => { log.push(`sleep ${ms}`); t += ms; },
  };
  return { env, log, setNow: (ms) => { t = ms; }, now: () => t };
}

const record = (brand: string, model: string, title: string, over: Partial<CatalogRecord> = {}): CatalogRecord => ({
  key: partKey(brand, model), brand, model, title, kinds: [], isKit: false, upc: null, seenAt: 0, ...over,
});

async function tools(f: Fake, over: Partial<Parameters<typeof createResearchTools>[0]> = {}) {
  const store = new MemoryScanStore();
  await store.putCatalogEntry(record('RYOBI', 'PCL206B', 'ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only)', { kinds: ['drill'] }));
  await store.putCatalogEntry(record('RYOBI', 'PCL1600K2', 'ONE+ 18V Cordless 6-Tool Combo Kit', { isKit: true }));
  await store.putCatalogEntry(record('DEWALT', 'DCD791B', '20V MAX XR Brushless 1/2 in. Drill/Driver (Tool Only)', { kinds: ['drill'] }));
  await store.putCatalogEntry(record('DEWALT', 'DCB205', '20V MAX 5Ah Battery', { kinds: ['battery'] }));
  return createResearchTools({ env: f.env, store, settleMs: 2500, pauseMs: 1000, now: f.now, ...over });
}

describe('the research contract', () => {
  it("a question's tools are the loop's ResearchTools (compile-time), and a stopped signal makes no request", async () => {
    const f = fake();
    const q = (await tools(f, { parseSearch: () => [] })).forQuestion();
    const asContract: ResearchTools = q;
    const stopped = AbortSignal.abort();
    expect(await asContract.readHomeDepotPage({ itemId: PAGE }, stopped)).toEqual({ error: 'stopped' });
    expect(await asContract.searchHomeDepot({ query: 'drill' }, stopped)).toEqual({ error: 'stopped' });
    expect(f.log).toEqual([]);
    expect(q.budget.used()).toBe(0);
  });
});

describe('homeDepotItemId', () => {
  it('reads the item id from an item id, a product address or a bare /p/ address, on homedepot.com only', () => {
    expect(homeDepotItemId({ itemId: '328814689' })).toBe('328814689');
    expect(homeDepotItemId({ itemId: ' 328814689 ' })).toBe('328814689');
    expect(homeDepotItemId({ url: 'https://www.homedepot.com/p/RYOBI-ONE-18V-PBLRC2501SB/328814689' })).toBe('328814689');
    expect(homeDepotItemId({ url: 'https://www.homedepot.com/p/328814689?x=1#y' })).toBe('328814689');
    expect(homeDepotItemId({ url: 'https://homedepot.com/p/a-b/328814689/' })).toBe('328814689');
    for (const url of [
      'https://www.amazon.com/dp/B0ABC12345',
      'https://www.homedepot.com.evil.com/p/x/328814689',
      'https://evil.com/www.homedepot.com/p/x/328814689',
      'https://user@evil.com/p/x/328814689',
      'http://www.homedepot.com/p/x/328814689',
      'https://www.homedepot.com/s/drill',
      'https://www.homedepot.com/p/x/12345',
      'not a url',
      '',
    ]) expect(homeDepotItemId({ url }), url).toBeNull();
    expect(homeDepotItemId({ itemId: '12345' })).toBeNull();
    expect(homeDepotItemId({ itemId: '328814689; DROP' })).toBeNull();
    expect(homeDepotItemId({})).toBeNull();
  });
});

describe('createQuestionBudget', () => {
  it('allows six, refuses the seventh, and counts what it allowed', () => {
    expect(QUESTION_TOOL_LIMIT).toBe(6);
    const b = createQuestionBudget();
    for (let i = 0; i < 6; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.used()).toBe(6);
    expect(b.limit).toBe(6);
  });
});

describe('readHomeDepotPage', () => {
  it('reads a recorded page by item id in the doorway tab and returns its sections with a labelled source', async () => {
    const f = fake();
    const q = (await tools(f)).forQuestion();
    const out = await q.readHomeDepotPage({ itemId: PAGE });
    expect(out).toEqual({
      sourceId: `hd-page:${PAGE}`,
      label: 'Home Depot page',
      url: `https://www.homedepot.com/p/${PAGE}`,
      sections: {
        title: 'ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
        model: 'PBLRC2501SB',
        bullets: expect.any(Array),
        description: expect.stringContaining('2-Tool Combo Kit'),
        specifications: [],
      },
    });
    expect(f.log).toEqual([`open https://www.homedepot.com/p/${PAGE}`, 'wait', 'sleep 2500', `fetch page ${PAGE}`, 'close 7']);
  });

  it('reads the specifications of a recorded page: PCL500525SB is two tools, tools only, no battery or charger', async () => {
    const f = fake({ page: (id) => ({ itemId: id, status: 200, text: `window.__APOLLO_STATE__=${JSON.stringify(research.pages[id])}` }) });
    const out = (await (await tools(f)).forQuestion().readHomeDepotPage({ itemId: '328690510' })) as { sections: { model: string; specifications: { name: string; value: string }[] } };
    expect(out.sections.model).toBe('PCL500525SB');
    const spec = (name: string) => out.sections.specifications.find((s) => s.name === name)?.value;
    expect(spec('Tools Included')).toBe('Circular Saw,Jig Saw');
    expect(spec('Number of Total Batteries Included')).toBe('0');
    expect(spec('Charger Included')).toBe('Charger Not Included');
  });

  it('reads a page named by a product address', async () => {
    const f = fake();
    const out = await (await tools(f)).forQuestion().readHomeDepotPage({ url: `https://www.homedepot.com/p/RYOBI-Ratchets/${PAGE}` });
    expect(out).toMatchObject({ sourceId: `hd-page:${PAGE}`, label: 'Home Depot page' });
  });

  it('refuses a page that is not on homedepot.com without opening a tab or spending the budget', async () => {
    const f = fake();
    const q = (await tools(f)).forQuestion();
    expect(await q.readHomeDepotPage({ url: 'https://www.amazon.com/dp/B0ABC12345' })).toEqual({ error: expect.stringContaining('homedepot.com') });
    expect(await q.readHomeDepotPage({})).toEqual({ error: expect.any(String) });
    expect(f.log).toEqual([]);
    expect(q.budget.used()).toBe(0);
  });

  it('reads at most six pages and searches a question, then answers limit with no tab', async () => {
    const f = fake();
    const t = await tools(f, { parseSearch: () => [] });
    const q = t.forQuestion();
    for (const id of ids.slice(0, 4)) expect(await q.readHomeDepotPage({ itemId: id })).toHaveProperty('sections');
    expect(await q.searchHomeDepot({ query: 'ryobi drill' })).toHaveProperty('results');
    expect(await q.readHomeDepotPage({ itemId: ids[4] })).toHaveProperty('sections');
    f.log.length = 0;
    expect(await q.readHomeDepotPage({ itemId: ids[5] })).toEqual({ error: 'limit' });
    expect(await q.searchHomeDepot({ query: 'ryobi saw' })).toEqual({ error: 'limit' });
    expect(f.log).toEqual([]);
    // The catalog is local and free.
    expect(await q.catalogLookup({ model: 'PCL206B' })).toHaveProperty('entries');
    // A new question has its own six.
    expect(await t.forQuestion().readHomeDepotPage({ itemId: ids[5] })).toHaveProperty('sections');
  });

  it('shares one budget object between tool sets when it is handed in', async () => {
    const f = fake();
    const t = await tools(f);
    const budget = createQuestionBudget(1);
    const a = t.forQuestion(budget);
    const b = t.forQuestion(budget);
    expect(await a.readHomeDepotPage({ itemId: PAGE })).toHaveProperty('sections');
    expect(await b.readHomeDepotPage({ itemId: PAGE })).toEqual({ error: 'limit' });
  });

  it('names a refusal, makes no further request for the question, and leaves the doorway closed', async () => {
    const f = fake({ page: (id) => ({ itemId: id, status: 403, text: null }) });
    const q = (await tools(f)).forQuestion();
    expect(await q.readHomeDepotPage({ itemId: PAGE })).toEqual({ error: expect.stringContaining('HTTP 403') });
    expect(f.log.at(-1)).toBe('close 7');
    f.log.length = 0;
    expect(await q.readHomeDepotPage({ itemId: ids[1] })).toEqual({ error: expect.stringContaining('refused') });
    expect(await q.searchHomeDepot({ query: 'ryobi drill' })).toEqual({ error: expect.stringContaining('refused') });
    expect(f.log).toEqual([]);
  });

  it('says a page does not exist for a 404, and goes on', async () => {
    const f = fake();
    const q = (await tools(f)).forQuestion();
    expect(await q.readHomeDepotPage({ itemId: '999999999' })).toEqual({ error: expect.stringContaining('no page') });
    expect(await q.readHomeDepotPage({ itemId: PAGE })).toHaveProperty('sections');
  });

  it('reports a 200 page with no data as unreadable (not a refusal), and a page it cannot parse as unreadable', async () => {
    const empty = fake({ page: (id) => ({ itemId: id, status: 200, text: null, note: 'Home Depot' }) });
    const one = (await tools(empty)).forQuestion();
    expect(await one.readHomeDepotPage({ itemId: PAGE })).toEqual({ error: `The page for item ${PAGE} came back without its data, titled "Home Depot".` });
    // Not a refusal: the next page is read (here it is the same fake, so it is unreadable again, and two in a row end the question's reads).
    expect(await one.readHomeDepotPage({ itemId: ids[1] })).toEqual({ error: expect.stringContaining('without its data') });
    expect(await one.readHomeDepotPage({ itemId: ids[2] })).toEqual({ error: 'Home Depot answered two requests in a row without their data; no more are made for this question.' });
    const odd = fake({ page: (id) => ({ itemId: id, status: 200, text: 'window.__APOLLO_STATE__={"ROOT_QUERY":{}}' }) });
    expect(await (await tools(odd)).forQuestion().readHomeDepotPage({ itemId: PAGE })).toEqual({ error: expect.stringContaining('could not be read') });
  });

  it('answers with an error, never a throw, when the tab does not load, and still closes it', async () => {
    const f = fake({ loadFails: true });
    expect(await (await tools(f)).forQuestion().readHomeDepotPage({ itemId: PAGE })).toEqual({ error: expect.stringContaining('did not load') });
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('closes a doorway a stopped worker left, before opening its own', async () => {
    const f = fake({ stored: 4 });
    await (await tools(f)).forQuestion().readHomeDepotPage({ itemId: PAGE });
    expect(f.log[0]).toBe('close 4');
  });

  it('pauses before a call that starts within a second of the last one, only for what is left', async () => {
    const f = fake();
    const t = await tools(f);
    const q = t.forQuestion();
    await q.readHomeDepotPage({ itemId: ids[0] });
    f.log.length = 0;
    f.setNow(f.now() + 400);
    await q.readHomeDepotPage({ itemId: ids[1] });
    expect(f.log[0]).toBe('sleep 600');
  });

  it('runs two calls made at once one after the other, never two doorways', async () => {
    const f = fake();
    const q = (await tools(f)).forQuestion();
    await Promise.all([q.readHomeDepotPage({ itemId: ids[0] }), q.readHomeDepotPage({ itemId: ids[1] })]);
    const opens = f.log.map((l, i) => (l.startsWith('open') ? i : -1)).filter((i) => i >= 0);
    const closes = f.log.map((l, i) => (l.startsWith('close') ? i : -1)).filter((i) => i >= 0);
    expect(opens).toHaveLength(2);
    expect(closes[0]).toBeLessThan(opens[1] as number);
  });
});

describe('the research signal reaches the doorway: a 60 s limit or Stop ends the read in flight and leaves no tab open', () => {
  const never = () => new Promise<never>(() => {});
  const ready = (f: Fake) => new Promise<void>((resolve) => {
    const poll = () => (f.log.some((l) => l.startsWith('open')) ? resolve() : setTimeout(poll, 1));
    poll();
  });

  it('while the page loads: the call answers stopped, the tab is closed and forgotten', async () => {
    const f = fake();
    f.env.waitForLoad = never;
    const stop = new AbortController();
    const reading = (await tools(f)).forQuestion().readHomeDepotPage({ itemId: PAGE }, stop.signal);
    await ready(f);
    stop.abort();
    expect(await reading).toEqual({ error: 'stopped' });
    expect(f.log.at(-1)).toBe('close 7');
    expect(await f.env.remembered()).toBeNull();
  });

  it('while the tab settles (the pause after the load)', async () => {
    const f = fake();
    const sleep = f.env.sleep;
    f.env.sleep = (ms) => (ms === 2500 ? never() : sleep(ms));
    const stop = new AbortController();
    const reading = (await tools(f)).forQuestion().readHomeDepotPage({ itemId: PAGE }, stop.signal);
    await ready(f);
    stop.abort();
    expect(await reading).toEqual({ error: 'stopped' });
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('while the page is being read in the tab: a search too', async () => {
    for (const call of ['page', 'search'] as const) {
      const f = fake();
      f.env.runInTab = never;
      const stop = new AbortController();
      const q = (await tools(f)).forQuestion();
      const run = call === 'page' ? q.readHomeDepotPage({ itemId: PAGE }, stop.signal) : q.searchHomeDepot({ query: 'ryobi saw' }, stop.signal);
      await ready(f);
      stop.abort();
      expect(await run, call).toEqual({ error: 'stopped' });
      expect(f.log.at(-1), call).toBe('close 7');
      expect(await f.env.remembered(), call).toBeNull();
    }
  });

  it('a signal that fires while the tab is still opening: the tab is closed once it exists', async () => {
    const f = fake();
    const stop = new AbortController();
    f.env.openTab = async (url) => {
      f.log.push(`open ${url}`);
      stop.abort();
      return 7;
    };
    expect(await (await tools(f)).forQuestion().readHomeDepotPage({ itemId: PAGE }, stop.signal)).toEqual({ error: 'stopped' });
    expect(f.log).toContain('close 7');
    expect(f.log.filter((l) => l.startsWith('fetch'))).toEqual([]);
  });

  it('a call waiting behind another doorway opens no tab once its signal has fired', async () => {
    const f = fake();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const load = f.env.waitForLoad;
    f.env.waitForLoad = async (id, ms) => {
      await held;
      return load(id, ms);
    };
    const q = (await tools(f)).forQuestion();
    const first = q.readHomeDepotPage({ itemId: ids[0] });
    await ready(f);
    const stop = new AbortController();
    const second = q.readHomeDepotPage({ itemId: ids[1] }, stop.signal);
    stop.abort();
    release();
    expect(await second).toEqual({ error: 'stopped' });
    expect(await first).toMatchObject({ sourceId: expect.any(String) });
    expect(f.log.filter((l) => l.startsWith('open'))).toHaveLength(1);
  });

  it('is not a Home Depot refusal: the question\'s later calls are still made', async () => {
    const f = fake();
    f.env.runInTab = never;
    const stop = new AbortController();
    const q = (await tools(f)).forQuestion();
    const reading = q.readHomeDepotPage({ itemId: PAGE }, stop.signal);
    await ready(f);
    stop.abort();
    await reading;
    // The same tool set, a fresh signal: the stop was the owner's or the clock's, so Home Depot is not treated as having refused.
    f.env.runInTab = fake().env.runInTab;
    expect(await q.readHomeDepotPage({ itemId: PAGE })).toMatchObject({ sourceId: expect.any(String) });
  });
});

describe('searchHomeDepot', () => {
  const rows = (n: number): SearchRow[] =>
    Array.from({ length: n }, (_, i) => ({ title: `Tool ${i}`, brand: 'RYOBI', model: `PCL${i}`, itemId: String(300000000 + i) }));

  it('searches /s/<query> in the doorway tab and returns the parsed rows, at most 10, with product addresses', async () => {
    const f = fake({ search: () => ({ status: 200, text: '<html>search</html>' }) });
    let parsed = '';
    const q = (await tools(f, { parseSearch: (html) => { parsed = html; return rows(14); } })).forQuestion();
    const out = await q.searchHomeDepot({ query: ' ryobi 18V drill ' });
    expect(parsed).toBe('<html>search</html>');
    expect(out).toMatchObject({ sourceId: 'hd-search:ryobi-18v-drill', label: 'Home Depot search', url: 'https://www.homedepot.com/s/ryobi%2018V%20drill' });
    const results = (out as { results: unknown[] }).results;
    expect(results).toHaveLength(10);
    expect(results[0]).toEqual({ title: 'Tool 0', brand: 'RYOBI', model: 'PCL0', itemId: '300000000', url: 'https://www.homedepot.com/p/300000000' });
    expect(f.log[0]).toBe('open https://www.homedepot.com/s/ryobi%2018V%20drill');
    expect(f.log).toContain('fetch search ryobi 18V drill');
  });

  it('is an empty result, not an error, when the page parses and shows no product', async () => {
    const q = (await tools(fake(), { parseSearch: () => [] })).forQuestion();
    expect(await q.searchHomeDepot({ query: 'zzz' })).toMatchObject({ results: [] });
  });

  it('says the page could not be read when the parser gives null, and when the default parser finds no page data', async () => {
    expect(await (await tools(fake(), { parseSearch: () => null })).forQuestion().searchHomeDepot({ query: 'drill' })).toEqual({ error: expect.stringContaining('could not be read') });
    expect(await (await tools(fake())).forQuestion().searchHomeDepot({ query: 'drill' })).toEqual({ error: expect.stringContaining('could not be read') });
  });

  it('reads a recorded search with the default parser: "ryobi pcl500" lists the saw first and the combo kit with its item id', async () => {
    const f = fake({ search: (q) => ({ status: 200, text: `window.__APOLLO_STATE__=${JSON.stringify(research.searches[q]?.state)}` }) });
    const out = (await (await tools(f)).forQuestion().searchHomeDepot({ query: 'ryobi pcl500' })) as { results: { model: string; itemId: string; url: string }[] };
    expect(out.results).toHaveLength(10);
    expect(out.results[0]).toMatchObject({ model: 'PCL500B', itemId: '317987588', url: 'https://www.homedepot.com/p/317987588' });
    expect(out.results.find((r) => r.model === 'PCL500B-PCL525B')?.itemId).toBe('324616618');
  });

  it('refuses an empty or very long query without a tab', async () => {
    const f = fake();
    const q = (await tools(f, { parseSearch: () => [] })).forQuestion();
    expect(await q.searchHomeDepot({ query: '   ' })).toEqual({ error: expect.any(String) });
    expect(await q.searchHomeDepot({ query: 'x'.repeat(201) })).toEqual({ error: expect.any(String) });
    expect(f.log).toEqual([]);
    expect(q.budget.used()).toBe(0);
  });

  it('names a refusal and stops the question', async () => {
    const f = fake({ search: () => ({ status: 429, text: null }) });
    const q = (await tools(f, { parseSearch: () => [] })).forQuestion();
    expect(await q.searchHomeDepot({ query: 'drill' })).toEqual({ error: expect.stringContaining('HTTP 429') });
    expect(await q.readHomeDepotPage({ itemId: PAGE })).toEqual({ error: expect.stringContaining('refused') });
  });
});

describe('catalogLookup', () => {
  it('finds a model, in either RYOBI form, with its kind', async () => {
    const q = (await tools(fake())).forQuestion();
    expect(await q.catalogLookup({ model: 'pcl206' })).toEqual({
      sourceId: 'catalog:pcl206',
      entries: [{ brand: 'RYOBI', model: 'PCL206B', title: 'ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only)', kind: 'part' }],
    });
    expect(((await q.catalogLookup({ model: 'PCL1600K2' })) as { entries: { kind: string }[] }).entries[0]?.kind).toBe('kit');
  });

  it('does not match a DEWALT model by its RYOBI twin form', async () => {
    const q = (await tools(fake())).forQuestion();
    expect((await q.catalogLookup({ model: 'DCD791' })).entries).toEqual([]);
  });

  it('finds words in the brand, model or title; every word must be there', async () => {
    const q = (await tools(fake())).forQuestion();
    expect((await q.catalogLookup({ query: 'dewalt drill' })).entries.map((e) => e.model)).toEqual(['DCD791B']);
    expect((await q.catalogLookup({ query: 'battery' })).entries.map((e) => e.model)).toEqual(['DCB205']);
    expect((await q.catalogLookup({ query: 'drill' })).entries.map((e) => e.model).sort()).toEqual(['DCD791B', 'PCL206B']);
    expect((await q.catalogLookup({ query: 'hammer' })).entries).toEqual([]);
  });

  it('gives no entries for neither a model nor a query, and costs no budget', async () => {
    const q = (await tools(fake())).forQuestion();
    expect((await q.catalogLookup({})).entries).toEqual([]);
    expect(q.budget.used()).toBe(0);
  });

  it('gives at most 20 entries', async () => {
    const store = new MemoryScanStore();
    for (let i = 0; i < 30; i++) await store.putCatalogEntry(record('RYOBI', `PCL${100 + i}B`, 'ONE+ drill'));
    const q = createResearchTools({ env: fake().env, store }).forQuestion();
    expect((await q.catalogLookup({ query: 'drill' })).entries).toHaveLength(20);
  });
});

// Nov 23: the doorway rule for the research tools (see hdReader.ts withDoorway). A cold doorway shows its state late; a 200
// without it is one unreadable page, not a refusal; "no more are made" follows only a real refusal.
describe('the doorway rule: a cold doorway, an empty 200, a real refusal', () => {
  const searchOk = (q: string): SearchPageResult => ({ status: 200, text: `window.__APOLLO_STATE__=${JSON.stringify(research.searches[q]?.state ?? {})}` });
  type Q = ReturnType<Awaited<ReturnType<typeof tools>>['forQuestion']>;
  const calls: [string, (q: Q) => Promise<unknown>][] = [
    ['page', (q) => q.readHomeDepotPage({ itemId: PAGE })],
    ['search', (q) => q.searchHomeDepot({ query: 'ryobi pcl500' })],
  ];

  for (const [name, call] of calls) {
    it(`${name}: a cold doorway that shows its state after 2 s is read, after the checks and before the fetch`, async () => {
      let checks = 0;
      const f = fake({ doorway: () => ({ state: ++checks >= 5, title: 'Home Depot' }), search: searchOk });
      const out = await call((await tools(f)).forQuestion());
      expect(out).toHaveProperty('sourceId');
      expect(f.log.filter((l) => l === 'sleep 500')).toHaveLength(4);
      expect(checks).toBe(5);
      expect(f.log.findIndex((l) => l.startsWith('fetch'))).toBeGreaterThan(f.log.lastIndexOf('sleep 500'));
    });

    it(`${name}: a doorway that never shows its state is the refusal: nothing is fetched, its title is said, no more are made`, async () => {
      const f = fake({ doorway: () => ({ state: false, title: 'Access Denied' }), search: searchOk });
      const q = (await tools(f, { doorwayStateMs: 2000 })).forQuestion();
      const out = await call(q);
      expect(out).toEqual({ error: expect.stringMatching(/^Home Depot refused the (page|search) \(its own page never showed its data, titled "Access Denied"\); no more are (read|made) for this question\.$/) });
      expect(f.log.filter((l) => l.startsWith('fetch'))).toEqual([]);
      expect(f.log.at(-1)).toBe('close 7');
      f.log.length = 0;
      expect(await q.readHomeDepotPage({ itemId: ids[1] })).toEqual({ error: expect.stringContaining('refused an earlier request') });
      expect(f.log).toEqual([]);
    });
  }

  it('a 200 search without its state is one unreadable search, never "refused ... no more are made"; the next call is made', async () => {
    let n = 0;
    const f = fake({ search: (q) => (++n === 1 ? { status: 200, text: null, note: 'Home Depot' } : searchOk(q)) });
    const q = (await tools(f)).forQuestion();
    const first = await q.searchHomeDepot({ query: 'ryobi pcl500' });
    expect(first).toEqual({ error: 'The search came back without its data, titled "Home Depot".' });
    expect(JSON.stringify(first)).not.toContain('no more');
    expect(await q.searchHomeDepot({ query: 'ryobi pcl500' })).toHaveProperty('results');
    expect(await q.readHomeDepotPage({ itemId: PAGE })).toHaveProperty('sections');
  });

  it('one empty 200 in the middle: that page is not read, the next ones are', async () => {
    const f = fake({ page: (id) => (id === ids[1] ? { itemId: id, status: 200, text: null, note: '' } : (byId.get(id) as InTabResult)) });
    const q = (await tools(f)).forQuestion();
    expect(await q.readHomeDepotPage({ itemId: ids[0] })).toHaveProperty('sections');
    expect(await q.readHomeDepotPage({ itemId: ids[1] })).toEqual({ error: `The page for item ${ids[1]} came back without its data.` });
    expect(await q.readHomeDepotPage({ itemId: ids[2] })).toHaveProperty('sections');
    expect(f.log.filter((l) => l.startsWith('fetch page'))).toHaveLength(3);
  });

  it("two unreadable answers in a row, a search then a page, end the question's Home Depot calls", async () => {
    const f = fake({ page: (id) => ({ itemId: id, status: 200, text: null }), search: () => ({ status: 200, text: null }) });
    const q = (await tools(f)).forQuestion();
    expect(await q.searchHomeDepot({ query: 'a' })).toEqual({ error: expect.stringContaining('without its data') });
    expect(await q.readHomeDepotPage({ itemId: PAGE })).toEqual({ error: expect.stringContaining('without its data') });
    f.log.length = 0;
    expect(await q.searchHomeDepot({ query: 'b' })).toEqual({ error: expect.stringContaining('two requests in a row') });
    expect(f.log).toEqual([]);
  });

  it('a real 403, 429 or 5xx stops at once, for a search and then a page', async () => {
    for (const status of [403, 429, 503]) {
      const f = fake({ search: () => ({ status, text: null }) });
      const q = (await tools(f)).forQuestion();
      expect(await q.searchHomeDepot({ query: 'drill' })).toEqual({ error: expect.stringContaining(`HTTP ${status}`) });
      expect(await q.readHomeDepotPage({ itemId: PAGE })).toEqual({ error: expect.stringContaining('refused an earlier request') });
    }
  });
});
