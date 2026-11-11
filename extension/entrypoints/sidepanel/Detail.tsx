import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { amazonNet, type FeeSettings } from '@core/money';
import { bundlesCsv } from '@core/scan/csv';
import type { BundleRow, PaidAction, PartRow } from '@core/scan/types';
import { money, profit, roi, when } from '../../lib/format';
import type { AppState, Packaging, PanelReport } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { waitingParts } from './dealsModel';
import { LookUp } from './DealsLookUp';
import { Verify } from './DetailVerify';
import './Detail.css';

export interface DetailProps {
  api: WorkerApi;
  report: PanelReport | null;
  state: AppState;
  bundleKey: string;
  onBack: () => void;
}

const LOOSE_NOTE = 'Loose parts cannot be listed as New on Amazon; this estimate assumes they can.';

const percent = (rate: number): string => `${Math.round(rate * 10000) / 100}%`;

/** "15% referral, no fulfillment fee": the fee settings the estimate came from, in words. */
export function feeText(fees: FeeSettings): string {
  const fulfillment = fees.fulfillmentFee > 0 ? `${money(fees.fulfillmentFee)} fulfillment per unit` : 'no fulfillment fee';
  return `${percent(fees.referralRate)} referral, ${fulfillment}`;
}

/** The newest time one of the parts' prices was seen; the report row keeps no time of its own for the bundle. */
function priceSeen(row: BundleRow): number | null {
  let newest: number | null = null;
  for (const p of row.parts) if (p.priceSeenAt !== null && (newest === null || p.priceSeenAt > newest)) newest = p.priceSeenAt;
  return newest;
}

function noEstimate(row: BundleRow): string {
  if (row.section === 'split' || row.status === 'needs_review') return 'No estimate: what this bundle contains is not known yet.';
  if (row.price === null) return 'No estimate: Home Depot shows no price for this bundle.';
  return 'No estimate: a part has not been looked up yet.';
}

interface Label {
  text: string;
  tone: 'plain' | 'attention' | 'verified';
}

function labelOf(p: PartRow): Label {
  if (p.status === 'waiting' || p.status === 'unmatched') return { text: 'Not looked up yet', tone: 'plain' };
  if (p.status === 'review') return { text: 'Needs your answer', tone: 'attention' };
  if (p.status === 'none' || p.asin === null) return { text: 'No listing', tone: 'plain' };
  if (p.availability === 'inactive') return { text: 'Listing inactive', tone: 'plain' };
  if (p.grade === 'exact') return { text: 'Barcode verified', tone: 'verified' };
  if (p.grade === 'strong') return { text: 'Verified', tone: 'plain' };
  if (p.grade === 'probable') return { text: 'Title match', tone: 'attention' };
  return { text: 'Chosen by you', tone: 'plain' };
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5l2.25 2.25L9.5 3.5" />
    </svg>
  );
}

interface PartProps {
  part: PartRow;
  row: BundleRow;
  fees: FeeSettings;
  api: WorkerApi;
  scanRunning: boolean;
  version: number;
  busy: boolean;
  run: (action: PaidAction) => Promise<string | null>;
}

function Part({ part, row, fees, api, scanRunning, version, busy, run }: PartProps) {
  const label = labelOf(part);
  const asin = part.asin;
  return (
    <li className="detail-part">
      <div className="detail-part-top">
        <div className="detail-part-name">
          <div className="detail-part-model">
            {part.model}
            {part.qty > 1 ? ` ×${part.qty}` : ''}
          </div>
          {part.title ? (
            <div className="detail-part-title" title={part.title}>
              {part.title}
            </div>
          ) : null}
        </div>
        {part.price !== null ? (
          <div className="detail-part-money">
            <div className="detail-part-price">{money(part.price)}</div>
            <div className="detail-part-net">nets {money(amazonNet(part.price, fees))}</div>
          </div>
        ) : null}
      </div>
      <div className="detail-part-bottom">
        <div className="detail-part-tags">
          {asin ? (
            <a className="detail-asin" href={`https://www.amazon.com/dp/${asin}`} target="_blank" rel="noopener noreferrer">
              {asin}
            </a>
          ) : null}
          <span className="detail-grade" data-tone={label.tone}>
            {label.tone === 'verified' ? <Check /> : null}
            {label.text}
          </span>
        </div>
        {label.text === 'Title match' && asin ? (
          <Verify
            brand={row.brand}
            model={part.model}
            asin={asin}
            api={api}
            scanRunning={scanRunning}
            version={version}
            busy={busy}
            onRun={() => run({ kind: 'verify', brand: row.brand, model: part.model, asin })}
          />
        ) : null}
      </div>
    </li>
  );
}

