import type { ScanJob } from '@core/scan/types';

/**
 * What the progress row says, worked out from the job alone. A scan has three phases the owner can tell apart:
 * Home Depot and Amazon pages being fetched (paid), bundle pages being read (free), and parts being looked up (paid).
 */
export type Progress =
  | { phase: 'pages'; current: number; total: number; searches: number }
  | { phase: 'reading'; read: number; searches: number }
  | { phase: 'parts'; done: number; total: number; searches: number };

const isPage = (kind: string): boolean => kind === 'listing' || kind === 'catalog';

export function progressOf(job: ScanJob): Progress {
  const searches = job.searchesUsed;
  const pagesQueued = job.queue.filter((s) => isPage(s.kind)).length;
  if (job.phase === 'listing' && pagesQueued > 0) {
    // A brand's Amazon page is counted in catalogPages and a Home Depot page in pagesFetched: both are pages fetched.
    const fetched = (job.counts.pagesFetched ?? 0) + (job.counts.catalogPages ?? 0);
    // The runner keeps a step at the head of the queue until it finishes, so a page being fetched is not counted yet.
    const head = job.queue[0];
    const current = head && isPage(head.kind) ? fetched + 1 : fetched;
    return { phase: 'pages', current, total: fetched + pagesQueued, searches };
  }
  if (job.phase === 'listing') return { phase: 'reading', read: job.counts.pagesRead ?? 0, searches };
  const done = (job.counts.lookupsDone ?? 0) + (job.counts.refreshesDone ?? 0);
  const queued = job.queue.filter((s) => s.kind === 'lookup' || s.kind === 'refresh').length;
  return { phase: 'parts', done, total: done + queued, searches };
}

const searchesUsed = (n: number): string => `${n} ${n === 1 ? 'search' : 'searches'} used`;

/** "Scanning · page 3 of 4 · 12 searches used". */
export function progressText(job: ScanJob | null): string {
  if (!job) return 'Scanning';
  const p = progressOf(job);
  switch (p.phase) {
    case 'pages':
      return `Scanning · page ${p.current} of ${p.total} · ${searchesUsed(p.searches)}`;
    case 'reading':
      return `Reading bundle pages · ${p.read} read · ${searchesUsed(p.searches)}`;
    case 'parts':
      return `Looking up parts · ${p.done} of ${p.total} · ${searchesUsed(p.searches)}`;
  }
}

export function ProgressRow({ job }: { job: ScanJob | null }) {
  const n = (v: number) => <span className="figure fig-sm">{v}</span>;
  if (!job) return <div className="progress" role="status">Scanning</div>;
  const p = progressOf(job);
  const used = (
    <>
      {n(p.searches)} {p.searches === 1 ? 'search' : 'searches'} used
    </>
  );
  if (p.phase === 'reading') {
    return (
      <div className="progress" role="status">
        Reading bundle pages · {n(p.read)} read · {used}
      </div>
    );
  }
  // The total is the job's live plan: done plus queued. It falls by one when a brand has no further page or a failed
  // lookup is set aside, and that is a true change in the plan.
  const total = p.total;
  return (
    <div className="progress" role="status">
      {p.phase === 'pages' ? (
        <>
          Scanning · page {n(p.current)} of {n(total)} · {used}
        </>
      ) : (
        <>
          Looking up parts · {n(p.done)} of {n(total)} · {used}
        </>
      )}
    </div>
  );
}
