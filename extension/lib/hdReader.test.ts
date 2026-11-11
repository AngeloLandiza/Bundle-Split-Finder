import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPageReader, doorwayLoaded, fetchPagesInTab, type InTabResult, type ReaderEnv, waitForDoorway } from './hdReader';

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
    const read = createPageReader(env, { now: () => t });
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
