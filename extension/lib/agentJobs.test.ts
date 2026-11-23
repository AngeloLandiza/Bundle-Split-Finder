import { describe, expect, it } from 'vitest';
import type { WorkerResultBody } from '@core/api/contract';
import type { PageOutcome, PartPriceReading } from '@core/scan/types';
import { appJobDeps, createJobLoop, runJob, type Job, type JobLoopDeps, type NextJob } from './agentJobs';
import { createAgentApi } from './agentApi';
import { createLock, lockedReaders, type Readers } from './doorwayLock';
import { createLinkStore, type KeyValue } from './agentLink';

const read = (itemId: string): PageOutcome => ({ itemId, kind: 'read', content: { bullets: ['Includes a drill'], description: null } });
const reading = (over: Partial<PartPriceReading> = {}): PartPriceReading => ({ brand: 'RYOBI', model: 'PCL206', status: 'found', itemId: '100', matchedModel: 'PCL206', price: 49, title: 'Drill', link: 'https://www.homedepot.com/p/100', ...over });

function readers(over: Partial<Readers> = {}): { readers: Readers; log: string[] } {
  const log: string[] = [];
  const base: Readers = {
    readPages: async (ids) => (log.push(`pages ${ids.join(',')}`), ids.map(read)),
    readPartPrices: async () => [],
    readItemPrice: async (id, model) => (log.push(`price ${id} ${model}`), reading({ itemId: id })),
    researchTools: {
      forQuestion: () =>
        ({
          readHomeDepotPage: async (i: { itemId: string }) => (log.push(`research ${i.itemId}`), { sourceId: `hd-page:${i.itemId}`, label: 'Home Depot page', url: `https://www.homedepot.com/p/${i.itemId}`, sections: [] }),
          searchHomeDepot: async (i: { query: string }) => (log.push(`search ${i.query}`), { sourceId: 'hd-search:x', label: 'Home Depot search', url: 'https://www.homedepot.com/s/x', results: [] }),
        }) as never,
    },
  };
  return { readers: { ...base, ...over }, log };
}

