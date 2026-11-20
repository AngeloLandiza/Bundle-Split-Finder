import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MemoryScanStore } from '@core/scan/memoryStore';
import { partKey, type CatalogRecord } from '@core/scan/types';
import type { ResearchTools } from '@core/research/types';
import { fetchPagesInTab, type InTabResult, type ReaderEnv } from './hdReader';
import {
  createQuestionBudget, createResearchTools, fetchSearchPageInTab, homeDepotItemId, QUESTION_TOOL_LIMIT,
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
      if (func === fetchSearchPageInTab) {
        log.push(`fetch search ${args[0] as string}`);
        return (opts.search ?? (() => ({ status: 200, text: '<html></html>' })))(args[0] as string);
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

  it('reports a 200 page with no data as refused, and a page it cannot parse as unreadable', async () => {
    const empty = fake({ page: (id) => ({ itemId: id, status: 200, text: null }) });
    expect(await (await tools(empty)).forQuestion().readHomeDepotPage({ itemId: PAGE })).toEqual({ error: expect.stringContaining('HTTP 200') });
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
