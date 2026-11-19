import { useEffect, useRef, useState } from 'react';
import type { EbayQuestion as Question } from '@core/scan/types';
import { money } from '../../lib/format';
import { CHANGED, SCAN_RUNNING } from './ReviewQuestion';

export type EbayChoice = 'yes' | 'no';

export interface EbayQuestionProps {
  question: Question;
  scanRunning: boolean;
  /** Move focus to the question when it appears: the one before it was just answered. */
  focusHeading?: boolean;
  /** Resolves to a sentence when the answer was refused, null when it was saved. */
  onSave: (answer: EbayChoice) => Promise<string | null>;
  /** Put the question off: nothing is sent or stored. */
  onNotNow?: () => void;
}

const isWebLink = (link: string): boolean => /^https?:\/\//i.test(link);

/**
 * Step 10: "Is this eBay listing exactly <MODEL>, New, with the same contents?" for a listing the judge left unsure and that
 * could count. It shows the listing's title, why the judge was not certain, and the listing itself to open (new tab,
 * http or https only), then Yes or No. The answer is the listing's verdict from then on. The same fieldset and rows as the
 * other Review questions.
 */
export function EbayQuestion({ question: q, scanRunning, focusHeading = false, onSave, onNotNow }: EbayQuestionProps) {
  const [picked, setPicked] = useState<EbayChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const legendRef = useRef<HTMLLegendElement>(null);

  useEffect(() => {
    if (focusHeading) legendRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scanRunning) setError(null);
  }, [scanRunning]);

  const submit = async () => {
    if (picked === null) return;
    setSaving(true);
    setError(null);
    const refused = await onSave(picked);
    setSaving(false);
    if (refused !== null) {
      setError(refused);
      if (refused === CHANGED) setPicked(null);
    }
  };

  const row = (value: EbayChoice, label: string, effect: string) => (
    <div className="review-row" key={value}>
      <label className="review-choice">
        <input type="radio" name="ebay-choice" value={value} checked={picked === value} aria-describedby={`ebay-${value}-effect`} onChange={() => setPicked(value)} />
        <span className="review-choice-label">{label}</span>
      </label>
      <p id={`ebay-${value}-effect`} className="review-none-effect">
        {effect}
      </p>
    </div>
  );

  return (
    <form
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'radio') e.preventDefault();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className="review-question" data-kind="ebay">
        <legend className="review-title" ref={legendRef} tabIndex={-1}>
          Is this eBay listing exactly <span className="figure">{q.model}</span>, New, with the same contents?
        </legend>
        <p className="review-ident">
          <span>{q.brand}</span>
          <span className="figure fig-sm">{q.model}</span>
        </p>
        <p className="review-bundle">{q.title}</p>
        <p className="review-cand-meta-line fig-sm">
          {q.price !== null ? <span className="figure">{money(q.price)}</span> : null}
          {q.soldQuantity !== null ? <span className="figure">{q.soldQuantity} sold</span> : null}
          {isWebLink(q.url) ? (
            <a className="review-ebay-link" href={q.url} target="_blank" rel="noopener noreferrer">
              Open this listing on eBay
            </a>
          ) : null}
        </p>
        {q.reasons.length > 0 ? (
          <div className="review-reasons">
            <p className="review-reason">Why the check was not certain</p>
            <ul>
              {q.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="review-note">eBay shows how many units this listing has sold, not what they sold for. The eBay figure is a reference and is never counted in an estimate.</p>
        <div className="review-choices">
          {row('yes', 'Yes, it is exactly this part', "The listing counts in this part's eBay reference.")}
          {row('no', 'No, it is not', 'The listing is left out of it.')}
        </div>
        <div className="review-actions">
          <button type="submit" className="btn btn-primary" disabled={picked === null || scanRunning || saving}>
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
