import { useEffect, useRef, useState } from 'react';
import { choicesOf, reviewSignature } from '@core/scan/answers';
import type { ReviewItem } from '@core/scan/types';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { SCAN_RUNNING } from './ReviewQuestion';
import './AcceptSuggested.css';

/**
 * The worker's refusals that mean "this question is not the one the panel showed" (core/src/scan/answers.ts:
 * CHANGED, ANSWERED, NOT_FOUND). Such a question is skipped and counted. Any other refusal (a scan or a search
 * running, a malformed request) stops the run. AcceptSuggested.test.ts checks these against the worker's own sentences.
 */
export const STALE_REFUSALS: readonly string[] = [
  'That question changed. Choose again.',
  'That question was already answered.',
  'That question was not found.',
];

/** Open split questions that offer exactly one reading, in the order given. */
export const suggestedOf = (open: readonly ReviewItem[]): ReviewItem[] => open.filter((r) => r.kind === 'split' && choicesOf(r).length === 1);

/** `id` counts the runs, so the same sentence twice is still a new one to focus. */
export interface AcceptResult {
  id: number;
  text: string;
}

export interface AcceptRun {
  /** 1-based place of the question being sent. */
  index: number;
  /** The questions the run started with: the list stays as it was shown while it runs. */
  items: readonly ReviewItem[];
}

/**
 * Answers each question with its one reading, one after another, over the same `answerReview` message a single
 * answer uses, with each question's own signature. The state lives in the caller: the result sentence outlives
 * the block, which goes away once fewer than two questions are left.
 */
export function useAcceptAll(api: WorkerApi, onAccepted: (item: ReviewItem, seen: string) => void) {
  const [run, setRun] = useState<AcceptRun | null>(null);
  const [result, setResult] = useState<AcceptResult | null>(null);
  const busy = useRef(false);

  const accept = async (items: readonly ReviewItem[]): Promise<void> => {
    if (busy.current || items.length === 0) return;
    busy.current = true;
    let accepted = 0;
    let skipped = 0;
    let failure: string | null = null;
    for (let i = 0; i < items.length && failure === null; i++) {
      setRun({ index: i + 1, items });
      const item = items[i]!;
      const seen = reviewSignature(item);
      try {
        const reply = await api.send({ type: 'answerReview', id: item.id, answer: { choice: 0, seen } });
        if (reply.ok) {
          accepted++;
          onAccepted(item, seen);
        } else if (STALE_REFUSALS.includes(reply.error)) {
          skipped++;
        } else {
          failure = reply.error;
        }
      } catch {
        failure = UNREACHABLE;
      }
    }
    busy.current = false;
    setRun(null);
    setResult((r) => ({ id: (r?.id ?? 0) + 1, text: failure ?? `Accepted ${accepted} of ${items.length}.${skipped > 0 ? ` ${skipped} had changed and are still open.` : ''}` }));
  };

  return { run, result, accept };
}

export interface AcceptSuggestedProps {
  /** The open questions that offer one reading, now. Ignored while a run is going: its own list is shown. */
  items: readonly ReviewItem[];
  run: AcceptRun | null;
  result: AcceptResult | null;
  scanRunning: boolean;
  onAccept: () => void;
}

export function AcceptSuggested({ items, run, result, scanRunning, onAccept }: AcceptSuggestedProps) {
  const resultRef = useRef<HTMLParagraphElement>(null);
  // Focus goes to the sentence once, when it first says something: it is what the owner pressed the button for.
  useEffect(() => {
    if (result !== null) resultRef.current?.focus();
  }, [result?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = run ? run.items : items;
  const block = run !== null || shown.length >= 2;
  return (
    <>
      {block ? (
        <section className="accept" aria-labelledby="accept-title">
          <h2 id="accept-title" className="accept-title">
            {shown.length} bundles have one suggested answer
          </h2>
          <ul className="accept-list">
            {shown.map((r) => (
              <li key={r.id} className="accept-row">
                <span className="figure fig-sm">{r.model}</span>
                <span className="accept-hidden"> splits into </span>
                <span className="figure fig-sm accept-parts">{choicesOf(r)[0]!.join(' + ')}</span>
              </li>
            ))}
          </ul>
          <div className="accept-actions">
            <button type="button" className="btn btn-primary" disabled={run !== null || scanRunning} onClick={onAccept}>
              {run ? `Accepting ${run.index} of ${run.items.length}…` : `Accept all ${shown.length}`}
            </button>
          </div>
          <p className="accept-note">Each bundle gets the parts shown. Questions with more than one answer stay below.</p>
          {scanRunning && !run ? <p className="accept-note">{SCAN_RUNNING}</p> : null}
        </section>
      ) : null}
      {result !== null ? (
        <p className="accept-result" ref={resultRef} tabIndex={-1}>
          {result.text}
        </p>
      ) : null}
    </>
  );
}