describe('runJob', () => {
  it('page reads the item ids and answers the extension\'s own outcomes, in order', async () => {
    const { readers: r, log } = readers();
    expect(await runJob({ kind: 'page', input: { itemIds: ['300', '301'] } }, r)).toEqual({ ok: true, result: [read('300'), read('301')] });
    expect(log).toEqual(['pages 300,301']);
  });

  it('kitPage answers the one outcome for the kit; a page the reader did not name is unreadable', async () => {
    const { readers: r } = readers();
    expect(await runJob({ kind: 'kitPage', input: { itemId: '300', model: 'PCL1600K2' } }, r)).toEqual({ ok: true, result: read('300') });
    const { readers: none } = readers({ readPages: async () => [] });
    expect(await runJob({ kind: 'kitPage', input: { itemId: '300', model: 'X' } }, none)).toEqual({ ok: true, result: { itemId: '300', kind: 'unreadable' } });
  });

  it('partPrice reads the product page of the item id and the model it was told', async () => {
    const { readers: r, log } = readers();
    expect(await runJob({ kind: 'partPrice', input: { itemId: '100', model: 'PCL206' } }, r)).toEqual({ ok: true, result: reading() });
    expect(log).toEqual(['price 100 PCL206']);
  });

  it('search reads the first page; a later page is refused in words, and a tool error is a failure with its sentence', async () => {
    const { readers: r, log } = readers();
    const ok = await runJob({ kind: 'search', input: { query: 'ryobi drill', page: 1 } }, r);
    expect(ok).toMatchObject({ ok: true, result: { label: 'Home Depot search' } });
    expect(await runJob({ kind: 'search', input: { query: 'ryobi drill', page: 2 } }, r)).toEqual({ ok: false, error: 'Only the first page of a Home Depot search is read.' });
    expect(log).toEqual(['search ryobi drill']);
    const refused = readers({ researchTools: { forQuestion: () => ({ searchHomeDepot: async () => ({ error: 'Home Depot refused the search (HTTP 403); no more are made for this question.' }) }) as never } });
    expect(await runJob({ kind: 'search', input: { query: 'x' } }, refused.readers)).toEqual({ ok: false, error: 'Home Depot refused the search (HTTP 403); no more are made for this question.' });
  });

  it('researchPage reads the page through the research tool and answers its page, or its tool error as the result', async () => {
    const { readers: r, log } = readers();
    expect(await runJob({ kind: 'researchPage', input: { itemId: '328690510' } }, r)).toMatchObject({ ok: true, result: { label: 'Home Depot page' } });
    expect(log).toEqual(['research 328690510']);
    expect(await runJob({ kind: 'researchPage', input: { itemId: 'abc' } }, r)).toMatchObject({ ok: false });
    const refused = readers({ researchTools: { forQuestion: () => ({ readHomeDepotPage: async () => ({ error: 'Home Depot refused the page (HTTP 403).' }) }) as never } });
    expect(await runJob({ kind: 'researchPage', input: { itemId: '328690510' } }, refused.readers)).toEqual({ ok: true, result: { error: 'Home Depot refused the page (HTTP 403).' } });
  });

  it('refuses input that is not digits, names no model, or is too long, and reads nothing', async () => {
    const { readers: r, log } = readers();
    for (const job of [
      { kind: 'page' as const, input: { itemIds: ['../../etc'] } },
      { kind: 'page' as const, input: { itemIds: [] } },
      { kind: 'page' as const, input: { itemIds: Array.from({ length: 51 }, (_, i) => String(100 + i)) } },
      { kind: 'kitPage' as const, input: { itemId: '12a', model: 'X' } },
      { kind: 'partPrice' as const, input: { itemId: '100', model: '  ' } },
      { kind: 'search' as const, input: { query: 'x'.repeat(201) } },
      { kind: 'search' as const, input: 'ryobi' },
    ]) {
      expect(await runJob(job, r), JSON.stringify(job)).toMatchObject({ ok: false });
    }
    expect(await runJob({ kind: 'bogus' as never, input: {} }, r)).toMatchObject({ ok: false });
    expect(log).toEqual([]);
  });

  it('Nov 23: a kind this build does not know is answered as an outdated helper, never a Home Depot failure', async () => {
    const { readers: r, log } = readers();
    expect(await runJob({ kind: 'nextYear' as never, input: {} }, r)).toEqual({ ok: false, error: 'This browser does not know that kind of job.', outdated: true });
    expect(await runJob({ kind: 'reload', input: {} }, r)).toEqual({ ok: true, result: { reloading: true } });
    expect(log).toEqual([]);
  });

  it('a reader that throws is a failure with its sentence, not a crash', async () => {
    const { readers: r } = readers({ readPages: async () => Promise.reject(new Error('The Home Depot tab did not load.')) });
    expect(await runJob({ kind: 'page', input: { itemIds: ['300'] } }, r)).toEqual({ ok: false, error: 'The Home Depot tab did not load.' });
  });
});

