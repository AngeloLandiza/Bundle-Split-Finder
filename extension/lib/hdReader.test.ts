import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PART_PRICE_READS_MAX } from '@core/scan/types';
import {
  createPageReader,
  createPartPriceReader,
  doorwayLoaded,
  fetchPagesInTab,
  fetchSearchesInTab,
  openDoorway,
  pickPartLink,
  type InTabResult,
  type ReaderEnv,
  type SearchInTab,
  waitForDoorway,
} from './hdReader';

const pages = (JSON.parse(readFileSync('fixtures/homedepot-pages/pages-2026-11-10.json', 'utf8')) as {
  pages: InTabResult[];
}).pages;
const ids = pages.map((p) => p.itemId);
const byId = new Map(pages.map((p) => [p.itemId, p]));

interface Fake {
  env: ReaderEnv;
  log: string[];
  batches: string[][];
  remembered: (number | null)[];
}

function fake(opts: {
  respond?: (id: string) => InTabResult;
  loadFails?: boolean;
  runThrows?: boolean;
  runResult?: (ids: string[]) => unknown;
  stored?: number | null;
} = {}): Fake {
  const log: string[] = [];
  const batches: string[][] = [];
  const remembered: (number | null)[] = [];
  let stored: number | null = opts.stored ?? null;
  const respond = opts.respond ?? ((id) => byId.get(id) ?? { itemId: id, status: 404, text: null });
  const env: ReaderEnv = {
    origin: 'https://www.homedepot.com',
    openTab: async (url) => { log.push(`open ${url}`); return 7; },
    closeTab: async (id) => { log.push(`close ${id}`); },
    waitForLoad: async (id, ms) => {
      log.push(`wait ${id} ${ms}`);
      if (opts.loadFails) throw new Error('timeout');
    },
    runInTab: (async (_tab: number, _func: unknown, args: [string[], number]) => {
      log.push('run');
      batches.push(args[0]);
      if (opts.runThrows) throw new Error('boom');
      if (opts.runResult) return opts.runResult(args[0]);
      return args[0].map(respond);
    }) as ReaderEnv['runInTab'],
    remember: async (id) => { stored = id; remembered.push(id); },
    remembered: async () => stored,
    sleep: async (ms) => { log.push(`sleep ${ms}`); },
  };
  return { env, log, batches, remembered };
}

