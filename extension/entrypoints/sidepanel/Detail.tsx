import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { amazonNet, type FeeSettings } from '@core/money';
import { bundlesCsv } from '@core/scan/csv';
import { reviewSignature } from '@core/scan/answers';
import type { BundleRow, PaidAction, PartRow, PriceOption, ReviewAnswer } from '@core/scan/types';
import { money, profit, roi, roiSigned, when } from '../../lib/format';
import type { AppState, Packaging, PanelReport } from '../../lib/messages';
import { amazonListingUrl, amazonSearchUrl } from '../../lib/links';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { priceLabel, spread, waitingParts } from './dealsModel';
import { LookUp } from './DealsLookUp';
import { OpenOnHomeDepot } from './OpenOnHomeDepot';
import { ProgressRow } from './ProgressRow';
import { ReviewQuestion } from './ReviewQuestion';
import { Verify } from './DetailVerify';
import { KitNotRead, WaysToSell } from './WaysToSell';
import { usePaidFocus } from './paidFocus';
import { useCopyAsins } from './useCopyAsins';
import './Detail.css';

export interface DetailProps {
  api: WorkerApi;
  report: PanelReport | null;
  state: AppState;
  bundleKey: string;
  onBack: () => void;
  /** What the back button says: the tab Detail was opened from. */
  backLabel?: string;
  /** Called when a Verify or Look up started here has ended, refused or not. */
  onPaidEnd?: () => void;
}

const percent = (rate: number): string => `${Math.round(rate * 10000) / 100}%`;

/** "15% referral, no fulfillment fee": the fee settings the estimate came from, in words. */
export function feeText(fees: FeeSettings): string {
  const fulfillment = fees.fulfillmentFee > 0 ? `${money(fees.fulfillmentFee)} fulfillment per unit` : 'no fulfillment fee';
  const parts = [`${percent(fees.referralRate)} referral`, fulfillment];
  if (fees.salesTaxRate > 0) parts.push(`${percent(fees.salesTaxRate)} sales tax`);
  if (fees.inboundCost > 0) parts.push(`${money(fees.inboundCost)} inbound per bundle`);
  return parts.join(', ');
}

/** A part that was looked up and has no listing; one still in review is a question, not a lookup result. */
function hasNoListing(p: PartRow): boolean {
  return p.availability === 'missing' && p.status !== 'waiting' && p.status !== 'unmatched' && p.status !== 'review';
}

const ANSWER_LINE = {
  chosen: 'You chose these parts.',
  entered: 'You entered these parts.',
} as const;

const SETTLED = "The model number and page now settle this bundle's parts, so there is no question to answer.";

/** Whose answer the split is, with the way to take it back. */
const CHANGE_BLOCKED = 'A scan is running. Change this when it has finished.';