describe('the doorway lock', () => {
  it('lets a scan\'s page read and a job\'s page read take the doorway one after the other, never together', async () => {
    let open = 0;
    let most = 0;
    const slow = async <T>(v: T): Promise<T> => {
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return v;
    };
    const raw: Readers = {
      readPages: (ids) => slow(ids.map(read)),
      readPartPrices: (parts) => slow(parts.map((p) => reading({ model: p.model }))),
      readItemPrice: (id) => slow(reading({ itemId: id })),
      researchTools: { forQuestion: () => ({ readHomeDepotPage: () => slow({ error: 'x' }), searchHomeDepot: () => slow({ error: 'x' }) }) as never },
    };
    const shared = lockedReaders(createLock(), raw);
    const tools = shared.researchTools.forQuestion();
    await Promise.all([
      shared.readPages(['1']),
      shared.readPartPrices([{ brand: 'RYOBI', model: 'A' }]),
      shared.readItemPrice('2', 'B'),
      tools.readHomeDepotPage({ itemId: '123456789' }),
      tools.searchHomeDepot({ query: 'x' }),
    ]);
    expect(most).toBe(1);
  });

  it('a failed read does not hold up the next', async () => {
    const lock = createLock();
    await expect(lock(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await lock(async () => 7)).toBe(7);
  });
});

// ---------------------------------------------------------------- the loop

const job = (id: string, kind: Job['kind'] = 'page', input: unknown = { itemIds: ['300'] }): NextJob => ({ kind: 'job', job: { id, kind, input: input as never, attempt: 1 } });

function loopWorld(script: NextJob[], over: Partial<JobLoopDeps> = {}) {
  let clock = 1_000_000;
  const results: WorkerResultBody[] = [];
  const done: number[] = [];
  const events: string[] = [];
  const beats: (() => void)[] = [];
  let unpaired = 0;
  let polls = 0;
  const deps: JobLoopDeps = {
    next: async () => {
      polls++;
      const n = script.shift();
      if (n === undefined) {
        clock += 25_000;
        return { kind: 'none' };
      }
      if (n.kind === 'none') clock += 25_000;
      return n;
    },
    result: async (b) => (results.push(b), events.push(`result ${b.id}`), 'sent'),
    heartbeat: async (id) => void events.push(id === undefined ? 'beat' : `beat ${id}`),
    run: async (j) => (events.push(`run ${j.id}`), { ok: true, result: `r-${j.id}` }),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    onJobDone: (at) => void done.push(at),
    onUnpaired: () => void unpaired++,
    every: (_ms, fn) => (beats.push(fn), () => void beats.splice(beats.indexOf(fn), 1)),
    ...over,
  };
  return { loop: createJobLoop(deps), results, done, events, beats, unpaired: () => unpaired, polls: () => polls, now: () => clock };
}

describe('the job loop', () => {
  it('runs jobs one at a time in the order the app gave them, posts each result, and notes when the last one finished', async () => {
    const w = loopWorld([job('j1'), job('j2')], { idleStopMs: 60_000 });
    await w.loop.start();
    // Nov 23: a heartbeat first, so the app learns this build at once.
    expect(w.events).toEqual(['beat', 'run j1', 'result j1', 'run j2', 'result j2']);
    expect(w.results).toEqual([
      { id: 'j1', ok: true, result: 'r-j1' },
      { id: 'j2', ok: true, result: 'r-j2' },
    ]);
    expect(w.done).toHaveLength(2);
  });

  it('a failed job posts its sentence as the failure, and the loop goes on', async () => {
    const w = loopWorld([job('j1'), job('j2')], {
      idleStopMs: 30_000,
      run: async (j) => (j.id === 'j1' ? { ok: false, error: 'The Home Depot tab did not load.' } : { ok: true, result: 1 }),
    });
    await w.loop.start();
    expect(w.results).toEqual([
      { id: 'j1', ok: false, error: 'The Home Depot tab did not load.' },
      { id: 'j2', ok: true, result: 1 },
    ]);
  });

  it('a run that throws is posted as a failure; it does not end the loop', async () => {
    const w = loopWorld([job('j1'), job('j2')], { idleStopMs: 30_000, run: async (j) => (j.id === 'j1' ? Promise.reject(new Error('boom')) : { ok: true, result: 2 }) });
    await w.loop.start();
    expect(w.results.map((r) => [r.id, r.ok])).toEqual([['j1', false], ['j2', true]]);
  });

  it('sends a heartbeat while a job runs, and none after it', async () => {
    let during = 0;
    const w = loopWorld([job('j1')], {
      idleStopMs: 30_000,
      run: async () => {
        during = w.beats.length;
        w.beats[0]?.();
        return { ok: true, result: 1 };
      },
    });
    await w.loop.start();
    expect(during).toBe(1);
    expect(w.events).toContain('beat j1');
    expect(w.beats).toHaveLength(0);
  });

  it('stops when nothing came for a while, so the service worker can sleep until the next alarm', async () => {
    const w = loopWorld([], { idleStopMs: 4 * 60_000 });
    await w.loop.start();
    // 25 s per empty poll: ten polls make four minutes.
    expect(w.polls()).toBe(10);
    expect(w.loop.running()).toBe(false);
    // Work resets the clock: a job in the middle gives it the full time again.
    const busy = loopWorld([{ kind: 'none' }, { kind: 'none' }, job('j1')], { idleStopMs: 4 * 60_000 });
    await busy.loop.start();
    expect(busy.polls()).toBe(13);
  });

  it('never runs two loops: a second start is the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = loopWorld([job('j1')], { idleStopMs: 25_000, run: async () => (await gate, { ok: true, result: 1 }) });
    const a = w.loop.start();
    const b = w.loop.start();
    expect(b).toBe(a);
    expect(w.loop.running()).toBe(true);
    release();
    await a;
    expect(w.loop.running()).toBe(false);
    // And it can start again afterwards.
    await w.loop.start();
    expect(w.loop.running()).toBe(false);
  });

  it('ends at once and says so when the app no longer knows this browser', async () => {
    const w = loopWorld([{ kind: 'unpaired' }, job('never')]);
    await w.loop.start();
    expect(w.unpaired()).toBe(1);
    expect(w.events).toEqual(['beat']);
    const late = loopWorld([job('j1')], { result: async () => 'unpaired' });
    await late.loop.start();
    expect(late.unpaired()).toBe(1);
  });

  it('gives up after three failed calls in a row (the app is closed) and leaves the retry to the alarm', async () => {
    const w = loopWorld([{ kind: 'unreachable' }, { kind: 'unreachable' }, { kind: 'unreachable' }, job('never')]);
    await w.loop.start();
    expect(w.polls()).toBe(3);
    expect(w.events).toEqual(['beat']);
    // One failure then a job: the count starts over.
    const ok = loopWorld([{ kind: 'unreachable' }, job('j1')], { idleStopMs: 25_000 });
    await ok.loop.start();
    expect(ok.events).toEqual(['beat', 'run j1', 'result j1']);
  });

  it('Nov 23: a reload job is answered, then the extension reloads and the loop ends', async () => {
    let reloads = 0;
    const w = loopWorld([{ kind: 'job', job: { id: 'r1', kind: 'reload', input: {}, attempt: 1 } }, job('after')], {
      run: (j) => runJob(j, readers().readers),
      reload: () => {
        w.events.push('reload');
        reloads++;
      },
    });
    await w.loop.start();
    expect(w.results).toEqual([{ id: 'r1', ok: true, result: { reloading: true } }]);
    expect(w.events).toEqual(['beat', 'result r1', 'reload']);
    expect(reloads).toBe(1);
  });

  it('a result that could not be delivered is not counted as finished work', async () => {
    const w = loopWorld([job('j1')], { idleStopMs: 25_000, result: async () => 'failed' });
    await w.loop.start();
    expect(w.done).toEqual([]);
  });

  it('stop ends the poll in flight and no new one starts', async () => {
    let seen: AbortSignal | undefined;
    const w = loopWorld([], {
      next: async (_s, signal) => {
        seen = signal;
        await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
        return { kind: 'none' };
      },
    });
    const run = w.loop.start();
    w.loop.stop();
    await run;
    expect(seen?.aborted).toBe(true);
    expect(w.loop.running()).toBe(false);
  });
});