function PackagingQuestion({ row, api, report }: { row: BundleRow; api: WorkerApi; report: PanelReport }) {
  const [local, setLocal] = useState<Packaging | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const answer = local ?? report.packaging[row.model.toUpperCase()] ?? null;

  const choose = (packaging: Packaging) => {
    setProblem(null);
    api
      .send({ type: 'setPackaging', model: row.model, packaging })
      .then((reply) => {
        if (reply.ok) {
          setLocal(packaging);
          setAsking(false);
        } else setProblem(reply.error);
      })
      .catch(() => setProblem(UNREACHABLE));
  };

  if (answer !== null && !asking) {
    return (
      <div className="detail-packaging-line">
        <span>Packaging</span>
        <span className="detail-packaging-answer">{answer === 'loose' ? 'Loose' : 'Boxed'}</span>
        <button type="button" className="detail-link" onClick={() => setAsking(true)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <section className="detail-packaging" aria-labelledby="detail-packaging-q">
      <div className="detail-packaging-text">
        <div id="detail-packaging-q" className="detail-packaging-q">
          Do these arrive individually boxed?
        </div>
        <div className="detail-packaging-why">{"Amazon's New condition needs factory packaging. Your answer is saved for this bundle."}</div>
      </div>
      <div className="detail-packaging-buttons">
        <button type="button" className="detail-btn" onClick={() => choose('retail_boxed')}>
          Yes, boxed
        </button>
        <button type="button" className="detail-btn" onClick={() => choose('loose')}>
          No, loose
        </button>
      </div>
      {problem ? <p className="detail-refusal">{problem}</p> : null}
    </section>
  );
}

const fileName = (model: string): string => `split-finder-${model.replace(/[^A-Za-z0-9._-]+/g, '-')}.csv`;

export function Detail({ report, state, bundleKey, onBack, api }: DetailProps) {
  const row = report?.bundles.find((b) => b.key === bundleKey) ?? null;
  // One paid request at a time on this screen; `version` makes every quote ask again afterwards.
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = useCallback(
    async (action: PaidAction): Promise<string | null> => {
      if (busy) return null;
      setBusy(true);
      let error: string | null = null;
      try {
        const reply = await api.send({ type: 'runPaid', action });
        if (!reply.ok) error = reply.error;
      } catch {
        error = UNREACHABLE;
      }
      setBusy(false);
      setVersion((v) => v + 1);
      return error;
    },
    [api, busy],
  );

  const top = (
    <header className="detail-bar">
      <button type="button" className="detail-back" onClick={onBack}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8.5 3L4.5 7l4 4" />
        </svg>
        Deals
      </button>
      {row?.link ? (
        <a className="detail-open" href={row.link} target="_blank" rel="noopener noreferrer">
          Open on Home Depot
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4.5 2.5h5v5M9.5 2.5l-7 7" />
          </svg>
        </a>
      ) : null}
    </header>
  );

  if (!report || !row) {
    return (
      <div className="detail">
        {top}
        <main className="detail-body">{report ? <p className="detail-missing">This bundle is no longer in the report.</p> : null}</main>
      </div>
    );
  }

  const fees = state.settings.fees;
  const loose = report.packaging[row.model.toUpperCase()] === 'loose';
  const seen = priceSeen(row);
  const asins = row.parts.map((p) => p.asin).filter((a): a is string => a !== null);
  const e = row.estimate;
  const gross = row.parts.reduce((sum, p) => sum + (p.price !== null ? p.price * p.qty : 0), 0);
  const waiting = waitingParts(row).length;

  const copy = () => {
    if (asins.length === 0) return;
    setCopyFailed(false);
    navigator.clipboard
      .writeText(asins.join(' '))
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopyFailed(true));
  };

  return (
    <div className="detail">
      {top}
      <main className="detail-body">
        <section className="detail-head">
          <div className="detail-brand">{row.brand}</div>
          <h1 className="detail-title">{row.title}</h1>
          <div className="detail-meta">
            <span className="detail-model">{row.model}</span>
            <span>Home Depot{seen !== null ? ` · price seen ${when(seen, Date.now())}` : ''}</span>
            {loose ? <span className="detail-tag">Loose</span> : null}
          </div>
        </section>

        <section className="detail-headline" aria-label="Estimate">
          {e ? (
            <>
              <div className="detail-profit-line" data-loss={e.profit < 0 ? 'true' : undefined}>
                <div className="detail-profit">{profit(e.profit)}</div>
                <div className="detail-roi">ROI {roi(e.roi)}</div>
              </div>
              <dl className="detail-figures">
                <div>
                  <dt>Bundle costs</dt>
                  <dd>{money(e.cost)}</dd>
                </div>
                <div>
                  <dt>Parts sell for</dt>
                  <dd>{money(gross)}</dd>
                </div>
                <div>
                  <dt>After fees</dt>
                  <dd>{money(e.netRevenue)}</dd>
                </div>
              </dl>
              <p className="detail-estimate">
                Estimate from your fee settings ({feeText(fees)}).{loose ? ` ${LOOSE_NOTE}` : ''}{' '}
                <a className="detail-link" href={browser.runtime.getURL('/options.html')} target="_blank" rel="noopener noreferrer">
                  Change
                </a>
              </p>
            </>
          ) : waiting > 0 ? (
            <>
              <p className="detail-noestimate">
                No estimate yet: {waiting} {waiting === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup.
              </p>
              <LookUp row={row} api={api} scanRunning={state.scanRunning} version={version} busy={busy} onRun={(parts) => run({ kind: 'lookUp', parts })} />
            </>
          ) : (
            <p className="detail-noestimate">{noEstimate(row)}</p>
          )}
        </section>

        {row.parts.length > 0 ? (
          <>
            <h2 className="detail-label">PARTS · {row.parts.length}</h2>
            <ul className="detail-parts">
              {row.parts.map((p) => (
                <Part key={p.model} part={p} row={row} fees={fees} api={api} scanRunning={state.scanRunning} version={version} busy={busy} run={run} />
              ))}
            </ul>
            <PackagingQuestion key={row.key} row={row} api={api} report={report} />
          </>
        ) : null}
      </main>

      <footer className="detail-footer">
        <button type="button" className="detail-copy" disabled={asins.length === 0} onClick={copy}>
          {asins.length === 2 ? 'Copy both ASINs' : 'Copy ASINs'}
        </button>
        <button type="button" className="detail-btn detail-export" onClick={() => api.download(fileName(row.model), bundlesCsv([row]), 'text/csv')}>
          Export row
        </button>
        {copied ? (
          <span role="status" className="detail-copied">
            Copied
          </span>
        ) : null}
        {copyFailed ? (
          <span role="alert" className="detail-copied">
            Could not copy. Select the ASINs by hand.
          </span>
        ) : null}
      </footer>
    </div>
  );
}
