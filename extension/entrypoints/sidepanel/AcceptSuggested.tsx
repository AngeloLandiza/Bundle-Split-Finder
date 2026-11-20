import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pageReadingOf } from '@core/pageSplit';
import { choicesOf, reviewSignature } from '@core/scan/answers';
import type { ReviewItem } from '@core/scan/types';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { CHANGED, SCAN_RUNNING } from './ReviewQuestion';
import './AcceptSuggested.css';

/**
 * The worker's refusals that mean "this question is not the one the panel showed" (core/src/scan/answers.ts:
 * CHANGED, ANSWERED, NOT_FOUND). Such a question is skipped and counted: CHANGED as still open, the others as no longer open. Any other refusal (a scan or a search
 * running, a malformed request) stops the run. AcceptSuggested.test.ts checks these against the worker's own sentences.
 */
export const STALE_REFUSALS: readonly string[] = [
  CHANGED,
  'That question was already answered.',
  'That question was not found.',
];

/**
 * Open split questions that offer exactly one reading, in the order given. Not one whose reading came from the Home
 * Depot page (Ruling 76): the model number said nothing, so the owner reads those one at a time, with the page's sentence.
 */
export const suggestedOf = (open: readonly ReviewItem[]): ReviewItem[] =>
  open.filter((r) => r.kind === 'split' && choicesOf(r).length === 1 && !pageReadingOf(r.reason));

/** `id` counts the runs, so the same sentence twice is still a new one to focus. */
export interface AcceptResult {
  id: number;
  text: string;
}

/** Rows shown before the rest are folded away, so Accept all stays above the fold at 360px. */
const FOLD = 3;

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
  // Counts the results ever made. Not derived from `result`, which is cleared when a scan starts.
  const made = useRef(0);
  // The last result id that took focus. Kept here, above the block, which remounts when the tab goes between its states.
  const focusedId = useRef(0);
  // False once the tab is left: the loop stops before its next send.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const accept = async (items: readonly ReviewItem[]): Promise<void> => {
    if (busy.current || items.length === 0) return;
    busy.current = true;
    let accepted = 0;
    let changed = 0;
    let gone = 0;
    let failure: string | null = null;
    for (let i = 0; i < items.length && failure === null; i++) {
      if (!mounted.current) break;
      setRun({ index: i + 1, items });
      const item = items[i]!;
      const seen = reviewSignature(item);
      try {
        const reply = await api.send({ type: 'answerReview', id: item.id, answer: { choice: 0, seen } });
        if (reply.ok) {
          accepted++;
          onAccepted(item, seen);
        } else if (reply.error === CHANGED) {
          changed++;
        } else if (STALE_REFUSALS.includes(reply.error)) {
          gone++;
        } else {
          failure = reply.error;
        }
      } catch {
        failure = UNREACHABLE;
      }
    }
    busy.current = false;
    if (!mounted.current) return;
    setRun(null);
    const said = [
      `Accepted ${accepted} of ${items.length}.`,
      changed > 0 ? `${changed} had changed and ${changed === 1 ? 'is' : 'are'} still open.` : null,
      gone > 0 ? `${gone} ${gone === 1 ? 'was' : 'were'} no longer open.` : null,
      failure,
    ];
    made.current += 1;
    setResult({ id: made.current, text: said.filter((x) => x !== null).join(' ') });
  };

  /** A sentence about the questions as they were is stale once a scan starts. */
  const clear = () => setResult(null);

  return { run, result, accept, clear, focusedId };
}

export interface AcceptSuggestedProps {
  /** The open questions that offer one reading, now. Ignored while a run is going: its own list is shown. */
  items: readonly ReviewItem[];
  run: AcceptRun | null;
  result: AcceptResult | null;
  /** The id of the last result that took focus; the block sets it, so a remount does not focus the same result again. */
  focusedId: { current: number };
  scanRunning: boolean;
  onAccept: () => void;
  /** A bundle's page on Home Depot, the link its question shows; null when the report has none. */
  linkOf: (item: ReviewItem) => string | null;
  /** Step 12: a secondary button that sits beside Accept all, or alone at the top when there is no block (Ask AI about all). */
  extra?: ReactNode;
}

export function AcceptSuggested({ items, run, result, focusedId, scanRunning, onAccept, linkOf, extra }: AcceptSuggestedProps) {
  const resultRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Focus goes to the sentence once per result, whatever remounts the block: it is what the owner pressed the button for.
  useEffect(() => {
    if (result !== null && focusedId.current !== result.id) {
      focusedId.current = result.id;
      resultRef.current?.focus();
    }
  }, [result?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = run ? run.items : items;
  const folded = shown.length > FOLD && !expanded;
  const block = run !== null || shown.length >= 2;
  return (
    <>
      {block ? (
        <section className="accept" aria-labelledby="accept-title">
          <h2 id="accept-title" className="accept-title">
            {shown.length} bundles have one suggested answer
          </h2>
          <ul className="accept-list">
            {(folded ? shown.slice(0, FOLD) : shown).map((r) => {
              const href = linkOf(r);
              return (
                <li key={r.id} className="accept-row">
                  {href ? (
                    <a className="figure fig-sm accept-link" href={href} target="_blank" rel="noopener noreferrer">
                      {r.model}{' '}
                      <span className="accept-hidden">on Home Depot</span>
                    </a>
                  ) : (
                    <span className="figure fig-sm">{r.model}</span>
                  )}
                  <span className="accept-hidden"> splits into </span>
                  <span className="figure fig-sm accept-parts">{choicesOf(r)[0]!.join(' + ')}</span>
                </li>
              );
            })}
          </ul>
          {shown.length > FOLD ? (
            <div className="accept-actions">
              <button type="button" className="accept-toggle" aria-expanded={!folded} onClick={() => setExpanded(folded)}>
                {folded ? `Show all ${shown.length}` : 'Show fewer'}
              </button>
            </div>
          ) : null}
          <div className="accept-actions">
            <button type="button" className="btn btn-primary" disabled={run !== null || scanRunning} onClick={onAccept}>
              {run ? `Accepting ${run.index} of ${run.items.length}…` : `Accept all ${shown.length}`}
            </button>
            {extra}
          </div>
          <p className="accept-note">Each bundle gets the parts shown. Questions with more than one answer stay below.</p>
          {scanRunning && !run ? <p className="accept-note">{SCAN_RUNNING}</p> : null}
        </section>
      ) : extra ? (
        <div className="ask-all-bar">{extra}</div>
      ) : null}
      {result !== null ? (
        <p className="accept-result" ref={resultRef} tabIndex={-1}>
          {result.text}
        </p>
      ) : null}
    </>
  );
}