describe('the loop over the app\'s API', () => {
  function memoryKv(): KeyValue {
    const data = new Map<string, unknown>();
    return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v), remove: async (k) => void data.delete(k) };
  }

  it('reads a 200 as a job, a 204 as none, a 401 as unpaired and drops the token, an unreachable app as unreachable', async () => {
    const store = createLinkStore(memoryKv());
    await store.pair('tok', 1);
    const answers = [
      () => new Response(JSON.stringify({ job: { id: 'j9', kind: 'page', input: { itemIds: ['1'] }, attempt: 1 } }), { status: 200 }),
      () => new Response(null, { status: 204 }),
      () => { throw new TypeError('down'); },
      () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), { status: 401 }),
    ];
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => (urls.push(String(input)), answers.shift()!())) as typeof fetch;
    const deps = appJobDeps(createAgentApi({ fetchFn, store }));
    const signal = new AbortController().signal;
    expect(await deps.next(25, signal)).toEqual({ kind: 'job', job: { id: 'j9', kind: 'page', input: { itemIds: ['1'] }, attempt: 1 } });
    expect(await deps.next(25, signal)).toEqual({ kind: 'none' });
    expect(await deps.next(25, signal)).toEqual({ kind: 'unreachable' });
    expect(await deps.next(25, signal)).toEqual({ kind: 'unpaired' });
    expect(urls[0]).toBe('http://127.0.0.1:8790/api/worker/next?wait=25');
    expect(await store.getToken()).toBeNull();
  });

  it('posts a result and treats a job the app no longer holds (404) as delivered', async () => {
    const store = createLinkStore(memoryKv());
    await store.pair('tok', 1);
    const answers = [() => new Response('{"status":"done"}', { status: 200 }), () => new Response('{"error":{"code":"not_found","message":"No unfinished job with this id."}}', { status: 404 }), () => new Response('{"error":{"code":"internal","message":"x"}}', { status: 500 })];
    const bodies: unknown[] = [];
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), answers.shift()!())) as typeof fetch;
    const deps = appJobDeps(createAgentApi({ fetchFn, store }));
    expect(await deps.result({ id: 'j1', ok: true, result: [1] })).toBe('sent');
    expect(await deps.result({ id: 'j2', ok: false, error: 'x' })).toBe('sent');
    expect(await deps.result({ id: 'j3', ok: true, result: null })).toBe('failed');
    expect(bodies[0]).toEqual({ id: 'j1', ok: true, result: [1] });
  });

  it('Nov 23: every heartbeat carries this build, with the job when one runs', async () => {
    const store = createLinkStore(memoryKv());
    await store.pair('tok', 1);
    const bodies: unknown[] = [];
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => (bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body))), new Response('{"ok":true}', { status: 200 }))) as typeof fetch;
    await appJobDeps(createAgentApi({ fetchFn, store }), '0.1.0+3c92cc7').heartbeat();
    await appJobDeps(createAgentApi({ fetchFn, store }), '0.1.0+3c92cc7').heartbeat('j1');
    await appJobDeps(createAgentApi({ fetchFn, store })).heartbeat();
    expect(bodies).toEqual([{ version: '0.1.0+3c92cc7' }, { jobId: 'j1', version: '0.1.0+3c92cc7' }, {}]);
  });

  it('Nov 23: every poll carries this build as v', async () => {
    const store = createLinkStore(memoryKv());
    await store.pair('tok', 1);
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => (urls.push(String(input)), new Response(null, { status: 204 }))) as typeof fetch;
    const signal = new AbortController().signal;
    await appJobDeps(createAgentApi({ fetchFn, store }), '0.1.0+3c92cc7').next(25, signal);
    await appJobDeps(createAgentApi({ fetchFn, store })).next(25, signal);
    expect(urls).toEqual(['http://127.0.0.1:8790/api/worker/next?wait=25&v=0.1.0%2B3c92cc7', 'http://127.0.0.1:8790/api/worker/next?wait=25']);
  });
});
