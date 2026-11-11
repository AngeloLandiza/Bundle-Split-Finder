import type { ScanJob } from '@core/scan/types';

/** "Scanning · page 3 of 4 · 12 searches used". Pages are the listing and catalog pages: fetched so far plus those still queued. */
function pageCounts(job: ScanJob): { current: number; total: number } {
  const queued = job.queue.filter((s) => s.kind === 'listing' || s.kind === 'catalog').length;
  const fetched = job.counts.pagesFetched;
  // The runner keeps a step at the head of the queue until it finishes, so a page being fetched is not counted yet.
  const head = job.queue[0];
  const current = head && (head.kind === 'listing' || head.kind === 'catalog') ? fetched + 1 : fetched;
  return { current, total: fetched + queued };
}

export function progressText(job: ScanJob | null): string {
  if (!job) return 'Scanning';
  const { current, total } = pageCounts(job);
  return `Scanning · page ${current} of ${total} · ${job.searchesUsed} ${job.searchesUsed === 1 ? 'search' : 'searches'} used`;
}

export function ProgressRow({ job }: { job: ScanJob | null }) {
  const n = (v: number) => <span className="figure fig-sm">{v}</span>;
  if (!job) return <div className="progress" role="status">Scanning</div>;
  const { current, total } = pageCounts(job);
  return (
    <div className="progress" role="status">
      Scanning · page {n(current)} of {n(total)} · {n(job.searchesUsed)} {job.searchesUsed === 1 ? 'search' : 'searches'} used
    </div>
  );
}
