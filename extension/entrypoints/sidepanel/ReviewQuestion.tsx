import { useState, type ReactNode } from 'react';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewAnswer, ReviewItem } from '@core/scan/types';
import { money } from '../../lib/format';

const NONE = 'none';
const CHANGED = 'That question changed. Choose again.';
export const SCAN_RUNNING = 'A scan is running. Answer when it has finished.';

export interface ReviewQuestionProps {
  item: ReviewItem;
  scanRunning: boolean;
  /** Resolves to a sentence when the answer was refused, null when it was saved. */
  onSave: (answer: ReviewAnswer) => Promise<string | null>;
}

export function ReviewQuestion({ item, scanRunning, onSave }: ReviewQuestionProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const split = item.kind === 'split';
  const subject = `${item.brand} ${item.model}`;

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

  const radio = (value: string, body: ReactNode) => (
    <label className="review-choice" key={value}>
      <input type="radio" name="review-choice" value={value} checked={picked === value} onChange={() => setPicked(value)} />
      <span className="review-choice-body">{body}</span>
    </label>
  );

  return (
    <form
      className="review-question"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {split ? (
        <>
          <h2 className="review-title">Which parts come in this bundle?</h2>
          {item.title ? <p className="review-bundle">{item.title}</p> : null}
        </>
      ) : null}
      <p className="review-model fig">{subject}</p>
      <p className="review-reason">{item.reason}</p>
      <fieldset className="review-choices">
        <legend className={split ? 'sr-only' : 'review-title'}>
          {split ? 'Which parts come in this bundle?' : `Which Amazon listing is ${subject}?`}
        </legend>
        {split && item.choices.length === 0 ? (
          <p className="review-note">No reading could be made from the model number or the page.</p>
        ) : null}
        {split
          ? item.choices.map((parts, i) => radio(String(i), <span className="fig">{parts.join(' + ')}</span>))
          : item.candidates.map((c, i) =>
              radio(
                String(i),
                <>
                  <span className="review-cand-title" title={c.title}>
                    {c.title}
                  </span>
                  <span className="review-cand-meta">
                    <span className="fig">{c.price === null ? 'No price seen' : money(c.price)}</span>
                    <a className="fig" href={`https://www.amazon.com/dp/${c.asin}`} target="_blank" rel="noreferrer">
                      {c.asin}
                    </a>
                  </span>
                </>,
              ),
            )}
        {radio(NONE, 'None of these')}
      </fieldset>
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
    </form>
  );
}
