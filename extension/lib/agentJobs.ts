// The paired extension as the app's worker (step 13, Decision 4): jobs that only the owner's Chrome can do, fetched from the
// app by a long poll, run one at a time through the shared doorway tab, and answered. Nothing here touches chrome.*: the
// readers and the calls to the app are injected, so the loop is tested with fakes.

import { UNKNOWN_JOB_KIND, type WorkerJobKind, type WorkerNextResponse, type WorkerResultBody } from '@core/api/contract';
import { HOME_DEPOT_ITEM_ID } from '@core/scan/kitPage';
import { isBogoListingPath } from '@core/tracking/bogoPairs';
import type { AgentApi } from './agentApi';
import type { Readers } from './doorwayLock';

export type JobOutcome = { ok: true; result: unknown } | { ok: false; error: string; outdated?: boolean };
export type Job = WorkerNextResponse['job'];

const MAX_PAGE_ITEMS = 50;
const MAX_ERROR = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): JobOutcome => ({ ok: false, error: `The job's ${what} is not one this browser can read.` });
const itemId = (v: unknown): string | null => (typeof v === 'string' && HOME_DEPOT_ITEM_ID.test(v) && v.length <= 12 ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);

/**
 * Does one job with the readers the extension's own scans use. The input comes from another program: it is checked, and an
 * item id is digits before it is put in a Home Depot address. The results are the shapes the extension already reads:
 *   page       PageOutcome[], one per item id, in order (the scan's ReadPages)
 *   kitPage    the one PageOutcome of the kit's page
 *   partPrice  a PartPriceReading (found, not_found, or not_read when Home Depot refused); `brand` is the page's own
 *   search     the research tool's HomeDepotSearch (the first page of results only: a later page is refused in words)
 *   bogoListing  one Featured BOGO listing page's products ({products}); a refusal is the result ({error}), as researchPage's
 *   promoPage  PromoPageOutcome[], one per item id, with each page's price, was-price and BOGO promotions
 * A refusal by Home Depot is a result (kind 'refused', status 'not_read'), not a failure: asking again will not change it.
 */
export async function runJob(job: { kind: WorkerJobKind; input: unknown }, readers: Readers): Promise<JobOutcome> {
  const input = job.input;
  if (!isRecord(input)) return bad('input');
  try {
    switch (job.kind) {
      case 'page': {
        const ids = Array.isArray(input.itemIds) ? input.itemIds.map(itemId) : null;
        if (ids === null || ids.length === 0 || ids.length > MAX_PAGE_ITEMS || ids.some((i) => i === null)) return bad('item ids');
        return { ok: true, result: await readers.readPages(ids as string[]) };
      }
      case 'kitPage': {
        const id = itemId(input.itemId);
        if (id === null) return bad('item id');
        const outcomes = await readers.readPages([id]);
        return { ok: true, result: outcomes.find((o) => o.itemId === id) ?? { itemId: id, kind: 'unreadable' } };
      }
      case 'partPrice': {
        const id = itemId(input.itemId);
        const model = text(input.model, 64);
        if (id === null || model === null) return bad('item id or model');
        return { ok: true, result: await readers.readItemPrice(id, model) };
      }
      case 'search': {
        const query = text(input.query, 200);
        if (query === null) return bad('query');
        if (input.page !== undefined && input.page !== 1) return { ok: false, error: 'Only the first page of a Home Depot search is read.' };
        const found = await readers.researchTools.forQuestion().searchHomeDepot({ query });
        return 'error' in found ? { ok: false, error: found.error.slice(0, MAX_ERROR) } : { ok: true, result: found };
      }
      case 'researchPage': {
        const id = itemId(input.itemId);
        if (id === null) return bad('item id');
        // WorkerJobResults.researchPage is HomeDepotPage | ToolError: a refusal is the result, as the agent reads it.
        return { ok: true, result: await readers.researchTools.forQuestion().readHomeDepotPage({ itemId: id }) };
      }
      case 'bogoListing': {
        if (!isBogoListingPath(input.path)) return bad('listing address');
        if (!readers.readBogoListing) return { ok: false, error: 'This browser does not read BOGO listings yet.' };
        return { ok: true, result: await readers.readBogoListing(input.path) };
      }
      case 'promoPage': {
        const ids = Array.isArray(input.itemIds) ? input.itemIds.map(itemId) : null;
        if (ids === null || ids.length === 0 || ids.length > MAX_PAGE_ITEMS || ids.some((i) => i === null)) return bad('item ids');
        if (!readers.readPromoPages) return { ok: false, error: 'This browser does not read BOGO pages yet.' };
        return { ok: true, result: await readers.readPromoPages(ids as string[]) };
      }
      case 'reload':
        // Nov 23: answered first; the loop reloads the extension once the answer is posted (JobLoopDeps.reload).
        return { ok: true, result: { reloading: true } };
      default:
        // An older build than the app's: said as such, so the app reads it as an outdated helper, not a Home Depot failure.
        return { ok: false, error: UNKNOWN_JOB_KIND, outdated: true };
    }
  } catch (e) {
    return { ok: false, error: (e instanceof Error && e.message !== '' ? e.message : 'The Home Depot read failed.').slice(0, MAX_ERROR) };
  }
}

// ---------------------------------------------------------------- the loop

/** What one long poll came back with. */
export type NextJob =
  | { kind: 'job'; job: Job }
  | { kind: 'none' }
  /** The app no longer knows this browser, or there is no token: the loop ends and the link says so. */
  | { kind: 'unpaired' }
  | { kind: 'unreachable' };

