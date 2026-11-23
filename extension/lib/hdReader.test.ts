import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PART_PRICE_READS_MAX } from '@core/scan/types';
import {
  createPageReader,
  createItemPriceReader,
  createPartPriceReader,
  doorwayLoaded,
  doorwayStateInTab,
  type DoorwayState,
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
  /** The doorway tab's own document at each check (default: its state is there). */
  doorway?: () => DoorwayState;
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
    runInTab: (async (_tab: number, func: unknown, args: [string[], number]) => {
      if (func === doorwayStateInTab) {
        // The doorway's own document: its state is there unless the test says otherwise.
        log.push('state');
        return opts.doorway ? opts.doorway() : { state: true, title: 'Home Depot page' };
      }
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

  it('a 200 without the page state is unreadable with its title, not a refusal, and the next page is read', async () => {
    const f = fake({ respond: (id) => (id === ids[0] ? { itemId: id, status: 200, text: null, note: 'Oops! Something went wrong' } : byId.get(id)!) });
    const out = await createPageReader(f.env)(ids.slice(0, 3));
    expect(out[0]).toEqual({ itemId: ids[0], kind: 'unreadable', note: 'Oops! Something went wrong' });
    expect(out.slice(1).map((o) => o.kind)).toEqual(['read', 'read']);
  });

  it('two 200s in a row without the page state stop the reading: the rest are skipped, across batches too', async () => {
    const bare = (id: string): InTabResult => ({ itemId: id, status: 200, text: null, note: 'Access Denied' });
    const f = fake({ respond: (id) => (id === ids[1] || id === ids[2] ? bare(id) : byId.get(id)!) });
    const out = await createPageReader(f.env, { batch: 2 })(ids.slice(0, 6));
    expect(out.map((o) => o.kind)).toEqual(['read', 'unreadable', 'unreadable', 'skipped', 'skipped', 'skipped']);
    expect(f.batches).toHaveLength(2);
    // The run in a row is handed to the next batch's in-tab fetch, so the tab stops there too.
    const calls: unknown[][] = [];
    const g = fake({ respond: (id) => (id === ids[1] ? bare(id) : byId.get(id)!) });
    const run = g.env.runInTab;
    g.env.runInTab = (async (tab: number, func: never, args: never[]) => {
      if (func === (fetchPagesInTab as never)) calls.push(args);
      return run(tab, func, args);
    }) as ReaderEnv['runInTab'];
    await createPageReader(g.env, { batch: 2 })(ids.slice(0, 4));
    expect(calls.map((a) => [a[2], a[3]])).toEqual([[0, 2], [1, 2]]);
    // One unreadable between two read pages does not stop anything.
    const h = fake({ respond: (id) => (id === ids[1] || id === ids[3] ? bare(id) : byId.get(id)!) });
    expect((await createPageReader(h.env)(ids.slice(0, 5))).map((o) => o.kind)).toEqual(['read', 'unreadable', 'read', 'unreadable', 'read']);
  });

  it('checks the doorway tab has its own page state before the first fetch, polling until it shows', async () => {
    let checks = 0;
    const f = fake({ doorway: () => ({ state: ++checks >= 3, title: 'Home Depot' }) });
    const out = await createPageReader(f.env, { settleMs: 0 })(ids.slice(0, 2));
    expect(out.map((o) => o.kind)).toEqual(['read', 'read']);
    expect(f.log.filter((l) => l === 'state')).toHaveLength(3);
    expect(f.log.filter((l) => l === 'sleep 500')).toHaveLength(2);
    expect(f.log.lastIndexOf('state')).toBeLessThan(f.log.indexOf('run'));
  });

  it('a doorway whose own page never shows its state is the refusal: no page is fetched, its title is said', async () => {
    const f = fake({ doorway: () => ({ state: false, title: 'Access Denied' }) });
    const out = await createPageReader(f.env, { settleMs: 0, doorwayStateMs: 2000 })(ids.slice(0, 3));
    expect(out).toEqual([
      { itemId: ids[0], kind: 'refused', note: 'Access Denied' },
      { itemId: ids[1], kind: 'skipped' },
      { itemId: ids[2], kind: 'skipped' },
    ]);
    expect(f.batches).toEqual([]);
    // Checked at 0, 500, 1000, 1500 and 2000 ms, then given up.
    expect(f.log.filter((l) => l === 'state')).toHaveLength(5);
    expect(f.log.at(-1)).toBe('close 7');
    // A check that throws (Chrome's own error page) is no state, and the tab still closes.
    const g = fake();
    const run = g.env.runInTab;
    g.env.runInTab = (async (tab: number, func: never, args: never[]) => {
      if (func === (doorwayStateInTab as never)) throw new Error('Cannot access contents of the page');
      return run(tab, func, args);
    }) as ReaderEnv['runInTab'];
    const threw = await createPageReader(g.env, { settleMs: 0, doorwayStateMs: 0 })(ids.slice(0, 2));
    expect(threw).toEqual([{ itemId: ids[0], kind: 'refused' }, { itemId: ids[1], kind: 'skipped' }]);
    expect(g.log.at(-1)).toBe('close 7');
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
      // 'b' answers at once (microtasks only); 'a' waits one macrotask, so 'b' is always refused first however busy the machine.
      if (id !== 'b') await new Promise((r) => setImmediate(r));
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

  it('a 200 without the state carries its title; it stops only at the limit of such pages in a row', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const id = url.split('/').pop()!;
      if (id === 'a' || id === 'c') return { status: 200, text: async () => '<html><head><title>\n  Access   Denied </title></head><body>no</body></html>' };
      if (id === 'd') return { status: 200, text: async () => '<p>Please verify you are a human</p>' };
      return { status: 200, text: async () => 'window.__APOLLO_STATE__={}</script>' };
    });
    const rebuilt = new Function(`return (${fetchPagesInTab.toString()})`)() as typeof fetchPagesInTab;
    const out = await rebuilt(['a', 'b', 'c', 'd', 'e'], 1, 0, 2);
    expect(out[0]).toEqual({ itemId: 'a', status: 200, text: null, note: 'Access Denied' });
    expect(out[1]).toEqual({ itemId: 'b', status: 200, text: 'window.__APOLLO_STATE__={}' });
    expect(out[3]).toEqual({ itemId: 'd', status: 200, text: null, note: 'Please verify you are a human' });
    expect(out[4]).toEqual({ itemId: 'e', status: -1, text: null });
    // The run the last batch ended on counts: one more such page stops it.
    const again = await rebuilt(['a', 'b'], 1, 1, 2);
    expect(again.map((o) => o.status)).toEqual([200, -1]);
    // The defaults (the part price readers) stop at the first one, as before.
    expect((await rebuilt(['a', 'b'], 1)).map((o) => o.status)).toEqual([200, -1]);
  });

  it('runs from its own source against a stubbed fetch, in input order, within the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    // 'a' stays in flight until 'c' has thrown, so the worker that finishes 'a' can never reach 'd' first (no timing).
    let cThrew!: () => void;
    const afterC = new Promise<void>((r) => (cThrew = r));
    vi.stubGlobal('fetch', async (url: string) => {
      const id = url.split('/').pop()!;
      active++;
      peak = Math.max(peak, active);
      if (id === 'a') await afterC;
      active--;
      if (id === 'c') {
        cThrew();
        throw new Error('network');
      }
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
  /** Searches that answer 200 without the page state (a cold session): their <title>. */
  searchEmpty?: (model: string) => string | null;
  stored?: number | null;
  /** The doorway tab's own document at each check (default: its state is there). */
  doorway?: () => DoorwayState;
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
      if (func === doorwayStateInTab) return opts.doorway ? opts.doorway() : { state: true, title: 'Home Depot' };
      if (func === fetchSearchesInTab) {
        log.push('search');
        searched.push(args[0]);
        const out: SearchInTab[] = args[0].map((model) => {
          const status = opts.searchStatus?.(model) ?? 200;
          const empty = status === 200 ? (opts.searchEmpty?.(model) ?? null) : null;
          if (empty !== null) return { model, status, links: null, note: empty };
          return { model, status, links: status === 200 ? (opts.search?.[model] ?? []) : null };
        });
        // As fetchSearchesInTab: nothing is fetched after a refusal, nor after two unreadable answers in a row (counting the caller's run).
        let run = (args as unknown as [string[], number, number?])[2] ?? 0;
        let stopAt = -1;
        out.forEach((o, i) => {
          if (stopAt >= 0) return;
          if (o.status !== 200) stopAt = i;
          else if (o.links === null && ++run >= 2) stopAt = i;
          else if (o.links !== null) run = 0;
        });
        return out.map((o, i) => (stopAt >= 0 && i > stopAt ? { model: o.model, status: -1, links: null } : o));
      }
      log.push('page');
      fetched.push(args[0]);
      const out: InTabResult[] = args[0].map((id) => {
        const status = opts.pageStatus?.(id) ?? (opts.pages?.[id] === undefined ? 404 : 200);
        const text = status === 200 ? (opts.pages?.[id] ?? null) : null;
        // As fetchPagesInTab: a 200 page with no embedded data has no text.
        return { itemId: id, status, text: text !== null && text.includes('window.__APOLLO_STATE__=') ? text : null };
      });
      // As fetchPagesInTab: nothing is fetched after a refusal, nor after two 200s without the state in a row (counting the caller's run).
      let run = (args as unknown as [string[], number, number?])[2] ?? 0;
      let stopAt = -1;
      out.forEach((o, i) => {
        if (stopAt >= 0) return;
        if (o.status !== 200) stopAt = i;
        else if (o.text === null && ++run >= 2) stopAt = i;
        else if (o.text !== null) run = 0;
      });
      return out.map((o, i) => (stopAt >= 0 && i > stopAt ? { itemId: o.itemId, status: -1, text: null } : o));
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
    // One 200 without the page state (Nov 23) is that part not read, not a refusal: the next batch is still searched and read.
    const nodata = partFake({ search, pages: { ...pages, '300000032': '<html>blocked</html>' } });
    const out2 = await createPartPriceReader(nodata.env, { batch: 2, settleMs: 0 })(parts);
    expect(out2.map((o) => o.price)).toEqual([10, null, 30]);
    expect(out2.map((o) => o.status)).toEqual(['found', 'not_read', 'found']);
    expect(nodata.searched).toHaveLength(2);
  });

  it('Nov 23: waits for the doorway to show its state (a cold tab: 2 s) before the first search, then reads fine', async () => {
    let checks = 0;
    const f = partFake({
      search: { PCL265B: [tool] }, pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99) },
      doorway: () => ({ state: ++checks >= 5, title: 'Home Depot' }),
    });
    const out = await createPartPriceReader(f.env, { settleMs: 0 })([{ brand: 'RYOBI', model: 'PCL265B' }]);
    expect(out[0]).toMatchObject({ status: 'found', price: 99 });
    expect(f.log.filter((l) => l === 'sleep 500')).toHaveLength(4);
    expect(f.log.indexOf('search')).toBeGreaterThan(f.log.lastIndexOf('sleep 500'));
  });

  it('Nov 23: a doorway that never shows its state is the refusal: nothing is searched, every part is not_read, the tab closes', async () => {
    const f = partFake({ search: { PCL265B: [tool] }, doorway: () => ({ state: false, title: 'Access Denied' }) });
    const out = await createPartPriceReader(f.env, { settleMs: 0, doorwayStateMs: 2000 })([{ brand: 'RYOBI', model: 'PCL265B' }, { brand: 'RYOBI', model: 'A2' }]);
    expect(out).toEqual([nothingFor('RYOBI', 'PCL265B'), nothingFor('RYOBI', 'A2')]);
    expect(f.searched).toEqual([]);
    expect(f.fetched).toEqual([]);
    expect(f.log.at(-1)).toBe('close 7');
  });

  it('Nov 23: one search that comes back 200 without its state is that part not_read (not not_found); the next parts are read', async () => {
    const f = partFake({
      search: { A1: ['/p/RYOBI-X-A1/300000031'], A3: ['/p/RYOBI-X-A3/300000033'] },
      pages: { '300000031': productText('300000031', 'RYOBI', 'A1', 10), '300000033': productText('300000033', 'RYOBI', 'A3', 30) },
      searchEmpty: (m) => (m === 'A2' ? 'Home Depot' : null),
    });
    const out = await createPartPriceReader(f.env, { batch: 3, settleMs: 0 })(['A1', 'A2', 'A3'].map((model) => ({ brand: 'RYOBI', model })));
    expect(out.map((o) => o.status)).toEqual(['found', 'not_read', 'found']);
    expect(f.fetched).toEqual([['300000031', '300000033']]);
  });

  it('Nov 23: two unreadable answers in a row end the call; the parts after them are not_read and nothing more is searched or fetched', async () => {
    const f = partFake({ search: { A1: ['/p/RYOBI-X-A1/300000031'] }, pages: { '300000031': productText('300000031', 'RYOBI', 'A1', 10) }, searchEmpty: (m) => (m === 'A2' || m === 'A3' ? 'Home Depot' : null) });
    const out = await createPartPriceReader(f.env, { batch: 2, settleMs: 0 })(['A2', 'A3', 'A1', 'A4'].map((model) => ({ brand: 'RYOBI', model })));
    expect(out.map((o) => o.status)).toEqual(['not_read', 'not_read', 'not_read', 'not_read']);
    expect(f.searched).toEqual([['A2', 'A3']]);
    expect(f.fetched).toEqual([]);
    expect(f.log.at(-1)).toBe('close 7');
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
      if (url.includes('NONE')) return { status: 200, url: 'https://www.homedepot.com/s/NONE', text: async () => '<html>no results<script>window.__APOLLO_STATE__={}</script></html>' };
      const body =
        '<script>window.__APOLLO_STATE__={}</script><a href="/p/RYOBI-Wrench-Tool-Only-PCL265B/300000002">x</a><a href="https://www.homedepot.com/p/RYOBI-Wrench-Tool-Only-PCL265B/300000002?x=1">y</a>' +
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
      return { status: 200, url: 'https://www.homedepot.com/s/x', text: async () => 'window.__APOLLO_STATE__={}' };
    });
    const rebuilt = new Function(`return (${fetchSearchesInTab.toString()})`)() as typeof fetchSearchesInTab;
    const out = await rebuilt(['A', 'B', 'C', 'D'], 1);
    expect(asked).toEqual(['/s/A', '/s/B']);
    expect(out.map((o) => o.status)).toEqual([200, 403, -1, -1]);
    expect(out[1]).toEqual({ model: 'B', status: 403, links: null });
    const threw = await rebuilt(['D', 'E'], 1);
    expect(threw.map((o) => o.status)).toEqual([0, -1]);
  });

  it('Nov 23: a 200 without the page state is not a search with no result: links null and its title as the note; two in a row (counting the caller\'s run) stop it', async () => {
    vi.stubGlobal('location', { href: 'https://www.homedepot.com/' });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return { status: 200, url: `https://www.homedepot.com${url}`, text: async () => (url === '/s/B' ? '<html><head><title> Home   Depot </title></head></html>' : 'window.__APOLLO_STATE__={}') };
    });
    const rebuilt = new Function(`return (${fetchSearchesInTab.toString()})`)() as typeof fetchSearchesInTab;
    const out = await rebuilt(['A', 'B', 'C'], 1, 0, 2);
    expect(out[1]).toEqual({ model: 'B', status: 200, links: null, note: 'Home Depot' });
    expect(out.map((o) => o.status)).toEqual([200, 200, 200]);
    // The caller's last call ended on one empty page: this one is the second in a row, so C is never fetched.
    asked.length = 0;
    const carried = await rebuilt(['B', 'C'], 1, 1, 2);
    expect(asked).toEqual(['/s/B']);
    expect(carried.map((o) => o.status)).toEqual([200, -1]);
  });
});

