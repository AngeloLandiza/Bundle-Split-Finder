import { useCallback, useState } from 'react';
import { DEFAULT_SCAN_SETTINGS, type BundleRow } from '@core/scan/types';
import { money, profit, roi, when } from '../../lib/format';
import type { AppState, PanelReport } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { matchState, sections, staleDays, waitingParts } from './dealsModel';
import { LimitNotice, limitCopy } from './DealsLimitNotice';
import { LookUp } from './DealsLookUp';
import { UNREACHABLE } from '../../lib/pageClient';
import type { SortKey } from './sort';
import './DealsTab.css';

export interface DealsTabProps {
  api: WorkerApi;
  report: PanelReport | null;
  state: AppState;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onOpen: (bundleKey: string) => void;
  /** Called when a Look up started here has ended, refused or not. */
  onPaidEnd?: () => void;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'profit', label: 'Profit' },
  { key: 'roi', label: 'ROI' },
  { key: 'discount', label: 'Discount' },
];

// The settings the owner can change hold no freshness period, so the scan's own default applies.
const FRESHNESS_MS = DEFAULT_SCAN_SETTINGS.freshnessMs;

function Figures({ row }: { row: BundleRow }) {
  // A waiting part is already said in the match state, so the slot stays empty.
  if (!row.estimate && row.parts.some((p) => p.status === 'waiting' || p.status === 'unmatched')) return null;
  if (!row.estimate) return <div className="deal-noestimate">No estimate</div>;
  return (
    <div className="deal-figures" data-loss={row.estimate.profit < 0 ? 'true' : undefined}>
      <div className="deal-profit">{profit(row.estimate.profit)}</div>
      <div className="deal-roi">ROI {roi(row.estimate.roi)}</div>
    </div>
  );
}

interface RowProps {
  row: BundleRow;
  report: PanelReport;
  asked: boolean;
  api: WorkerApi;
  scanRunning: boolean;
  version: number;
  busy: boolean;
  onRun: (parts: { brand: string; model: string }[]) => Promise<string | null>;
  onOpen: (key: string) => void;
}

function Row({ row, report, asked, api, scanRunning, version, busy, onRun, onOpen }: RowProps) {
  const split = row.section === 'split';
  const state = split ? (asked ? null : 'Contents not known') : matchState(row);
  return (
    <li className="deal-row">
      <a
        className="deal-link"
        data-key={row.key}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onOpen(row.key);
        }}
      >
        <div className="deal-main">
          <div className="deal-title" title={row.title}>
            {row.title}
          </div>
          <div className="deal-sub">
            <span>{row.brand}</span>
            <span className="deal-fig">{row.model}</span>
          </div>
          <div className="deal-sub">
            {row.price !== null ? <span className="deal-fig deal-price">{money(row.price)}</span> : null}
            {row.percentOff !== null ? <span>{Math.round(row.percentOff)}% off</span> : null}
            {state ? <span>{state}</span> : null}
          </div>
        </div>
        {split ? asked ? <span className="deal-tag">Needs your answer</span> : null : <Figures row={row} />}
      </a>
      {waitingParts(row).length > 0 ? <LookUp row={row} report={report} api={api} scanRunning={scanRunning} version={version} busy={busy} onRun={onRun} /> : null}
    </li>
  );
}

export function DealsTab({ report, state, sort, onSort, onOpen, api, onPaidEnd }: DealsTabProps) {
  const now = Date.now();
  // One paid request at a time across the whole tab; `version` makes every Look up ask for its price again afterwards.
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const run = useCallback(
    async (parts: { brand: string; model: string }[]): Promise<string | null> => {
      if (busy) return null;
      setBusy(true);
      let error: string | null = null;
      try {
        const reply = await api.send({ type: 'runPaid', action: { kind: 'lookUp', parts } });
        if (!reply.ok) error = reply.error;
      } catch {
        error = UNREACHABLE;
      }
      setBusy(false);
      setVersion((v) => v + 1);
      onPaidEnd?.();
      return error;
    },
    [api, busy, onPaidEnd],
  );
  if (!report) return null;
  const job = state.lastJob;

  if (report.bundles.length === 0) {
    // Say only what the scan established: it found nothing only when it finished.
    const text =
      job === null || job.status === 'running'
        ? state.scanRunning
          ? 'The first scan is running.'
          : "No scan yet. Scan now looks at Home Depot's DEWALT and RYOBI bundles."
        : job.status === 'done'
          ? 'The last scan found no bundles.'
          : // A limit has its own notice, and an error its sentence in the Notice above the tabs.
            limitCopy(state, now) || job.stopReason === 'error' || job.stopReason === 'rate_limited'
            ? null
            : 'The last scan did not finish. Scan now tries again.';
    return (
      <>
        <LimitNotice state={state} now={now} />
        {text ? <p className="deals-empty">{text}</p> : null}
      </>
    );
  }

  const asking = new Set(report.review.filter((r) => r.kind === 'split').map((r) => r.subject));
  const days = staleDays(report.bundles, now, FRESHNESS_MS);
  const groups = sections(report.bundles, sort);
  const n = report.bundles.length;
  // The label sits once, over the first section that shows an estimate, so every figure under it reads as one.
  const labelled = groups.find((g) => g.rows.some((r) => r.estimate))?.id;

  return (
    <>
      <LimitNotice state={state} now={now} />
      <div className="deals-bar">
        <span>
          {n} {n === 1 ? 'bundle' : 'bundles'}
          {job && job.finishedAt !== null ? ` · scanned ${when(job.finishedAt, now)}` : ''}
        </span>
        <span className="deals-sort">
          <label className="deals-hidden" htmlFor="deals-sort">
            Sort by
          </label>
          <select id="deals-sort" value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" />
          </svg>
        </span>
      </div>
      {days !== null ? <p className="deals-stale">Prices seen {days === 1 ? '1 day' : `${days} days`} ago. The next scan refreshes them.</p> : null}
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          {g.id === labelled ? <p className="deals-caption">Estimated profit · ROI</p> : null}
          <h2 className="deals-label">
            {g.label} · {g.rows.length}
          </h2>
          <ul className="deals-list">
            {g.rows.map((row) => (
              <Row key={row.key} row={row} report={report} asked={asking.has(row.key)} api={api} scanRunning={state.scanRunning} version={version} busy={busy} onRun={run} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
