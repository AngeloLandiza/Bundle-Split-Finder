import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type AskAllProgress, askAllView, type PipelineView, pipelineView, type UnitRates } from '@core/scan/pipeline';
import type { ScanJob } from '@core/scan/types';

/**
 * The row's words before step 11, worked out from the job alone: three phases, pages being fetched (paid), bundle
 * pages being read (free) and parts being looked up (paid). The row now draws pipelineView instead; these stay as
 * the one-line summary of a job's phase for callers and tests that read it.
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

// ---------------------------------------------------------------- step 11: the progress row
// docs/design.md, "Scan progress (step 11)". Every word and figure comes from pipelineView (core/src/scan/pipeline.ts);
// this file only lays them out. Collapsed (the default) is one line and a 2px bar; Details opens one line a step.

/** Where the Details choice is remembered, beside the sort choice (sort.ts). */
export const DETAILS_KEY = 'splitFinder.progressDetails';
/** The spoken status changes at most this often. */
export const LIVE_EVERY_MS = 5_000;

const NO_RATES: UnitRates = {};

function readOpen(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) === 'open';
  } catch {
    return false;
  }
}

/** Whether Details is open, remembered in localStorage. Storage can be blocked, so every access is guarded. */
function useDetailsOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(readOpen);
  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(DETAILS_KEY, next ? 'open' : 'closed');
    } catch {
      // Not remembered; the choice still holds while the panel is open.
    }
  }, [open]);
  return [open, toggle];
}

/**
 * `value`, changed at most once every `ms`: a change inside the window waits for its end, and the newest value wins.
 * No timer runs while the value holds still, so nothing here ticks.
 */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(Date.now());
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const show = () => {
      lastAt.current = Date.now();
      setShown(value);
    };
    const wait = lastAt.current + ms - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const t = setTimeout(show, wait);
    return () => clearTimeout(t);
  }, [value, shown, ms]);
  return shown;
}

/** What the row shows before the worker has sent the job: the scan has started and nothing is measured. */
const STARTING: PipelineView = {
  current: { label: 'Scanning', count: '' },
  estimateText: 'estimating',
  stepsDone: 0,
  stepsTotal: 0,
  fraction: 0,
  ariaValueText: 'Scanning, estimating time left',
  steps: [],
};

/**
 * The row under the tabs. A scan's job, or (step 12) the Ask AI about all queue: the same row, the same words, from `askAllView`.
 * With `askAll` given the row is the queue's; the worker never runs both at once.
 */
export function ProgressRow({ job, rates, askAll }: { job: ScanJob | null; rates?: UnitRates; askAll?: AskAllProgress | null }) {
  const r = rates ?? NO_RATES;
  // The view depends on the job (or the queue's counts) and the rates alone (neither view reads the clock), so it changes when a
  // step's units change and never by the second.
  const view = useMemo(() => (askAll ? askAllView(askAll, r) : job ? pipelineView(job, r, Date.now()) : STARTING), [job, r, askAll]);
  const [open, toggle] = useDetailsOpen();
  const spoken = useThrottled(view.ariaValueText, LIVE_EVERY_MS);
  const listId = useId();
  const percent = view.fraction * 100;
  const { label, count } = view.current;

  return (
    <div className="progress" data-open={open || undefined}>
      <div className="progress-line">
        {/* The label is never cut: below 424px the estimate takes its own line (sidepanel.css), not the label's room. */}
        <span className="progress-now">
          {label}
          {count ? (
            <>
              {' · '}
              <span className="figure">{count}</span>
            </>
          ) : null}
        </span>
        <span className="progress-estimate figure">{view.estimateText}</span>
        <button type="button" className="progress-toggle" aria-expanded={open} aria-controls={listId} onClick={toggle}>
          Details
        </button>
      </div>
      <div
        className="progress-bar"
        role="progressbar"
        aria-label={view.labels?.bar ?? 'Scan progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(percent)}
        aria-valuetext={view.ariaValueText}
      >
        <div className="progress-fill" style={{ width: `${percent.toFixed(1)}%` }} />
      </div>
      <ol className="progress-steps" id={listId} aria-label={view.labels?.steps ?? 'Scan steps'} hidden={!open}>
        {view.steps.map((s) => (
          <li key={s.label} className="progress-step" data-state={s.state}>
            <span className="progress-step-name">{s.label}</span>
            <span className="progress-step-state">{s.state}</span>
            {/* A skipped step's reason is words; every other figure is a figure. */}
            <span className={s.state === 'skipped' ? 'progress-step-figure' : 'progress-step-figure figure'}>{s.figure}</span>
          </li>
        ))}
      </ol>
      <p className="visually-hidden" role="status" aria-live="polite">
        {spoken}
      </p>
    </div>
  );
}
