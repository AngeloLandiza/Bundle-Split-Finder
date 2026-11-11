import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewAnswer, ReviewItem } from '@core/scan/types';
import { money } from '../../lib/format';
import { reviewReason } from './reviewReason';

const NONE = 'none';
const CHANGED = 'That question changed. Choose again.';
export const SCAN_RUNNING = 'A scan is running. Answer when it has finished.';

export interface ReviewQuestionProps {
  item: ReviewItem;
  scanRunning: boolean;
  /** Move focus to the question when it appears: the one before it was just answered. */
  focusHeading?: boolean;
  /** Resolves to a sentence when the answer was refused, null when it was saved. */
  onSave: (answer: ReviewAnswer) => Promise<string | null>;
}

export function ReviewQuestion({ item, scanRunning, focusHeading = false, onSave }: ReviewQuestionProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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

  const submit = async () => {
    if (picked === null) return;
    // The signature is taken from the item as it is shown, never from a later report.
    const seen = reviewSignature(item);
    const answer: ReviewAnswer = picked === NONE ? { none: true, seen } : { choice: Number(picked), seen };
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
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className="review-question">
        <legend className="review-title" ref={legendRef} tabIndex={-1}>
          {split ? 'Which parts come in this bundle?' : `Which Amazon listing is ${subject}?`}
        </legend>
        {split && item.title ? <p className="review-bundle">{item.title}</p> : null}
        <p className="review-ident">
          <span>{item.brand}</span>
          <span className="figure fig-sm">{item.model}</span>
        </p>
        <p className="review-reason">{reviewReason(item.reason)}</p>
        <div className="review-choices">
          {split && item.choices.length === 0 ? (
            <p className="review-note">No reading could be made from the model number or the page.</p>
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
                    <span id={priceId} className="figure">
                      {c.price === null ? 'No price seen' : money(c.price)}
                    </span>
                    <a className="figure" href={`https://www.amazon.com/dp/${c.asin}`} target="_blank" rel="noreferrer">
                      {c.asin}
                    </a>
                  </p>,
                  priceId,
                );
              })}
          {row(NONE, 'None of these')}
        </div>
        <button type="submit" className="btn btn-primary review-save" disabled={picked === null || scanRunning || saving}>
          Save answer
        </button>
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
