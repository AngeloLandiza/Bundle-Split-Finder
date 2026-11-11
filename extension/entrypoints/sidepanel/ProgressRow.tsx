import type { ScanJob } from '@core/scan/types';

/** "Scanning · page 3 of 4 · 12 searches used". Pages are the listing and catalog pages: fetched so far plus those still queued. */
export function progressText(job: ScanJob | null): string {
  if (!job) return 'Scanning';
  const queued = job.queue.filter((s) => s.kind === 'listing' || s.kind === 'catalog').length;
  const fetched = job.counts.pagesFetched;
  return `Scanning · page ${fetched} of ${fetched + queued} · ${job.searchesUsed} ${job.searchesUsed === 1 ? 'search' : 'searches'} used`;
}

export function ProgressRow({ job }: { job: ScanJob | null }) {
  return (
    <div className="progress" role="status">
      {progressText(job)}
    </div>
  );
}