function AnswerLine({ text, className = 'detail-answer', disabled, scanRunning, error, onChange }: { text: string; className?: string; disabled: boolean; scanRunning: boolean; error: string | null; onChange: () => void }) {
  const noteId = useId();
  return (
    <div className={className}>
      <span>{text}</span>{' '}
      <button type="button" className="detail-text-btn" disabled={disabled || scanRunning} title={scanRunning ? CHANGE_BLOCKED : undefined} aria-describedby={scanRunning ? noteId : undefined} onClick={onChange}>
        Change
      </button>
      {scanRunning ? (
        <p className="detail-refusal" id={noteId}>
          {CHANGE_BLOCKED}
        </p>
      ) : null}
      {error ? (
        <p className="detail-refusal" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "Estimated range: ROI −7% to +60%, profit −$14.00 to +$112.50, from ..." under a headline; nothing when the ends read the same. */
export function RangeLine({ row }: { row: BundleRow }) {
  const ends = spread(row.estimate, row.range);
  if (!ends) return null;
  return (
    <p className="detail-estimate detail-range">
      {`Estimated range: lowest to highest counted price — ROI ${roiSigned(ends.lowest.roi)} to ${roiSigned(ends.highest.roi)}, profit ${profit(ends.lowest.profit)} to ${profit(ends.highest.profit)}`}
    </p>
  );
}

/** Why a row has no estimate, in a sentence. Detail and the This page tab say it alike. */
export function noEstimate(row: BundleRow): string {
  if (row.answer?.kind === 'none') return "No estimate: you marked this bundle's parts as not known.";
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
  if (p.status === 'review') return { text: 'Needs your answer in Review', tone: 'attention' };
  if (p.status === 'none' || p.asin === null) return { text: hasNoListing(p) ? 'No Amazon listing found' : 'No listing', tone: 'plain' };
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

const isWebLink = (link: string | null): link is string => link !== null && /^https?:\/\//i.test(link);

/**
 * One part's prices in two groups, each highest first: the counted prices (Amazon New and the Buy Box, the figures
 * the estimate uses), then a group headed "Reference · not counted" (Amazon's list price, Home Depot's, an older
 * Buy Box). The Amazon New price is the featured one. A price with a link opens its page in a new tab; a reference
 * label shows it only on hover and focus.
 */
function Prices({ model, prices, bulk }: { model: string; prices: PriceOption[]; bulk: boolean }) {
  if (prices.length === 0) return null;
  const high = (a: PriceOption, b: PriceOption) => b.price - a.price;
  const counted = prices.filter((o) => !o.reference).sort(high);
  const reference = prices.filter((o) => o.reference).sort(high);
  const rows = (list: PriceOption[]) => (
    <dl>
      {list.map((o, i) => {
        const label = priceLabel(o, bulk);
        return (
          <div key={`${o.kind}:${i}`} className="detail-price" data-kind={o.kind} data-featured={o.kind === 'amazon_new' ? 'true' : undefined} data-reference={o.reference ? 'true' : undefined}>
            <dt>
              {isWebLink(o.link) ? (
                <a className="detail-price-label" href={o.link} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              ) : (
                <span className="detail-price-label">{label}</span>
              )}
            </dt>
            <dd className="figure">{money(o.price)}</dd>
          </div>
        );
      })}
    </dl>
  );
  return (
    <div className="detail-prices" role="group" aria-label={`Prices for ${model}`}>
      {counted.length > 0 ? <div className="detail-prices-counted">{rows(counted)}</div> : null}
      {reference.length > 0 ? (
        <div className="detail-prices-reference" role="group" aria-labelledby={`detail-ref-${model}`}>
          <div id={`detail-ref-${model}`} className="detail-prices-heading">
            Reference · not counted
          </div>
          {rows(reference)}
        </div>
      ) : null}
    </div>
  );
}

/** What Verify needs; a Part given none offers no Verify (the This page tab spends no search). */
export interface VerifyProps {
  report: PanelReport;
  api: WorkerApi;
  scanRunning: boolean;
  version: number;
  busy: boolean;
  run: (action: PaidAction, button: HTMLButtonElement | null) => Promise<string | null>;
}

export interface PartProps {
  now: number;
  part: PartRow;
  row: BundleRow;
  fees: FeeSettings;
  verify?: VerifyProps;
}

/** One part's block: model, name, price, net, ASIN link and grade. Detail's and This page's. */
export function Part({ part, row, fees, verify, now }: PartProps) {
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
            {part.priceSeenAt !== null ? (
              <div className="detail-part-seen">
                seen {when(part.priceSeenAt, now)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="detail-part-bottom">
        <div className="detail-part-tags">
          {asin ? (
            <a className="detail-asin" href={amazonListingUrl(asin)} target="_blank" rel="noopener noreferrer">
              <span className="figure">{asin}</span> on Amazon
            </a>
          ) : (
            <a className="detail-asin" href={amazonSearchUrl(row.brand, part.model)} target="_blank" rel="noopener noreferrer">
              Search Amazon for <span className="figure">{part.model}</span>
            </a>
          )}
          <span className="detail-grade" data-tone={label.tone}>
            {label.tone === 'verified' ? <Check /> : null}
            {label.text}
          </span>
        </div>
        {label.text === 'Title match' && asin && verify ? (
          <Verify
            brand={row.brand}
            model={part.model}
            asin={asin}
            report={verify.report}
            api={verify.api}
            scanRunning={verify.scanRunning}
            version={verify.version}
            busy={verify.busy}
            onRun={(button) => verify.run({ kind: 'verify', brand: row.brand, model: part.model, asin }, button)}
          />
        ) : null}
      </div>
      <Prices model={part.model} prices={part.prices} bulk={part.packaging === 'bulk'} />
    </li>
  );
}

interface PackagingProps {
  row: BundleRow;
  api: WorkerApi;
  /** The answer in force: this screen's own save first, then the report's. */
  answer: Packaging | null;
  onAnswered: (p: Packaging) => void;
}

function PackagingQuestion({ row, api, answer, onAnswered }: PackagingProps) {
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const choose = (packaging: Packaging) => {
    setProblem(null);
    api
      .send({ type: 'setPackaging', model: row.model, packaging })
      .then((reply) => {
        if (reply.ok) {
          onAnswered(packaging);
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
        <button type="button" className="detail-text-btn" onClick={() => setAsking(true)}>
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
        {answer !== null ? (
          <button type="button" className="detail-text-btn" onClick={() => setAsking(false)}>
            Cancel
          </button>
        ) : null}
      </div>
      {problem ? <p className="detail-refusal">{problem}</p> : null}
    </section>
  );
}

/** What a paid action returns when another one is still running: a sentence, never read as success. */
export const BUSY = 'Another search is still running.';

const fileName = (model: string): string => `split-finder-${model.replace(/[^A-Za-z0-9._-]+/g, '-')}.csv`;

export function Detail({ report, state, bundleKey, onBack, backLabel = 'Deals', api, onPaidEnd }: DetailProps) {
  const row = report?.bundles.find((b) => b.key === bundleKey) ?? null;
  // One paid request at a time on this screen; `version` makes every quote ask again afterwards.
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState<{ model: string; value: Packaging } | null>(null);
  // Change: one request at a time; `reopened` is true once one succeeded on this Detail.
  const [reopening, setReopening] = useState(false);
  const reopenLock = useRef(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopened, setReopened] = useState(false);
  const { asins, copy, copied, copyFailed } = useCopyAsins(row);
  // The title takes focus when Detail opens: the row that opened it is gone from view.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const present = report !== null && row !== null;
  // Another bundle starts clean.
  useEffect(() => {
    setReopened(false);
    setReopenError(null);
  }, [bundleKey]);
  useEffect(() => {
    if (present) titleRef.current?.focus();
  }, [present]);

  const focus = usePaidFocus(report);
  // A Change that ends in the settled sentence: the Change button is gone, so focus goes to the title (Ruling 45).
  const settledNow = reopened && row !== null && !row.answer && !(report?.review.some((r) => r.kind === 'split' && r.subject === row.key) ?? false);
  useEffect(() => {
    if (settledNow && (document.activeElement === null || document.activeElement === document.body)) titleRef.current?.focus();
  }, [settledNow]);

  const run = useCallback(
    async (action: PaidAction, button: HTMLButtonElement | null): Promise<string | null> => {
      // The lock is a ref, so two clicks in one tick cannot both pass.
      if (locked.current) return BUSY;
      locked.current = true;
      // Focus on the button when it was pressed: when the action has ended and the button is gone, it goes to the title.
      focus.begin(button, () => titleRef.current);
      setBusy(true);
      let error: string | null = null;
      try {
        const reply = await api.send({ type: 'runPaid', action });
        if (!reply.ok) error = reply.error;
      } catch {
        error = UNREACHABLE;
      }
      locked.current = false;
      focus.end();
      setBusy(false);
      setVersion((v) => v + 1);
      onPaidEnd?.();
      return error;
    },
    [api, onPaidEnd, focus],
  );

  const top = (
    <header className="detail-bar">
      <button type="button" className="detail-back" onClick={onBack}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8.5 3L4.5 7l4 4" />
        </svg>
        {backLabel}
      </button>
      {row?.link ? <OpenOnHomeDepot href={row.link} /> : null}
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
  const answer = (saved?.model === row.model ? saved.value : null) ?? report.packaging[row.model.toUpperCase()] ?? null;
  const loose = answer === 'loose';
  const e = row.estimate;
  // Core counts every uncovered part at $0 (inactive, in review, with no listing), so its price is not in the figure.
  const counted = new Set(row.uncovered);
  const gross = row.parts.reduce((sum, p) => sum + (p.price !== null && !counted.has(p.model) ? p.price * p.qty : 0), 0);
  const waiting = waitingParts(row).length;
  const partModels = new Set([...row.parts, ...row.options.flatMap((o) => o.parts)].map((p) => p.model));
  const question = report.review.find((r) => r.kind === 'split' && r.subject === row.key) ?? null;

  const answerQuestion = async (a: ReviewAnswer): Promise<string | null> => {
    if (!question) return null;
    try {
      const reply = await api.send({ type: 'answerReview', id: question.id, answer: a });
      if (!reply.ok) return reply.error;
    } catch {
      return UNREACHABLE;
    }
    // The reopened question is answered: nothing is pending any more.
    setReopened(false);
    // The Save button is gone now: focus goes to the title.
    titleRef.current?.focus();
    return null;
  };

  const reopen = async () => {
    if (reopenLock.current || !row?.answer) return;
    reopenLock.current = true;
    setReopening(true);
    setReopenError(null);
    // Set before the request: the worker's state change can reload the report before the reply comes, and the
    // question that mounts then must already know to take focus.
    setReopened(true);
    try {
      const reply = await api.send({ type: 'reopenReview', id: row.answer.reviewId });
      if (!reply.ok) {
        setReopenError(reply.error);
        setReopened(false);
      }
    } catch {
      setReopenError(UNREACHABLE);
      setReopened(false);
    }
    reopenLock.current = false;
    setReopening(false);
  };
  const answerLine = row.answer ? (
    <AnswerLine text={row.answer.kind === 'none' ? noEstimate(row) : ANSWER_LINE[row.answer.kind]} className={row.answer.kind === 'none' ? 'detail-noestimate' : undefined} disabled={reopening} scanRunning={state.scanRunning} error={reopenError} onChange={() => void reopen()} />
  ) : null;

  const now = Date.now();
  return (
    <div className="detail">
      {top}
      {state.scanRunning ? <ProgressRow job={state.lastJob} /> : null}
      <main className="detail-body">
        <section className="detail-head">
          <div className="detail-brand">{row.brand}</div>
          <h1 className="detail-title" ref={titleRef} tabIndex={-1}>{row.title}</h1>
          <div className="detail-meta">
            <span className="detail-model">{row.model}</span>
            <span>Home Depot{row.seenAt !== null ? ` · price seen ${when(row.seenAt, now)}` : ''}</span>
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
                Estimate from your fee settings ({feeText(fees)}).{' '}
                <a className="detail-link" href={browser.runtime.getURL('/options.html')} target="_blank" rel="noopener noreferrer">
                  Change
                </a>
              </p>
              <RangeLine row={row} />
              {row.uncovered.length > 0 ? (
                <p className="detail-estimate">
                  {/* Only a model number is set in the figure face; an unnamed part such as "Hex Wrench" is words. */}
                  Counts{' '}
                  {row.uncovered.map((m, i) => (
                    <Fragment key={m}>
                      {i === 0 ? '' : i === row.uncovered.length - 1 ? ' and ' : ', '}
                      {partModels.has(m) ? <span className="figure fig-sm">{m}</span> : m}
                    </Fragment>
                  ))}{' '}
                  at $0: no priced Amazon listing is chosen.
                </p>
              ) : null}
            </>
          ) : waiting > 0 ? (
            <>
              <p className="detail-noestimate">
                No estimate yet: {waiting} {waiting === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup.
              </p>
              {/* With more than one way to sell, each holds its own Look up. */}
              {row.options.length > 1 ? null : (
                <LookUp row={row} report={report} api={api} scanRunning={state.scanRunning} version={version} busy={busy} stacked onRun={(parts, button) => run({ kind: 'lookUp', parts }, button)} />
              )}
            </>
          ) : (
            <>
              {/* After None the band says it once, with Change right after it. */}
              {row.answer?.kind === 'none' ? answerLine : <p className="detail-noestimate">{noEstimate(row)}</p>}
            </>
          )}
          {reopened && !row.answer && !question ? <p className="detail-noestimate">{SETTLED}</p> : null}
          {row.kitsNotRead.map((m) => (
            <p className="detail-estimate" key={m}>
              <KitNotRead model={m} />
            </p>
          ))}
        </section>

        {row.options.length > 1 ? <WaysToSell row={row} report={report} api={api} scanRunning={state.scanRunning} version={version} busy={busy} run={run} /> : null}

        {!e && waiting === 0 && question ? (
          <ReviewQuestion key={`${question.id}|${reviewSignature(question)}`} item={question} scanRunning={state.scanRunning} focusHeading={reopened} onSave={answerQuestion} compact />
        ) : null}

        {row.parts.length > 0 ? (
          <>
            <h2 className="detail-label">PARTS · {row.parts.length}</h2>
            {row.answer && row.answer.kind !== 'none' ? answerLine : null}
            <ul className="detail-parts">
              {row.parts.map((p) => (
                <Part key={p.model} part={p} row={row} fees={fees} now={now} verify={{ report, api, scanRunning: state.scanRunning, version, busy, run }} />
              ))}
            </ul>
            <PackagingQuestion key={row.key} row={row} api={api} answer={answer} onAnswered={(value) => setSaved({ model: row.model, value })} />
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
        <span role="status" className="detail-copied">
          {copied ?? ''}
        </span>
        {copyFailed ? (
          <span role="alert" className="detail-copied">
            Could not copy. Select the ASINs by hand.
          </span>
        ) : null}
      </footer>
    </div>
  );
}
