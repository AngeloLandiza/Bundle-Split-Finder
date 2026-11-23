// Home Depot read jobs for the paired extension (step 13, Decision 4). The agent queues a job; the
// extension long-polls GET /api/worker/next, which leases one job to it, and posts the result. A
// lease that runs out, or a job the worker reports failed, is handed out once more; after that the
// job fails. Jobs are kept in the store, so they wait while Chrome is closed.

import { randomBytes } from 'node:crypto';

import type { WorkerJob, WorkerJobInputs, WorkerJobKind, WorkerJobStatus, WorkerResultBody } from '../core/src/api/contract';
import type { Store } from './store';

/** How long a worker has to answer a job before it is handed out again. */
export const LEASE_MS = 2 * 60_000;
/** A job is handed to a worker at most this many times. */
export const MAX_ATTEMPTS = 2;
/** Finished jobs kept for the record, newest last. */
const KEEP_FINISHED = 200;

type Waiter = { resolve: (job: WorkerJob | null) => void; timer: ReturnType<typeof setTimeout> };

export class WorkerJobs {
  private readonly waiters: Waiter[] = [];
  private readonly finishWatchers = new Map<string, ((job: WorkerJob) => void)[]>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: Store,
    opts: { now?: () => number; leaseMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.leaseMs = opts.leaseMs ?? LEASE_MS;
  }

  enqueue<K extends WorkerJobKind>(kind: K, input: WorkerJobInputs[K]): WorkerJob<K> {
    const job: WorkerJob<K> = {
      id: `job-${randomBytes(8).toString('hex')}`,
      kind,
      input,
      status: 'queued',
      attempts: 0,
      createdAt: new Date(this.now()).toISOString(),
      leasedAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
      result: null,
      error: null,
    };
    this.store.update('jobs', (jobs) => [...jobs, job as WorkerJob]);
    this.feedWaiters();
    return job;
  }

  get(id: string): WorkerJob | null {
    return this.store.get('jobs').find((j) => j.id === id) ?? null;
  }

  /** Jobs not finished yet. */
  waitingCount(): number {
    return this.store.get('jobs').filter((j) => j.status === 'queued' || j.status === 'leased').length;
  }

  /** Workers holding a long poll open right now. */
  pollers(): number {
    return this.waiters.length;
  }

  /** Leases the oldest queued job, or waits up to `waitMs` for one. Null when none came. */
  next(waitMs: number, signal?: AbortSignal): Promise<WorkerJob | null> {
    const job = this.lease();
    if (job || waitMs <= 0) return Promise.resolve(job);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (j) => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(j);
        },
        timer: setTimeout(() => {
          this.dropWaiter(waiter);
          waiter.resolve(null);
        }, waitMs),
      };
      const onAbort = () => {
        this.dropWaiter(waiter);
        waiter.resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /**
   * A worker's answer. A late answer to a job handed out again still counts. Null when the job is
   * unknown or already finished.
   */
  complete(body: WorkerResultBody): WorkerJobStatus | null {
    const job = this.get(body.id);
    if (!job || job.status === 'done' || job.status === 'failed') return null;
    const at = new Date(this.now()).toISOString();
    let next: WorkerJob;
    if (body.ok) next = { ...job, status: 'done', finishedAt: at, result: body.result, error: null, leaseExpiresAt: null };
    else if (job.attempts < MAX_ATTEMPTS) next = { ...job, status: 'queued', error: body.error, leasedAt: null, leaseExpiresAt: null };
    else next = { ...job, status: 'failed', finishedAt: at, error: body.error, leaseExpiresAt: null };
    this.save(next);
    if (next.status === 'queued') this.feedWaiters();
    else this.finished(next);
    return next.status;
  }

  /** Resolves when the job is done or failed. */
  whenFinished(id: string): Promise<WorkerJob> {
    const job = this.get(id);
    if (job && (job.status === 'done' || job.status === 'failed')) return Promise.resolve(job);
    return new Promise((resolve) => {
      this.finishWatchers.set(id, [...(this.finishWatchers.get(id) ?? []), resolve]);
    });
  }

  /** Hands out again, or fails, every job whose lease has run out. Returns how many changed. */
  sweep(): number {
    const now = this.now();
    const expired = this.store
      .get('jobs')
      .filter((j) => j.status === 'leased' && j.leaseExpiresAt !== null && Date.parse(j.leaseExpiresAt) <= now);
    for (const job of expired) {
      if (job.attempts < MAX_ATTEMPTS) {
        this.save({ ...job, status: 'queued', leasedAt: null, leaseExpiresAt: null, error: 'The worker did not answer in time.' });
      } else {
        const failed: WorkerJob = {
          ...job,
          status: 'failed',
          finishedAt: new Date(now).toISOString(),
          leaseExpiresAt: null,
          error: 'The worker did not answer in time, twice.',
        };
        this.save(failed);
        this.finished(failed);
      }
    }
    if (expired.length) this.feedWaiters();
    return expired.length;
  }

  start(everyMs = 5_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), everyMs);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const w of this.waiters.splice(0)) w.resolve(null);
  }

  /** Leases the oldest queued job of these kinds now, without waiting (the pre-step-13 extension reads pages only). */
  take(kinds: readonly WorkerJobKind[]): WorkerJob | null {
    return this.lease(kinds);
  }

  private lease(kinds?: readonly WorkerJobKind[]): WorkerJob | null {
    const job = this.store.get('jobs').find((j) => j.status === 'queued' && (!kinds || kinds.includes(j.kind)));
    if (!job) return null;
    const now = this.now();
    const leased: WorkerJob = {
      ...job,
      status: 'leased',
      attempts: job.attempts + 1,
      leasedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + this.leaseMs).toISOString(),
    };
    this.save(leased);
    return leased;
  }

  private feedWaiters(): void {
    while (this.waiters.length) {
      const job = this.lease();
      if (!job) return;
      this.waiters.shift()!.resolve(job);
    }
  }

  private dropWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  private save(job: WorkerJob): void {
    this.store.update('jobs', (jobs) => {
      const next = jobs.map((j) => (j.id === job.id ? job : j));
      const finished = next.filter((j) => j.status === 'done' || j.status === 'failed');
      if (finished.length <= KEEP_FINISHED) return next;
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((j) => j.id));
      return next.filter((j) => !drop.has(j.id));
    });
  }

  private finished(job: WorkerJob): void {
    const watchers = this.finishWatchers.get(job.id) ?? [];
    this.finishWatchers.delete(job.id);
    for (const w of watchers) w(job);
  }
}
