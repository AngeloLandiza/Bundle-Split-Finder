import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewAnswer, ReviewItem } from '@core/scan/types';
import { money } from '../../lib/format';
import { OpenOnHomeDepot } from './OpenOnHomeDepot';
import { reviewReasonParts } from './reviewReason';

const NONE = 'none';
const ENTER = 'enter';
const CHANGED = 'That question changed. Choose again.';
export const SCAN_RUNNING = 'A scan is running. Answer when it has finished.';

export interface ReviewQuestionProps {
  item: ReviewItem;
  scanRunning: boolean;
  /** Move focus to the question when it appears: the one before it was just answered. */
  focusHeading?: boolean;
  /** Resolves to a sentence when the answer was refused, null when it was saved. */
  onSave: (answer: ReviewAnswer) => Promise<string | null>;
  /** Put the question off: nothing is sent or stored. */
  onNotNow?: () => void;
  /** Inside Detail: its head already shows the bundle's title, brand and model, so the question does not repeat them. */
  compact?: boolean;
  /** A split question's bundle page on Home Depot; null or absent when the report has none. */
  homeDepotLink?: string | null;
}

export function ReviewQuestion({ item, scanRunning, focusHeading = false, onSave, onNotNow, compact = false, homeDepotLink = null }: ReviewQuestionProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [typed, setTyped] = useState('');
  const legendRef = useRef<HTMLLegendElement>(null);
  const split = item.kind === 'split';
  const subject = `${item.brand} ${item.model}`;

  // Only when the question appears.
  useEffect(() => {
    if (focusHeading) legendRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A refusal belongs to the attempt that met it: a scan starting makes it stale.
  useEffect(() => {
    if (scanRunning) setError(null);
  }, [scanRunning]);

  // Split on commas, trimmed, empty ones dropped. Nothing else: the worker checks the models and refuses with a sentence.
  const typedParts = typed.split(',').map((x) => x.trim()).filter((x) => x !== '');

  const submit = async () => {
    if (picked === null || (picked === ENTER && typedParts.length === 0)) return;
    // The signature is taken from the item as it is shown, never from a later report.
    const seen = reviewSignature(item);
    const answer: ReviewAnswer =
      picked === NONE ? { none: true, seen } : picked === ENTER ? { parts: typedParts, seen } : { choice: Number(picked), seen };
    setSaving(true);
    setError(null);
    const refused = await onSave(answer);
    setSaving(false);
    if (refused !== null) {
      setError(refused);
      if (refused === CHANGED) setPicked(null);
    }
  };

  const row = (value: string, label: ReactNode, meta?: ReactNode, describedBy?: string) => (
    <div className="review-row" key={value}>
      <label className="review-choice">
        <input type="radio" name="review-choice" value={value} checked={picked === value} aria-describedby={describedBy} onChange={() => setPicked(value)} />
        <span className="review-choice-label">{label}</span>
      </label>
      {meta}
    </div>
  );

  return (
    <form
      // Enter on a radio must not save: only the Save answer button does.
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'radio') e.preventDefault();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className={compact ? 'review-question review-compact' : 'review-question'}>
        <legend className="review-title" ref={legendRef} tabIndex={-1}>
          {split ? 'Which parts come in this bundle?' : `Which Amazon listing is ${subject}?`}
          {compact && split ? <span className="review-hidden">{` ${subject}`}</span> : null}
        </legend>
        {!compact && split && item.title ? <p className="review-bundle">{item.title}</p> : null}
        {!compact ? (
          <p className="review-ident">
            <span>{item.brand}</span>
            <span className="figure fig-sm">{item.model}</span>
          </p>
        ) : null}
        {!compact && split && homeDepotLink ? <OpenOnHomeDepot href={homeDepotLink} className="review-open" /> : null}
        <p className="review-reason">
          {reviewReasonParts(item.reason).map((p, i) =>
            'model' in p ? (
              <span key={i} className="figure review-reason-model">
                {p.model}
              </span>
            ) : (
              p.text
            ),
          )}
        </p>
        <div className="review-choices">
          {split && item.choices.length === 0 ? (
            <p className="review-note">No reading could be made from the model number or the page. Enter the parts if you know them.</p>
          ) : null}
          {split
            ? item.choices.map((parts, i) => row(String(i), <span className="figure">{parts.join(' + ')}</span>))
            : item.candidates.map((c, i) => {
                const priceId = `review-price-${i}`;
                return row(
                  String(i),
                  <span className="review-cand-title" title={c.title}>
                    {c.title}
                  </span>,
                  <p className="review-cand-meta fig-sm">
                    <span id={priceId} className={c.price === null ? undefined : 'figure'}>
                      {c.price === null ? 'No price seen' : money(c.price)}
                    </span>
                    <a className="figure" href={`https://www.amazon.com/dp/${c.asin}`} target="_blank" rel="noreferrer">
                      {c.asin}
                    </a>
                  </p>,
                  priceId,
                );
              })}
          {split
            ? row(
                ENTER,
                'Enter the parts',
                picked === ENTER ? (
                  <div className="review-enter">
                    <label htmlFor="review-parts" className="review-enter-label">
                      Model numbers, separated by commas
                    </label>
                    <input
                      id="review-parts"
                      type="text"
                      className="review-enter-input"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="review-parts-help"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                    />
                    <p id="review-parts-help" className="review-enter-help">
                      List a part twice if the bundle has two.
                    </p>
                  </div>
                ) : undefined,
              )
            : null}
          {row(
            NONE,
            'None of these',
            <p id="review-none-effect" className="review-none-effect">
              {split ? 'The bundle stays in Contents not known.' : 'The part stays without a listing.'}
            </p>,
            'review-none-effect',
          )}
        </div>
        <div className="review-actions">
          <button type="submit" className="btn btn-primary" disabled={picked === null || (picked === ENTER && typedParts.length === 0) || scanRunning || saving}>
            Save answer
          </button>
          {onNotNow ? (
            <button type="button" className="btn btn-secondary" onClick={onNotNow} disabled={saving}>
              Skip for now
            </button>
          ) : null}
        </div>
        {scanRunning ? (
          <p className="review-sentence">{SCAN_RUNNING}</p>
        ) : error ? (
          <p className="review-sentence" role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
