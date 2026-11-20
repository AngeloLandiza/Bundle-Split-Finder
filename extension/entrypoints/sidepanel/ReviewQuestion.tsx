import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewAnswer, ReviewItem } from '@core/scan/types';
import { money } from '../../lib/format';
import { OpenOnHomeDepot } from './OpenOnHomeDepot';
import { amazonListingUrl, amazonSearchUrl } from '../../lib/links';
import { reviewReasonParts } from './reviewReason';
import type { StoredSuggestion } from '@core/assist/stored';
import { AiSuggestion, preselectOf } from './AiSuggestion';

const NONE = 'none';
const ENTER = 'enter';
/** The worker's refusal for a question that changed (core/src/scan/answers.ts). AcceptSuggested's drift test ties it to the worker. */
export const CHANGED = 'That question changed. Choose again.';
export const SCAN_RUNNING = 'A scan is running. Answer when it has finished.';

/** Step 11, Ask AI. Absent where the question cannot ask (no Anthropic key, or a screen that does not offer it). */
export interface AiControl {
  /** "about $0.02", said on the button; null when the model has no known rate. */
  cost: string | null;
  /** The suggestion made for this question as it reads now, if any. It is never an answer. */
  suggestion: StoredSuggestion | null;
  asking: boolean;
  /** One plain sentence about the last ask that gave nothing. */
  notice: string | null;
  onAsk: () => void;
}

export interface ReviewQuestionProps {
  item: ReviewItem;
  scanRunning: boolean;
  /** A sentence that stops the answer being saved now, said in place of the scan one (This page: the question is not saved yet). */
  blocked?: string | null;
  /** Move focus to the question when it appears: the one before it was just answered. */
  focusHeading?: boolean;
  /** Resolves to a sentence when the answer was refused, null when it was saved. `aiShown`: a suggestion was on screen when the owner answered. */
  onSave: (answer: ReviewAnswer, aiShown?: boolean) => Promise<string | null>;
  ai?: AiControl;
  /** Put the question off: nothing is sent or stored. */
  onNotNow?: () => void;
  /** Inside Detail: its head already shows the bundle's title, brand and model, so the question does not repeat them. */
  compact?: boolean;
  /** A split question's bundle page on Home Depot; null or absent when the report has none. */
  homeDepotLink?: string | null;
}

export function ReviewQuestion({ item, scanRunning, blocked = null, focusHeading = false, onSave, onNotNow, compact = false, homeDepotLink = null, ai }: ReviewQuestionProps) {
  const suggestion = ai?.suggestion?.suggestion;
  // A verified suggestion preselects its choice: the owner still presses Approve. Nothing else preselects.
  const [picked, setPicked] = useState<string | null>(() => (suggestion && suggestion.status !== 'not_suggested' ? preselectOf(suggestion, item) : null));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [typed, setTyped] = useState('');
  // Approve is pressing the AI's own answer: once the owner selects another, the button is Save answer again.
  const preselected = suggestion?.status === 'verified' ? preselectOf(suggestion, item) : null;
  const approving = preselected !== null && picked === preselected;
  const legendRef = useRef<HTMLLegendElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const wasAsking = useRef(false);
  const split = item.kind === 'split';
  const subject = `${item.brand} ${item.model}`;

  // Only when the question appears.
  useEffect(() => {
    if (focusHeading) legendRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A suggestion that arrives after the owner asked preselects only when they have not chosen yet; their own choice is not taken from them.
  // The block takes focus then: the button that was pressed is gone.
  const arrived = ai?.suggestion?.key;
  useEffect(() => {
    if (!suggestion || suggestion.status === 'not_suggested') return;
    const pre = preselectOf(suggestion, item);
    if (pre !== null) setPicked((p) => p ?? pre);
    if (wasAsking.current) blockRef.current?.focus();
    wasAsking.current = false;
  }, [arrived]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ai?.asking) wasAsking.current = true;
  }, [ai?.asking]);

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
    const refused = await onSave(answer, suggestion !== undefined && suggestion.status !== 'not_suggested');
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
          {split ? (
            'Which parts come in this bundle?'
          ) : (
            <>
              Which Amazon listing is {item.brand} <span className="figure">{item.model}</span>?
            </>
          )}
          {compact && split ? (
            <span className="review-hidden">
              {` ${item.brand} `}
              <span className="figure">{item.model}</span>
            </span>
          ) : null}
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
        {suggestion && suggestion.status !== 'not_suggested' ? <AiSuggestion ref={blockRef} suggestion={suggestion} item={item} /> : null}
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
                    <a href={amazonListingUrl(c.asin)} target="_blank" rel="noopener noreferrer">
                      <span className="figure">{c.asin}</span> on Amazon
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
          {!split ? (
            <a className="review-search" href={amazonSearchUrl(item.brand, item.model)} target="_blank" rel="noopener noreferrer">
              Search Amazon for <span className="figure">{item.model}</span>
            </a>
          ) : null}
        </div>
        <div className="review-actions">
          <button type="submit" className="btn btn-primary" disabled={picked === null || (picked === ENTER && typedParts.length === 0) || scanRunning || blocked !== null || saving}>
            {approving ? 'Approve' : 'Save answer'}
          </button>
          {onNotNow ? (
            <button type="button" className="btn btn-secondary" onClick={onNotNow} disabled={saving}>
              Skip for now
            </button>
          ) : null}
          {ai && !suggestion ? (
            // aria-disabled, not disabled: the button keeps focus while it reads Asking…
            <button type="button" className="btn ai-ask" aria-disabled={ai.asking || scanRunning} onClick={() => (ai.asking || scanRunning ? undefined : ai.onAsk())}>
              {ai.asking ? (
                'Asking…'
              ) : (
                <>
                  Ask AI
                  {ai.cost ? (
                    <>
                      {' · '}
                      <span className="figure">{ai.cost}</span>
                    </>
                  ) : null}
                </>
              )}
            </button>
          ) : null}
        </div>
        {blocked !== null ? (
          <p className="review-sentence">{blocked}</p>
        ) : scanRunning ? (
          <p className="review-sentence">{SCAN_RUNNING}</p>
        ) : error ? (
          <p className="review-sentence" role="alert">
            {error}
          </p>
        ) : null}
        {ai?.notice ? (
          <p className="review-sentence" role="status">
            {ai.notice}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