describe('createItemPriceReader (the partPrice job)', () => {
  it('reads the product page of the item id in one doorway tab, takes the brand from the page, and checks the model against it', async () => {
    const f = partFake({ pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99, 'ONE+ 18V Impact Wrench') } });
    expect(await createItemPriceReader(f.env, { settleMs: 0 })('300000002', 'PCL265B')).toEqual({
      brand: 'RYOBI', model: 'PCL265B', status: 'found', itemId: '300000002', matchedModel: 'PCL265B', price: 99, title: 'ONE+ 18V Impact Wrench', link: 'https://www.homedepot.com/p/300000002',
    });
    expect(f.log).toEqual(['open https://www.homedepot.com/p/300000002', 'wait 7 30000', 'page', 'close 7']);
    expect(f.fetched).toEqual([['300000002']]);
  });

  it("RYOBI's tool-only twin counts as the model (sameModel), and the page's own model is what is reported", async () => {
    const f = partFake({ pages: { '300000010': productText('300000010', 'RYOBI', 'PCL206B', 59) } });
    expect(await createItemPriceReader(f.env, { settleMs: 0 })('300000010', 'PCL206')).toMatchObject({ status: 'found', model: 'PCL206', matchedModel: 'PCL206B', price: 59 });
  });

  it('a page for another model is not found, with no price; a page with no price is not found; the id is never taken on trust', async () => {
    const other = partFake({ pages: { '300000003': productText('300000003', 'RYOBI', 'PSK0114-PCL265B', 79) } });
    expect(await createItemPriceReader(other.env, { settleMs: 0 })('300000003', 'PCL265B')).toMatchObject({ status: 'not_found', price: null, itemId: '300000003', matchedModel: 'PSK0114-PCL265B', link: null });
    const free = partFake({ pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', null) } });
    expect(await createItemPriceReader(free.env, { settleMs: 0 })('300000002', 'PCL265B')).toMatchObject({ status: 'not_found', itemId: '300000002', price: null });
  });

  it('a 404 is not found; a refusal, or a page with no data, says nothing (not_read) and is not retried', async () => {
    const gone = partFake({});
    expect(await createItemPriceReader(gone.env, { settleMs: 0 })('300000002', 'PCL265B')).toMatchObject({ status: 'not_found', price: null });
    const refused = partFake({ pageStatus: () => 403 });
    expect(await createItemPriceReader(refused.env, { settleMs: 0 })('300000002', 'PCL265B')).toMatchObject({ status: 'not_read', itemId: null, price: null });
    expect(refused.fetched).toHaveLength(1);
    const nodata = partFake({ pages: { '300000002': 'window.__APOLLO_STATE__={}' } });
    expect(await createItemPriceReader(nodata.env, { settleMs: 0 })('300000002', 'PCL265B')).toMatchObject({ status: 'not_read' });
  });

  it('Nov 23: waits for the doorway to show its state before the fetch; a doorway that never does is not_read with nothing fetched', async () => {
    let checks = 0;
    const cold = partFake({ pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99) }, doorway: () => ({ state: ++checks >= 5, title: 'Home Depot' }) });
    expect(await createItemPriceReader(cold.env, { settleMs: 0 })('300000002', 'PCL265B')).toMatchObject({ status: 'found', price: 99 });
    expect(cold.log.filter((l) => l === 'sleep 500')).toHaveLength(4);
    expect(cold.log.indexOf('page')).toBeGreaterThan(cold.log.lastIndexOf('sleep 500'));
    const never = partFake({ pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99) }, doorway: () => ({ state: false, title: 'Access Denied' }) });
    expect(await createItemPriceReader(never.env, { settleMs: 0, doorwayStateMs: 1000 })('300000002', 'PCL265B')).toMatchObject({ status: 'not_read', price: null });
    expect(never.fetched).toEqual([]);
    expect(never.log.at(-1)).toBe('close 7');
  });

  it('closes a doorway a stopped worker left, pauses between two calls, and closes its own tab when the load fails', async () => {
    const f = partFake({ stored: 5, pages: { '300000002': productText('300000002', 'RYOBI', 'PCL265B', 99) } });
    let t = 0;
    const env: ReaderEnv = { ...f.env, sleep: async (ms) => { f.log.push(`sleep ${ms}`); t += ms; } };
    const read = createItemPriceReader(env, { now: () => t, settleMs: 0 });
    await read('300000002', 'PCL265B');
    expect(f.log.slice(0, 2)).toEqual(['close 5', 'open https://www.homedepot.com/p/300000002']);
    f.log.length = 0;
    await read('300000002', 'PCL265B');
    expect(f.log.slice(0, 2)).toEqual(['sleep 1000', 'open https://www.homedepot.com/p/300000002']);
    const g = partFake({});
    g.env.waitForLoad = async () => { throw new Error('timeout'); };
    await expect(createItemPriceReader(g.env, { settleMs: 0 })('300000002', 'X')).rejects.toThrow('The Home Depot tab did not load.');
    expect(g.log.at(-1)).toBe('close 7');
  });
});