export interface JobLoopDeps {
  /** GET /api/worker/next?wait=<seconds>. Resolves `none` for a 204 or when `signal` fired. */
  next(waitSeconds: number, signal: AbortSignal): Promise<NextJob>;
  /** POST /api/worker/result. */
  result(body: WorkerResultBody): Promise<'sent' | 'unpaired' | 'failed'>;
  /** POST /api/worker/heartbeat: still here, though no poll is open (a long job); with no job when the loop starts. */
  heartbeat(jobId?: string): Promise<void>;
  /** Nov 23: after a `reload` job's answer is posted: chrome.runtime.reload(). Absent: the loop just goes on. */
  reload?(): void;
  run(job: Job): Promise<JobOutcome>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A job was finished and its result posted. */
  onJobDone(at: number): void | Promise<void>;
  /** The link ended (401 or no token). */
  onUnpaired(): void | Promise<void>;
  /** Calls `fn` every `ms` until the returned function is called. Injected so the tests need no timers. */
  every(ms: number, fn: () => void): () => void;
  /** Seconds one poll waits; the app's own limit is 25. */
  waitSeconds?: number;
  /** The loop ends when no job came for this long; the alarm starts it again. */
  idleStopMs?: number;
  /** The loop ends after this many failed calls in a row (the app is not running); the alarm tries again. */
  maxFailures?: number;
  heartbeatMs?: number;
}

export interface JobLoop {
  /** Starts the loop, or returns the one already running: there is never a second. */
  start(): Promise<void>;
  /** Ends the poll in flight and the loop after the job it is running, if any. */
  stop(): void;
  running(): boolean;
}

export const IDLE_STOP_MS = 4 * 60_000;
const FAILURE_BACKOFF_MS = [2000, 5000, 15_000];

export function createJobLoop(deps: JobLoopDeps): JobLoop {
  const waitSeconds = deps.waitSeconds ?? 25;
  const idleStopMs = deps.idleStopMs ?? IDLE_STOP_MS;
  const maxFailures = deps.maxFailures ?? 3;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  let current: Promise<void> | null = null;
  let abort: AbortController | null = null;

  async function loop(signal: AbortSignal): Promise<void> {
    let lastWork = deps.now();
    let failures = 0;
    // Nov 23: the app learns this helper's build at once (the heartbeat carries it), not only during a long job.
    void deps.heartbeat().catch(() => undefined);
    while (!signal.aborted) {
      const next = await deps.next(waitSeconds, signal);
      if (next.kind === 'unpaired') {
        await deps.onUnpaired();
        return;
      }
      if (next.kind === 'unreachable') {
        failures++;
        if (failures >= maxFailures) return;
        await deps.sleep(FAILURE_BACKOFF_MS[Math.min(failures - 1, FAILURE_BACKOFF_MS.length - 1)]!);
        continue;
      }
      failures = 0;
      if (next.kind === 'none') {
        if (deps.now() - lastWork >= idleStopMs) return;
        continue;
      }
      // A job: a heartbeat keeps the app seeing this browser while the read takes longer than a poll.
      const stopBeat = deps.every(heartbeatMs, () => void deps.heartbeat(next.job.id).catch(() => undefined));
      let outcome: JobOutcome;
      try {
        outcome = await deps.run(next.job);
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message.slice(0, MAX_ERROR) : 'The read failed.' };
      } finally {
        stopBeat();
      }
      const sent = await deps.result({ id: next.job.id, ...outcome });
      if (sent === 'unpaired') {
        await deps.onUnpaired();
        return;
      }
      // Not delivered: the app hands the job out again when its lease runs out. That counts as a failure, not as work.
      if (sent === 'failed') {
        failures++;
        if (failures >= maxFailures) return;
        continue;
      }
      lastWork = deps.now();
      await deps.onJobDone(lastWork);
      if (next.job.kind === 'reload' && outcome.ok && deps.reload) {
        deps.reload();
        return;
      }
    }
  }

  return {
    start() {
      if (current !== null) return current;
      const mine = new AbortController();
      abort = mine;
      const run = loop(mine.signal)
        .catch(() => undefined)
        .finally(() => {
          if (current === run) {
            current = null;
            abort = null;
          }
        });
      current = run;
      return run;
    },
    stop() {
      abort?.abort();
    },
    running: () => current !== null,
  };
}

/** The loop's calls to the app, over the API client: a 204 or an aborted poll is `none`. */
export function appJobDeps(api: AgentApi, version?: string): Pick<JobLoopDeps, 'next' | 'result' | 'heartbeat'> {
  return {
    async next(waitSeconds, signal) {
      const reply = await api.get<WorkerNextResponse | undefined>(`/api/worker/next?wait=${waitSeconds}`, { signal });
      if (signal.aborted) return { kind: 'none' };
      if (!reply.ok) return reply.kind === 'unpaired' ? { kind: 'unpaired' } : { kind: 'unreachable' };
      return reply.status === 200 && reply.data?.job ? { kind: 'job', job: reply.data.job } : { kind: 'none' };
    },
    async result(body) {
      const reply = await api.post('/api/worker/result', body);
      if (reply.ok) return 'sent';
      // 404: the job finished or was handed to another worker meanwhile; nothing more to do for it.
      if (!reply.ok && reply.kind === 'refused' && reply.status === 404) return 'sent';
      return reply.kind === 'unpaired' ? 'unpaired' : 'failed';
    },
    async heartbeat(jobId) {
      // Nov 23: the build goes with every heartbeat, so the app can tell an outdated helper.
      const body = { ...(jobId === undefined ? {} : { jobId }), ...(version ? { version } : {}) };
      await api.post('/api/worker/heartbeat', Object.keys(body).length === 0 ? undefined : body);
    },
  };
}
