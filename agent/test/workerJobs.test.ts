import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Store } from '../store';
import { WorkerJobs } from '../workerJobs';

let store: Store | null = null;
let jobs: WorkerJobs | null = null;
afterEach(() => {
  jobs?.stop();
  store?.close();
  store = null;
  jobs = null;
});

function setup(now = () => 0) {
  store = Store.open(mkdtempSync(join(tmpdir(), 'sf-jobs-')));
  jobs = new WorkerJobs(store, { now, leaseMs: 1000 });
  return jobs;
}

describe('worker jobs', () => {
  it('a heartbeat naming the leased job extends its lease, so a long batch is not handed out twice', async () => {
    let t = 0;
    const q = setup(() => t);
    const a = q.enqueue('researchPage', { itemId: '1' });
    await q.next(0);
    t = 800;
    expect(q.extendLease(a.id)).toBe(true);
    t = 1500; // past the first lease (1000), inside the extended one (1800)
    expect(q.sweep()).toBe(0);
    expect(q.get(a.id)?.status).toBe('leased');
    t = 1900;
    expect(q.sweep()).toBe(1);
    expect(q.extendLease(a.id)).toBe(false); // queued again: nothing to extend
    expect(q.extendLease('nope')).toBe(false);
  });

  it('leases the oldest queued job and finishes it with the result', async () => {
    const q = setup();
    const a = q.enqueue('page', { itemIds: ['1'] });
    q.enqueue('search', { query: 'dewalt kit', page: 1 });
    const leased = await q.next(0);
    expect(leased).toMatchObject({ id: a.id, status: 'leased', attempts: 1 });
    const finished = q.whenFinished(a.id);
    expect(q.complete({ id: a.id, ok: true, result: { pages: 1 } })).toBe('done');
    expect((await finished).result).toEqual({ pages: 1 });
    expect(q.complete({ id: a.id, ok: true, result: null })).toBeNull();
    expect(q.waitingCount()).toBe(1);
  });

  it('a long poll waits for the next job and gets it as soon as it is queued', async () => {
    const q = setup();
    const waiting = q.next(5_000);
    expect(q.pollers()).toBe(1);
    const job = q.enqueue('kitPage', { itemId: '9', model: 'DCK240C2' });
    expect((await waiting)?.id).toBe(job.id);
    expect(q.pollers()).toBe(0);
  });

  it('a long poll answers null after its wait, or when the worker goes away', async () => {
    const q = setup();
    expect(await q.next(10)).toBeNull();
    const ctl = new AbortController();
    const waiting = q.next(5_000, ctl.signal);
    ctl.abort();
    expect(await waiting).toBeNull();
    expect(q.pollers()).toBe(0);
  });

  it('a lease that runs out is handed out once more, then the job fails', async () => {
    let now = 0;
    const q = setup(() => now);
    const job = q.enqueue('partPrice', { itemId: '5', model: 'DCB205' });
    await q.next(0);
    now = 1001;
    expect(q.sweep()).toBe(1);
    expect(q.get(job.id)?.status).toBe('queued');
    expect((await q.next(0))?.attempts).toBe(2);
    now = 2002;
    const finished = q.whenFinished(job.id);
    q.sweep();
    expect((await finished).status).toBe('failed');
  });

  it('a failure the worker reports is retried once', async () => {
    const q = setup();
    const job = q.enqueue('page', { itemIds: ['2'] });
    await q.next(0);
    expect(q.complete({ id: job.id, ok: false, error: 'tab closed' })).toBe('queued');
    await q.next(0);
    expect(q.complete({ id: job.id, ok: false, error: 'tab closed' })).toBe('failed');
  });

  it('queued jobs wait in the store across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-jobs-'));
    const s1 = Store.open(dir);
    new WorkerJobs(s1).enqueue('page', { itemIds: ['3'] });
    s1.close();
    store = Store.open(dir);
    expect(new WorkerJobs(store).waitingCount()).toBe(1);
  });
});
