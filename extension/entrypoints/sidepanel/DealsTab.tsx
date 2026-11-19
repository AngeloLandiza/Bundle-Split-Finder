import { useCallback, useState } from 'react';
import { bundlesCsv } from '@core/scan/csv';
import { DEFAULT_SCAN_SETTINGS, type BundleRow } from '@core/scan/types';
import { money, profit, roi, when } from '../../lib/format';
import type { AppState, PanelReport } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { matchState, RANGE_MEANING, roiRangeText, sections, staleDays, waitingParts } from './dealsModel';
import { LimitNotice, limitCopy, setAsideSentence } from './DealsLimitNotice';
import { LookUp } from './DealsLookUp';
import { rowLinkOrTab, usePaidFocus } from './paidFocus';
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
  { key: 'roiLowest', label: 'Lowest ROI' },
  { key: 'roiHighest', label: 'Highest ROI' },
  { key: 'discount', label: 'Discount' },
];

// The settings the owner can change hold no freshness period, so the scan's own default applies.
const FRESHNESS_MS = DEFAULT_SCAN_SETTINGS.freshnessMs;

/** The owner's local date, YYYY-MM-DD, for the file name. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The ROI at each end of the part prices, under the headline: "ROI −6% to +12%". Nothing when the ends read the same. */
function RoiRange({ row }: { row: BundleRow }) {
  const text = roiRangeText(row.estimate, row.range);
  return text ? (
    <div className="deal-roi-range" title={RANGE_MEANING}>
      {text}
    </div>
  ) : null;
}

function Figures({ row }: { row: BundleRow }) {
  // A waiting part is already said in the match state, so the slot stays empty.
  if (!row.estimate && row.parts.some((p) => p.status === 'waiting' || p.status === 'unmatched')) return null;
  if (!row.estimate) return <div className="deal-noestimate">No estimate</div>;
  return (
    <div className="deal-figures" data-loss={row.estimate.profit < 0 ? 'true' : undefined}>
      <div className="deal-profit">{profit(row.estimate.profit)}</div>
      <div className="deal-roi">ROI {roi(row.estimate.roi)}</div>
      <RoiRange row={row} />
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
  onRun: (parts: { brand: string; model: string }[], button: HTMLButtonElement | null, rowKey: string) => Promise<string | null>;
  onOpen: (key: string) => void;
}

function Row({ row, report, asked, api, scanRunning, version, busy, onRun, onOpen }: RowProps) {
  const split = row.section === 'split';
  const state = split ? (asked ? null : 'Contents not known') : matchState(row);
  const hasLookUp = waitingParts(row).length > 0;
  return (
    <li className={hasLookUp ? 'deal-row deal-row-lookup' : 'deal-row'}>
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
          <div className="deal-subs">
            <div className="deal-sub">
              <span>{row.brand}</span>
              <span className="deal-fig">{row.model}</span>
            </div>
            <div className="deal-sub">
              {row.price !== null ? <span className="deal-fig deal-price">{money(row.price)}</span> : null}
              {row.percentOff !== null ? <span>{Math.round(row.percentOff)}% off</span> : null}
              {state ? <span>{state}</span> : null}
              {row.options.length > 1 ? <span>{row.options.length} ways to sell</span> : null}
            </div>
          </div>
        </div>
        {split ? asked ? <span className="deal-tag">Needs your answer</span> : null : <Figures row={row} />}
      </a>
      {hasLookUp ? <LookUp row={row} report={report} api={api} scanRunning={scanRunning} version={version} busy={busy} onRun={(parts, button) => onRun(parts, button, row.key)} inRow /> : null}
    </li>
  );
}

export function DealsTab({ report, state, sort, onSort, onOpen, api, onPaidEnd }: DealsTabProps) {
  const now = Date.now();
  // One paid request at a time across the whole tab; `version` makes every Look up ask for its price again afterwards.
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const focus = usePaidFocus(report);
  const run = useCallback(
    async (parts: { brand: string; model: string }[], button: HTMLButtonElement | null, rowKey: string): Promise<string | null> => {
      if (busy) return null;
      // Focus on the button when it was pressed: when the Look up has ended and the button is gone, it goes to the row.
      focus.begin(button, () => rowLinkOrTab(rowKey));
      setBusy(true);
      let error: string | null = null;
      try {
        const reply = await api.send({ type: 'runPaid', action: { kind: 'lookUp', parts } });
        if (!reply.ok) error = reply.error;
      } catch {
        error = UNREACHABLE;
      }
      focus.end();
      setBusy(false);
      setVersion((v) => v + 1);
      onPaidEnd?.();
      return error;
    },
    [api, busy, onPaidEnd, focus],
  );
  if (!report) return null;
  const job = state.lastJob;
  const aside = setAsideSentence(state, report.bundles);

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
            limitCopy(state, now, report.bundles) || job.stopReason === 'error' || job.stopReason === 'rate_limited'
            ? null
            : 'The last scan did not finish. Scan now tries again.';
    return (
      <>
        <LimitNotice state={state} now={now} bundles={report.bundles} />
        {text ? <p className="deals-empty">{text}</p> : null}
        {aside && !limitCopy(state, now, report.bundles) ? <p className="deals-empty">{aside}</p> : null}
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
      <LimitNotice state={state} now={now} bundles={report.bundles} />
      <div className="deals-bar">
        <span>
          {n} {n === 1 ? 'bundle' : 'bundles'}
          {job && job.finishedAt !== null ? ` · scanned ${when(job.finishedAt, now)}` : ''}
        </span>
        <span className="deals-controls">
          <button type="button" className="deals-download" onClick={() => api.download(`split-finder-deals-${localDate(Date.now())}.csv`, bundlesCsv(groups.flatMap((g) => g.rows)), 'text/csv')}>
            Download CSV
          </button>
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
        </span>
      </div>
      {aside && !limitCopy(state, now, report.bundles) ? <p className="deals-stale">{aside}</p> : null}
      {/* Step 10: the eBay step skipped or stopped early. The scan itself is unaffected; this says why a part has no eBay line. */}
      {job?.ebayNotice ? (
        <p className="deals-stale" data-testid="ebay-notice">
          {job.ebayNotice}
        </p>
      ) : null}
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