describe('createPageReader', () => {
  it('pauses between two calls as it does between batches, only for what is left of the pause', async () => {
    // A scan reads bundle pages, then (step 6) kit pages, in a second call made at once.
    const f = fake();
    let t = 0;
    const env: ReaderEnv = { ...f.env, sleep: async (ms) => { f.log.push(`sleep ${ms}`); t += ms; } };
    const read = createPageReader(env, { now: () => t, settleMs: 0 });
    await read(ids.slice(0, 2));
    expect(f.log.filter((l) => l.startsWith('sleep'))).toEqual([]);
    f.log.length = 0;
    await read(ids.slice(2, 3));
    expect(f.log.slice(0, 2)).toEqual(['sleep 1000', `open https://www.homedepot.com/p/${ids[2]}`]);
    f.log.length = 0;
    t += 400;
    await read(ids.slice(3, 4));
    expect(f.log.slice(0, 2)).toEqual(['sleep 600', `open https://www.homedepot.com/p/${ids[3]}`]);
    f.log.length = 0;
    t += 5000;
    await read(ids.slice(4, 5));
    expect(f.log.filter((l) => l.startsWith('sleep'))).toEqual([]);
    // No ids: no tab and no pause.
    f.log.length = 0;
    expect(await read([])).toEqual([]);
    expect(f.log).toEqual([]);
  });

  it('waits settleMs after the tab loads and before the first fetch, and not again between batches', async () => {
    const f = fake();
    await createPageReader(f.env, { batch: 2 })(ids.slice(0, 4));
    const at = (l: string) => f.log.indexOf(l);
    expect(at('wait 7 30000')).toBeLessThan(at('sleep 2500'));
    expect(at('sleep 2500')).toBeLessThan(at('run'));
    expect(f.log.filter((l) => l === 'sleep 2500')).toHaveLength(1);
    const custom = fake();
    await createPageReader(custom.env, { settleMs: 400 })(ids.slice(0, 1));
    expect(custom.log).toContain('sleep 400');
    expect(custom.log.indexOf('sleep 400')).toBeLessThan(custom.log.indexOf('run'));
  });

  it('records the status Home Depot answered with, 0 when the fetch threw, and still stops at once', async () => {
    const f = fake({ respond: (id) => (id === ids[1] ? { itemId: id, status: 403, text: null } : byId.get(id)!) });
    const out = await createPageReader(f.env, { batch: 2 })(ids.slice(0, 6));
    expect(out[1]).toEqual({ itemId: ids[1], kind: 'refused', status: 403 });
    expect(f.batches).toHaveLength(1);
    const threw = fake({ respond: (id) => ({ itemId: id, status: 0, text: null }) });
    expect((await createPageReader(threw.env)(ids.slice(0, 2)))[0]).toEqual({ itemId: ids[0], kind: 'refused', status: 0 });
  });

  it('opens no tab for no ids', async () => {
    const f = fake();
    expect(await createPageReader(f.env)([])).toEqual([]);
    expect(f.log).toEqual([]);
  });

  it('opens one doorway at the first id, batches by 6, closes and forgets', async () => {
    const f = fake();
    const out = await createPageReader(f.env)(ids);
    expect(f.log[0]).toBe(`open https://www.homedepot.com/p/${ids[0]}`);
    expect(f.log).toContain('wait 7 30000');
    expect(f.batches.map((b) => b.length)).toEqual([6, 6, 6]);
    expect(f.log.filter((l) => l === 'sleep 1000')).toHaveLength(2);
    expect(f.log.filter((l) => l.startsWith('open'))).toHaveLength(1);
    expect(f.log.at(-1)).toBe('close 7');
    expect(f.remembered).toEqual([7, null]);
    expect(out.map((o) => o.itemId)).toEqual(ids);
    expect(out.every((o) => o.kind === 'read')).toBe(true);
  });

  it('closes and forgets the tab when runInTab throws', async () => {
    const f = fake({ runThrows: true });
    await expect(createPageReader(f.env)(ids)).rejects.toThrow('boom');
    expect(f.log.at(-1)).toBe('close 7');
    expect(f.remembered).toEqual([7, null]);
  });

  it('marks 200 with unparsable text unreadable', async () => {
    const f = fake({ respond: (id) => ({ itemId: id, status: 200, text: 'window.__APOLLO_STATE__=nope' }) });
    const out = await createPageReader(f.env)(ids.slice(0, 2));
    expect(out.map((o) => o.kind)).toEqual(['unreadable', 'unreadable']);
  });

  it('stops at the first refusal: refused, then skipped, no further call', async () => {
    const f = fake({
      respond: (id) => (id === ids[1] ? { itemId: id, status: 403, text: null } : byId.get(id)!),
    });
    const out = await createPageReader(f.env, { batch: 2 })(ids.slice(0, 6));
    expect(out.map((o) => o.kind)).toEqual(['read', 'refused', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(f.batches).toHaveLength(1);
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('treats 200 with null text as refused and skips the rest of its batch', async () => {
    const f = fake({ respond: (id) => (id === ids[0] ? { itemId: id, status: 200, text: null } : byId.get(id)!) });
    const out = await createPageReader(f.env)(ids.slice(0, 3));
    expect(out.map((o) => o.kind)).toEqual(['refused', 'skipped', 'skipped']);
  });

  it('throws when the doorway does not load, and closes the tab', async () => {
    const f = fake({ loadFails: true });
    await expect(createPageReader(f.env)(ids)).rejects.toThrow('The Home Depot tab did not load.');
    expect(f.log.at(-1)).toBe('close 7');
    expect(f.batches).toEqual([]);
    expect(f.remembered).toEqual([7, null]);
  });

  it('an empty script result (undefined) refuses the first id, skips the rest, and closes the tab', async () => {
    const f = fake({ runResult: () => undefined });
    const out = await createPageReader(f.env)(ids.slice(0, 3));
    expect(out.map((o) => o.kind)).toEqual(['refused', 'skipped', 'skipped']);
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('a result array missing one id refuses that id, skips every later id, and makes no further call', async () => {
    const f = fake({ runResult: (b) => b.filter((id) => id !== ids[1]).map((id) => byId.get(id)!) });
    const out = await createPageReader(f.env, { batch: 2 })(ids.slice(0, 6));
    expect(out.map((o) => o.kind)).toEqual(['read', 'refused', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(f.batches).toHaveLength(1);
  });

  it('closes a doorway left by a stopped worker before opening a new one', async () => {
    const f = fake({ stored: 99 });
    await createPageReader(f.env)(ids.slice(0, 1));
    expect(f.log[0]).toBe('close 99');
    expect(f.log[1]).toMatch(/^open /);
  });
});

describe('refusal handling', () => {
  it('skips the rest of a later batch and every batch after it, with no further runInTab', async () => {
    const f = fake({
      respond: (id) => (id === ids[3] ? { itemId: id, status: 403, text: null } : byId.get(id)!),
    });
    const out = await createPageReader(f.env, { batch: 2 })(ids.slice(0, 8));
    expect(out.map((o) => o.kind)).toEqual(['read', 'read', 'read', 'refused', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(f.batches).toHaveLength(2);
  });

  it('marks ids the tab never fetched (status -1) as skipped', async () => {
    const f = fake({
      respond: (id) =>
        id === ids[0] ? { itemId: id, status: 403, text: null } : { itemId: id, status: -1, text: null },
    });
    const out = await createPageReader(f.env)(ids.slice(0, 3));
    expect(out.map((o) => o.kind)).toEqual(['refused', 'skipped', 'skipped']);
  });

  it('closes the doorway when remember(tabId) throws, and keeps that error', async () => {
    const f = fake();
    const real = f.env.remember;
    f.env.remember = async (id) => {
      if (id !== null) throw new Error('storage down');
      await real(id);
    };
    await expect(createPageReader(f.env)(ids)).rejects.toThrow('storage down');
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('does not let a failing remember(null) mask the original error', async () => {
    const f = fake({ runThrows: true });
    f.env.remember = async (id) => {
      if (id === null) throw new Error('cleanup failed');
    };
    await expect(createPageReader(f.env)(ids)).rejects.toThrow('boom');
  });
});

describe('fetchPagesInTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts no fetch after a refusal; unfetched ids come back with status -1', async () => {
    const started: string[] = [];
    let refusedAt = -1;
    vi.stubGlobal('fetch', async (url: string) => {
      const id = url.split('/').pop()!;
      started.push(id);
      await new Promise((r) => setTimeout(r, id === 'b' ? 5 : 20));
      if (id === 'b') {
        refusedAt = started.length;
        return { status: 403, text: async () => 'no' };
      }
      return { status: 200, text: async () => 'window.__APOLLO_STATE__={}</script>' };
    });
    const rebuilt = new Function(`return (${fetchPagesInTab.toString()})`)() as typeof fetchPagesInTab;
    const out = await rebuilt(['a', 'b', 'c', 'd', 'e', 'f'], 2);
    expect(started.length).toBe(refusedAt);
    expect(started).toEqual(['a', 'b']);
    expect(out.map((o) => o.status)).toEqual([200, 403, -1, -1, -1, -1]);
    expect(out[3]).toEqual({ itemId: 'd', status: -1, text: null });
  });

  it('runs from its own source against a stubbed fetch, in input order, within the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const delays: Record<string, number> = { a: 30, b: 5, c: 1, d: 10, e: 1 };
    vi.stubGlobal('fetch', async (url: string) => {
      const id = url.split('/').pop()!;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, delays[id] ?? 1));
      active--;
      if (id === 'c') throw new Error('network');
      if (id === 'd') return { status: 403, text: async () => 'refused' };
      return { status: 200, text: async () => `x<script>window.__APOLLO_STATE__={"id":"${id}"}</script><script>y</script>` };
    });
    const rebuilt = new Function(`return (${fetchPagesInTab.toString()})`)() as typeof fetchPagesInTab;
    const out = await rebuilt(['a', 'b', 'c', 'd', 'e'], 2);
    expect(out.map((o) => o.itemId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peak).toBe(2);
    expect(out[0]).toEqual({ itemId: 'a', status: 200, text: 'window.__APOLLO_STATE__={"id":"a"}' });
    expect(out[2]).toEqual({ itemId: 'c', status: 0, text: null });
    // The throw on 'c' stops reading, so 'd' and 'e' are never fetched.
    expect(out[3]).toEqual({ itemId: 'd', status: -1, text: null });
    expect(out[4]).toEqual({ itemId: 'e', status: -1, text: null });
  });
});

describe('doorwayLoaded', () => {
  const origin = 'https://www.homedepot.com';

  it('is true only for a complete tab on a page of the Home Depot origin', () => {
    expect(doorwayLoaded({ status: 'complete', url: '' }, origin)).toBe(false);
    expect(doorwayLoaded({ status: 'complete', url: 'about:blank' }, origin)).toBe(false);
    expect(doorwayLoaded({ status: 'complete' }, origin)).toBe(false);
    expect(doorwayLoaded({ status: 'loading', url: 'https://www.homedepot.com/p/1' }, origin)).toBe(false);
    expect(doorwayLoaded({ status: 'complete', url: 'https://www.homedepot.com.example.test/p/1' }, origin)).toBe(false);
    expect(doorwayLoaded({ status: 'complete', url: 'https://www.homedepot.com/p/RYOBI-x/328814689' }, origin)).toBe(true);
  });
});

// What Chrome did in the end-to-end runs of 2026-11-18 (debug-report): a tab created on about:blank reports `loading` until its
// blank page has loaded. Navigated in that window, the tab dropped the navigation and settled on `unloaded`, with no
// URL, and never loaded (5 of 34 doorways under load). Navigated after it, it loaded the page.
function chromeTabs(opts: { blankMs: number | null }) {
  let t = 0;
  let state: { status: string; url?: string } = { status: 'loading' };
  const blankDone = () => opts.blankMs !== null && t >= opts.blankMs;
  const calls: string[] = [];
  return {
    calls,
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    tabs: {
      create: async (url: string) => { calls.push(`create ${url}`); return { id: 7, status: 'loading' }; },
      get: async (_id: number) => {
        if (state.status === 'loading' && state.url === undefined && blankDone()) state = { status: 'complete' };
        return { ...state };
      },
      update: async (_id: number, url: string) => {
        calls.push(`update ${url}`);
        const blankLoading = state.status === 'loading' && state.url === undefined && !blankDone();
        state = blankLoading ? { status: 'unloaded' } : { status: 'complete', url };
        return {};
      },
    },
  };
}

describe('openDoorway', () => {
  const origin = 'https://www.homedepot.com';
  const url = `${origin}/s/DCF921B`;

  it('names the blank tab, then sends it to the page only once its blank page has loaded, so the page loads', async () => {
    const c = chromeTabs({ blankMs: 40 });
    const named: number[] = [];
    const id = await openDoorway(c.tabs, url, async (tabId) => { c.calls.push(`name ${tabId}`); named.push(tabId); }, c.sleep);
    expect(id).toBe(7);
    expect(c.calls).toEqual(['create about:blank', 'name 7', `update ${url}`]);
    await waitForDoorway(c.tabs.get, id, origin, 30_000, c.sleep, c.now);
    expect(await c.tabs.get(id)).toEqual({ status: 'complete', url });
  });

  it('a blank page already loaded is sent to the page at once', async () => {
    const c = chromeTabs({ blankMs: 0 });
    await openDoorway(c.tabs, url, async () => undefined, c.sleep);
    expect(c.now()).toBe(0);
    expect(await c.tabs.get(7)).toEqual({ status: 'complete', url });
  });

  it('a blank page that never loads is still sent to the page after 5 s, and waitForDoorway reports it', async () => {
    const c = chromeTabs({ blankMs: null });
    await openDoorway(c.tabs, url, async () => undefined, c.sleep);
    expect(c.calls).toEqual(['create about:blank', `update ${url}`]);
    expect(c.now()).toBeGreaterThanOrEqual(5000);
    expect(c.now()).toBeLessThan(5100);
    await expect(waitForDoorway(c.tabs.get, 7, origin, 1000, c.sleep, c.now)).rejects.toThrow('timeout');
  });

  it('throws when Chrome gives no tab id', async () => {
    const tabs = { create: async () => ({}), get: async () => ({}), update: vi.fn(async () => ({})) };
    await expect(openDoorway(tabs, url, async () => undefined, async () => undefined)).rejects.toThrow('Chrome opened no tab.');
    expect(tabs.update).not.toHaveBeenCalled();
  });
});

describe('waitForDoorway', () => {
  const origin = 'https://www.homedepot.com';

  function clock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
      now: () => t,
      sleeps,
    };
  }

  it('resolves when the third check is complete on the Home Depot origin', async () => {
    const c = clock();
    const checks = [
      { status: 'loading' },
      { status: 'loading', url: 'https://www.homedepot.com/p/1' },
      { status: 'complete', url: 'https://www.homedepot.com/p/1' },
    ];
    const getTab = vi.fn(async (_id: number) => checks.shift()!);
    await waitForDoorway(getTab, 7, origin, 1000, c.sleep, c.now);
    expect(getTab).toHaveBeenCalledTimes(3);
    expect(getTab.mock.calls.every((args) => args[0] === 7)).toBe(true);
  });

  it('rejects with timeout when every check is on about:blank', async () => {
    const c = clock();
    const getTab = vi.fn(async () => ({ status: 'complete', url: 'about:blank' }));
    await expect(waitForDoorway(getTab, 7, origin, 1000, c.sleep, c.now, 250)).rejects.toThrow('timeout');
    expect(getTab).toHaveBeenCalledTimes(5);
  });

  it('rejects at once with the same error when the tab is gone', async () => {
    const c = clock();
    const sleep = vi.fn(c.sleep);
    const getTab = vi.fn(async () => { throw new Error('No tab with id: 7.'); });
    await expect(waitForDoorway(getTab, 7, origin, 1000, sleep, c.now)).rejects.toThrow('No tab with id: 7.');
    expect(sleep).not.toHaveBeenCalled();
  });
});

// The part price reader. The page text has the shape of a recorded product page (base-catalog-<id> with identifiers and a
// `pricing(...)` key, as fixtures/homedepot-pages/pricing-2026-11-17.json shows); the ids and models are made up for the test.
const productText = (id: string, brand: string, model: string, price: number | null, title = `${brand} ${model} title`): string =>
  'window.__APOLLO_STATE__=' +
  JSON.stringify({
    [`base-catalog-${id}`]: {
      itemId: id,
      identifiers: { brandName: brand, itemId: id, modelNumber: model, productLabel: title },
      ...(price === null ? {} : { 'pricing({"isBrandPricingPolicyCompliant":false,"storeId":"8119"})': { value: price, original: null } }),
    },
  });

interface PartFake {
  env: ReaderEnv;
  log: string[];
  searched: string[][];
  fetched: string[][];
}

/** `search` gives the links Home Depot's search shows for a model; `pages` the product page text by id. */
function partFake(opts: {
  search?: Record<string, string[]>;
  pages?: Record<string, string>;
  searchStatus?: (model: string) => number;
  pageStatus?: (id: string) => number;
  stored?: number | null;
}): PartFake {
  const log: string[] = [];
  const searched: string[][] = [];
  const fetched: string[][] = [];
  let stored: number | null = opts.stored ?? null;
  const env: ReaderEnv = {
    origin: 'https://www.homedepot.com',
    openTab: async (url) => { log.push(`open ${url}`); return 7; },
    closeTab: async (id) => { log.push(`close ${id}`); },
    waitForLoad: async (id, ms) => { log.push(`wait ${id} ${ms}`); },
    runInTab: (async (_tab: number, func: unknown, args: [string[], number]) => {
      if (func === fetchSearchesInTab) {
        log.push('search');
        searched.push(args[0]);
        const out: SearchInTab[] = args[0].map((model) => {
          const status = opts.searchStatus?.(model) ?? 200;
          return { model, status, links: status === 200 ? (opts.search?.[model] ?? []) : null };
        });
        const bad = out.findIndex((o) => o.status !== 200);
        return out.map((o, i) => (bad >= 0 && i > bad ? { model: o.model, status: -1, links: null } : o));
      }
      log.push('page');
      fetched.push(args[0]);
      const out: InTabResult[] = args[0].map((id) => {
        const status = opts.pageStatus?.(id) ?? (opts.pages?.[id] === undefined ? 404 : 200);
        const text = status === 200 ? (opts.pages?.[id] ?? null) : null;
        // As fetchPagesInTab: a 200 page with no embedded data has no text.
        return { itemId: id, status, text: text !== null && text.includes('window.__APOLLO_STATE__=') ? text : null };
      });
      const bad = out.findIndex((o) => o.status !== 200 || o.text === null);
      return out.map((o, i) => (bad >= 0 && i > bad ? { itemId: o.itemId, status: -1, text: null } : o));
    }) as ReaderEnv['runInTab'],
    remember: async (id) => { stored = id; },
    remembered: async () => stored,
    sleep: async (ms) => { log.push(`sleep ${ms}`); },
  };
  return { env, log, searched, fetched };
}

const nothingFor = (brand: string, model: string, status: 'not_found' | 'not_read' = 'not_read') => ({
  brand, model, status, itemId: null, matchedModel: null, price: null, title: null, link: null,
});

describe('pickPartLink', () => {
  const links = [
    '/p/RYOBI-ONE-18V-Cordless-Compact-Drill-Driver-Kit-PSBDD01K/300000001',
    '/p/RYOBI-ONE-18V-Cordless-Impact-Wrench-Tool-Only-pcl265b/300000002',
    '/p/RYOBI-ONE-18V-Starter-Kit-PSK0114-PCL265B/300000003',
  ];

  it('takes the first link whose address ends with the exact model, case-insensitively, and its 9-digit id', () => {
    expect(pickPartLink('RYOBI', 'PCL265B', links)).toEqual({ itemId: '300000002', path: links[1] });
    expect(pickPartLink('DEWALT', 'pcl265b', links)).toEqual({ itemId: '300000002', path: links[1] });
  });

  it('matches nothing when no link ends with the model, and never a model that only contains it', () => {
    expect(pickPartLink('DEWALT', 'PCL265', links)).toBeNull();
    // For RYOBI, PCL265 is PCL265B's twin (see below).
    expect(pickPartLink('RYOBI', 'PSK0114', links)).toBeNull();
    expect(pickPartLink('RYOBI', 'CL265B', links)).toBeNull();
    expect(pickPartLink('DEWALT', 'DCD791B', links)).toBeNull();
    expect(pickPartLink('RYOBI', 'PCL265B', [])).toBeNull();
    // Not a 9-digit id: not a product address.
    expect(pickPartLink('RYOBI', 'PCL265B', ['/p/RYOBI-Tool-PCL265B/12345'])).toBeNull();
  });

  it('RYOBI accepts the one-trailing-B twin, preferring an exact match when both appear; DEWALT stays exact', () => {
    const twin = '/p/RYOBI-ONE-18V-Drill-Tool-Only-PCL206B/300000010';
    const exact = '/p/RYOBI-ONE-18V-Drill-PCL206/300000011';
    expect(pickPartLink('RYOBI', 'PCL206', [twin])).toEqual({ itemId: '300000010', path: twin });
    expect(pickPartLink('RYOBI', 'PCL206B', [exact])).toEqual({ itemId: '300000011', path: exact });
    expect(pickPartLink('RYOBI', 'PCL206', [twin, exact])).toEqual({ itemId: '300000011', path: exact });
    expect(pickPartLink('RYOBI', 'PCL206B', [exact, twin])).toEqual({ itemId: '300000010', path: twin });
    expect(pickPartLink('DEWALT', 'DCD791', ['/p/DEWALT-20V-Drill-DCD791B/300000012'])).toBeNull();
    expect(pickPartLink('DEWALT', 'DCD791B', ['/p/DEWALT-20V-Drill-DCD791/300000012'])).toBeNull();
    // Only one B: PCL206BB is not PCL206B's twin.
    expect(pickPartLink('RYOBI', 'PCL206B', ['/p/RYOBI-Drill-PCL206BB/300000013'])).toBeNull();
  });
});

describe('createPartPriceReader', () => {
  const tool = '/p/RYOBI-ONE-18V-Cordless-Impact-Wrench-Tool-Only-PCL265B/300000002';

  it('searches /s/<model> in one doorway tab, reads the product page, and returns brand, model, found, id, page model, price, title and link', async () => {
    const f = partFake({
      search: { PCL265B: [tool], DCD791B: ['/p/DEWALT-20V-MAX-XR-Drill-Driver-Tool-Only-DCD791B/300000020'] },
      pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99, 'ONE+ 18V Impact Wrench'), '300000020': productText('300000020', 'DEWALT', 'DCD791B', 159) },
    });
    const out = await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'PCL265B' }, { brand: 'DEWALT', model: 'DCD791B' }]);
    expect(out).toEqual([
      { brand: 'RYOBI', model: 'PCL265B', status: 'found', itemId: '300000002', matchedModel: 'PCL265B', price: 99, title: 'ONE+ 18V Impact Wrench', link: `https://www.homedepot.com${tool}` },
      {
        brand: 'DEWALT', model: 'DCD791B', status: 'found', itemId: '300000020', matchedModel: 'DCD791B', price: 159, title: 'DEWALT DCD791B title',
        link: 'https://www.homedepot.com/p/DEWALT-20V-MAX-XR-Drill-Driver-Tool-Only-DCD791B/300000020',
      },
    ]);
    expect(f.log[0]).toBe('open https://www.homedepot.com/s/PCL265B');
    expect(f.log).toContain('wait 7 30000');
    expect(f.log.filter((l) => l.startsWith('open'))).toHaveLength(1);
    expect(f.log.at(-1)).toBe('close 7');
    expect(f.searched).toEqual([['PCL265B', 'DCD791B']]);
    expect(f.fetched).toEqual([['300000002', '300000020']]);
  });

  it('waits settleMs once after the load, and pauses between its calls inside the tab', async () => {
    const f = partFake({ search: { PCL265B: [tool] }, pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99) } });
    await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'PCL265B' }]);
    expect(f.log).toEqual(['open https://www.homedepot.com/s/PCL265B', 'wait 7 30000', 'sleep 2500', 'search', 'sleep 1000', 'page', 'close 7']);
  });

  it('pauses between two calls only for what is left of the pause, like the page reader', async () => {
    const f = partFake({});
    let t = 0;
    const env: ReaderEnv = { ...f.env, sleep: async (ms) => { f.log.push(`sleep ${ms}`); t += ms; } };
    const read = createPartPriceReader(env, { now: () => t, settleMs: 0 });
    await read([{ brand: 'RYOBI', model: 'A1' }]);
    f.log.length = 0;
    await read([{ brand: 'RYOBI', model: 'A2' }]);
    expect(f.log.slice(0, 2)).toEqual(['sleep 1000', 'open https://www.homedepot.com/s/A2']);
    f.log.length = 0;
    t += 400;
    await read([{ brand: 'RYOBI', model: 'A3' }]);
    expect(f.log.slice(0, 2)).toEqual(['sleep 600', 'open https://www.homedepot.com/s/A3']);
  });

  it('opens no tab for no parts or blank models', async () => {
    const f = partFake({});
    expect(await createPartPriceReader(f.env)([])).toEqual([]);
    expect(await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: ' ' }])).toEqual([nothingFor('RYOBI', ' ')]);
    expect(f.log).toEqual([]);
  });

  it('never guesses an id: no link ending with the model is not found, with nulls, and fetches no product page', async () => {
    const f = partFake({ search: { PCL265B: ['/p/RYOBI-Impact-Wrench-Kit-PCL265K1/300000099'] } });
    const out = await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'PCL265B' }]);
    expect(out).toEqual([nothingFor('RYOBI', 'PCL265B', 'not_found')]);
    expect(f.fetched).toEqual([]);
  });

  it('is not found, with nulls, when the product page does not confirm the brand and model (a kit whose address ends with the part)', async () => {
    const kit = '/p/RYOBI-ONE-18V-Starter-Kit-PSK0114-PCL265B/300000003';
    const f = partFake({
      search: { PCL265B: [kit, tool], PBP004: ['/p/RYOBI-ONE-18V-6-Tool-Combo-Kit-PCL1600K2-PBP004/300000004'] },
      pages: { '300000003': productText('300000003', 'RYOBI', 'PSK0114-PCL265B', 79), '300000004': productText('300000004', 'RYOBI', 'PCL1600K2-PBP004', 249), '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99) },
    });
    const out = await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'PCL265B' }, { brand: 'RYOBI', model: 'PBP004' }]);
    // One id per model: the first link ends with the model, its page says it is the kit, so nothing, not the next link.
    expect(out).toEqual([nothingFor('RYOBI', 'PCL265B', 'not_found'), nothingFor('RYOBI', 'PBP004', 'not_found')]);
    expect(f.fetched).toEqual([['300000003', '300000004']]);
    // Another brand's page for the same model is not the part either.
    const g = partFake({ search: { PCL265B: [tool] }, pages: { '300000002': productText('300000002', 'DEWALT', 'PCL265B', 99) } });
    expect((await createPartPriceReader(g.env)([{ brand: 'RYOBI', model: 'PCL265B' }]))[0]).toEqual(nothingFor('RYOBI', 'PCL265B', 'not_found'));
  });

  it('RYOBI finds the tool-only twin, its page confirms it by sameModel, and matchedModel names the model on the page; DEWALT stays exact', async () => {
    const twin = '/p/RYOBI-ONE-18V-Cordless-Drill-Driver-Tool-Only-PCL206B/300000010';
    const f = partFake({
      search: { PCL206: [twin], DCD791: ['/p/DEWALT-20V-Drill-DCD791B/300000012'] },
      pages: { '300000010': productText('300000010', 'RYOBI', 'PCL206B', 59), '300000012': productText('300000012', 'DEWALT', 'DCD791B', 159) },
    });
    const out = await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'PCL206' }, { brand: 'DEWALT', model: 'DCD791' }]);
    expect(out[0]).toMatchObject({ model: 'PCL206', status: 'found', itemId: '300000010', matchedModel: 'PCL206B', price: 59 });
    expect(out[1]).toEqual(nothingFor('DEWALT', 'DCD791', 'not_found'));
    expect(f.fetched).toEqual([['300000010']]);
    // A page that names a different model (RYOBI PCL206BB) is not the twin.
    const g = partFake({ search: { PCL206: ['/p/RYOBI-Drill-PCL206B/300000010'] }, pages: { '300000010': productText('300000010', 'RYOBI', 'PCL206BB', 59) } });
    expect((await createPartPriceReader(g.env)([{ brand: 'RYOBI', model: 'PCL206' }]))[0]).toEqual(nothingFor('RYOBI', 'PCL206', 'not_found'));
  });

  it('a confirmed page that names no price is not found; it keeps the id, page model and link, with a null price', async () => {
    const f = partFake({ search: { PCL265B: [tool] }, pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', null) } });
    const [r] = await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'PCL265B' }]);
    expect(r).toMatchObject({ status: 'not_found', itemId: '300000002', matchedModel: 'PCL265B', price: null, link: `https://www.homedepot.com${tool}` });
  });

  it('a 200 page whose data cannot be parsed says nothing: not read', async () => {
    // Embedded data with no base-catalog entry for the id: parseProductPage reads nothing.
    const f = partFake({ search: { PCL265B: [tool] }, pages: { '300000002': 'window.__APOLLO_STATE__={}' } });
    const [r] = await createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'PCL265B' }]);
    expect(r).toEqual(nothingFor('RYOBI', 'PCL265B'));
  });

  it('looks each distinct part up once and answers every part asked, in order', async () => {
    const f = partFake({ search: { PCL265B: [tool] }, pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99) } });
    const out = await createPartPriceReader(f.env)([
      { brand: 'RYOBI', model: 'PCL265B' },
      { brand: 'RYOBI', model: 'pcl265b' },
      { brand: 'RYOBI', model: 'ZZZ1' },
    ]);
    expect(f.searched).toEqual([['PCL265B', 'ZZZ1']]);
    expect(out.map((o) => [o.model, o.status, o.price])).toEqual([['PCL265B', 'found', 99], ['pcl265b', 'found', 99], ['ZZZ1', 'not_found', null]]);
  });

  it('batches the searches, and looks up no more than its cap per call: the parts past it come back not_read', async () => {
    const models = Array.from({ length: 6 }, (_, i) => `M${i}`);
    const f = partFake({});
    const out = await createPartPriceReader(f.env, { batch: 2, cap: 4, settleMs: 0 })(models.map((model) => ({ brand: 'RYOBI', model })));
    expect(f.searched).toEqual([['M0', 'M1'], ['M2', 'M3']]);
    expect(out.map((o) => o.status)).toEqual(['not_found', 'not_found', 'not_found', 'not_found', 'not_read', 'not_read']);
    expect(out.every((o) => o.itemId === null)).toBe(true);
    expect(f.log.filter((l) => l === 'sleep 1000')).toHaveLength(1);
  });

  it("its default cap is the core's PART_PRICE_READS_MAX, the most a scan asks for in one call", async () => {
    const models = Array.from({ length: PART_PRICE_READS_MAX + 2 }, (_, i) => `M${i}`);
    const f = partFake({});
    const out = await createPartPriceReader(f.env, { settleMs: 0 })(models.map((model) => ({ brand: 'RYOBI', model })));
    expect(f.searched.flat()).toEqual(models.slice(0, PART_PRICE_READS_MAX));
    expect(out.filter((o) => o.status === 'not_read').map((o) => o.model)).toEqual(models.slice(PART_PRICE_READS_MAX));
  });

  it('stops at a refused search: no page is fetched after it, and no later search is made', async () => {
    const f = partFake({
      search: { A1: ['/p/RYOBI-X-A1/300000031'], A3: ['/p/RYOBI-X-A3/300000033'] },
      pages: { '300000031': productText('300000031', 'RYOBI', 'A1', 10), '300000033': productText('300000033', 'RYOBI', 'A3', 30) },
      searchStatus: (m) => (m === 'A2' ? 403 : 200),
    });
    const out = await createPartPriceReader(f.env, { batch: 3, settleMs: 0 })(['A1', 'A2', 'A3', 'A4'].map((model) => ({ brand: 'RYOBI', model })));
    expect(out.map((o) => o.price)).toEqual([null, null, null, null]);
    // Nothing was read: every part is not_read, so the scan saves none of them and asks again.
    expect(out.map((o) => o.status)).toEqual(['not_read', 'not_read', 'not_read', 'not_read']);
    expect(f.fetched).toEqual([]);
    expect(f.searched).toHaveLength(1);
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('stops at a refused product page (non-200) or one with no embedded data, and makes no later call', async () => {
    const search = { A1: ['/p/RYOBI-X-A1/300000031'], A2: ['/p/RYOBI-X-A2/300000032'], A3: ['/p/RYOBI-X-A3/300000033'] };
    const pages = { '300000031': productText('300000031', 'RYOBI', 'A1', 10), '300000032': productText('300000032', 'RYOBI', 'A2', 20), '300000033': productText('300000033', 'RYOBI', 'A3', 30) };
    const parts = ['A1', 'A2', 'A3'].map((model) => ({ brand: 'RYOBI', model }));
    const refused = partFake({ search, pages, pageStatus: (id) => (id === '300000032' ? 403 : 200) });
    // Batch of 2: A1 read, A2 refused, so A3's search is never made.
    const out = await createPartPriceReader(refused.env, { batch: 2, settleMs: 0 })(parts);
    expect(out.map((o) => o.price)).toEqual([10, null, null]);
    expect(out.map((o) => o.status)).toEqual(['found', 'not_read', 'not_read']);
    expect(refused.searched).toEqual([['A1', 'A2']]);
    expect(refused.log.at(-1)).toBe('close 7');
    const nodata = partFake({ search, pages: { ...pages, '300000032': '<html>blocked</html>' } });
    const out2 = await createPartPriceReader(nodata.env, { batch: 2, settleMs: 0 })(parts);
    expect(out2.map((o) => o.price)).toEqual([10, null, null]);
    expect(out2.map((o) => o.status)).toEqual(['found', 'not_read', 'not_read']);
    expect(nodata.searched).toHaveLength(1);
  });

  it('an empty script result (undefined) is a refusal: everything null, tab closed', async () => {
    const f = partFake({});
    const env: ReaderEnv = { ...f.env, runInTab: (async () => undefined) as ReaderEnv['runInTab'] };
    const out = await createPartPriceReader(env, { settleMs: 0 })([{ brand: 'RYOBI', model: 'A1' }, { brand: 'RYOBI', model: 'A2' }]);
    expect(out).toEqual([nothingFor('RYOBI', 'A1'), nothingFor('RYOBI', 'A2')]);
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('throws when the doorway does not load, closes the tab, and closes a doorway left by a stopped worker first', async () => {
    const f = partFake({});
    f.env.waitForLoad = async () => { throw new Error('timeout'); };
    await expect(createPartPriceReader(f.env)([{ brand: 'RYOBI', model: 'A1' }])).rejects.toThrow('The Home Depot tab did not load.');
    expect(f.log.at(-1)).toBe('close 7');
    const g = partFake({ stored: 99 });
    await createPartPriceReader(g.env, { settleMs: 0 })([{ brand: 'RYOBI', model: 'A1' }]);
    expect(g.log.slice(0, 2)).toEqual(['close 99', 'open https://www.homedepot.com/s/A1']);
  });
});

describe('fetchSearchesInTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs from its own source: collects the product links of the page in order, once each, and the address a search ended at', async () => {
    const asked: string[] = [];
    vi.stubGlobal('location', { href: 'https://www.homedepot.com/s/PCL265B' });
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      if (url.includes('NONE')) return { status: 200, url: 'https://www.homedepot.com/s/NONE', text: async () => '<html>no results</html>' };
      const body =
        '<a href="/p/RYOBI-Wrench-Tool-Only-PCL265B/300000002">x</a><a href="https://www.homedepot.com/p/RYOBI-Wrench-Tool-Only-PCL265B/300000002?x=1">y</a>' +
        '<a href="/p/RYOBI-Kit-PSK0114-PCL265B/300000003">z</a> /p/short/123 /p/RYOBI-Too-Long/1234567890';
      return { status: 200, url: 'https://www.homedepot.com/p/RYOBI-Final-Tool/300000001', text: async () => body };
    });
    const rebuilt = new Function(`return (${fetchSearchesInTab.toString()})`)() as typeof fetchSearchesInTab;
    const out = await rebuilt(['PCL265B', 'NONE'], 2);
    expect(asked).toEqual(['/s/PCL265B', '/s/NONE']);
    expect(out[0]).toEqual({
      model: 'PCL265B',
      status: 200,
      links: ['/p/RYOBI-Final-Tool/300000001', '/p/RYOBI-Wrench-Tool-Only-PCL265B/300000002', '/p/RYOBI-Kit-PSK0114-PCL265B/300000003'],
    });
    // No product link at all is a search with no result, status 200.
    expect(out[1]).toEqual({ model: 'NONE', status: 200, links: [] });
    // The model is encoded into the path.
    const encoded = await rebuilt(['A B/C'], 1);
    expect(asked.at(-1)).toBe('/s/A%20B%2FC');
    expect(encoded[0]?.status).toBe(200);
  });

  it('starts no fetch after a refusal or a throw; models it never fetched come back with status -1', async () => {
    vi.stubGlobal('location', { href: 'https://www.homedepot.com/' });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      if (url === '/s/B') return { status: 403, url: 'https://www.homedepot.com/s/B', text: async () => 'no' };
      if (url === '/s/D') throw new Error('network');
      return { status: 200, url: 'https://www.homedepot.com/s/x', text: async () => '' };
    });
    const rebuilt = new Function(`return (${fetchSearchesInTab.toString()})`)() as typeof fetchSearchesInTab;
    const out = await rebuilt(['A', 'B', 'C', 'D'], 1);
    expect(asked).toEqual(['/s/A', '/s/B']);
    expect(out.map((o) => o.status)).toEqual([200, 403, -1, -1]);
    expect(out[1]).toEqual({ model: 'B', status: 403, links: null });
    const threw = await rebuilt(['D', 'E'], 1);
    expect(threw.map((o) => o.status)).toEqual([0, -1]);
  });
});
