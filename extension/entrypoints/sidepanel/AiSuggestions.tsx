import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { VerifiedRow } from '@core/assist/approve';
import type { Suggestion, VerifiedQuote } from '@core/assist/types';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewItem } from '@core/scan/types';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { STALE_REFUSALS } from './AcceptSuggested';
import { Answer, proposalOf, webUrl } from './AiSuggestion';
import { CHANGED } from './ReviewQuestion';
import './AiSuggestions.css';

// Step 12, docs/design.md "AI research and bulk approval". The section lists the questions the AI answered and the code verified, one
// compact row each, so the owner can read them quickly and approve them together. It saves nothing by itself: Approve all asks first, and
// every answer goes through the same worker message as a single answer, recorded as an AI approval.

export interface ApproveRun {
  /** 1-based place of the answer being sent. */
  index: number;
  total: number;
}

export interface ApproveResult {
  id: number;
  text: string;
}

/** A refusal that is about the moment (a scan or a search is running), not about one question: the run stops. */
const SYSTEMIC = /^A (scan|search) is running/;

/**
 * Approves each row's answer, one after another, over the same `answerReview` message a single Approve uses: the answer is the one
 * the code checked for the question as it reads now, with that question's own signature, and `aiSuggestion` says a suggestion was
 * shown, so it is recorded as an approval (agreed) for the audit. A question that changed or was answered meanwhile is skipped and
 * counted; the worker refuses an answer it cannot save with a sentence, and that one is counted and said.
 */
export function useApproveAll(api: WorkerApi, onApproved: (item: ReviewItem, seen: string) => void) {
  const [run, setRun] = useState<ApproveRun | null>(null);
  const [result, setResult] = useState<ApproveResult | null>(null);
  const busy = useRef(false);
  const made = useRef(0);
  const focusedId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const approve = async (rows: readonly VerifiedRow[]): Promise<void> => {
    if (busy.current || rows.length === 0) return;
    busy.current = true;
    let approved = 0;
    let changed = 0;
    let gone = 0;
    let refused: string | null = null;
    let refusedCount = 0;
    let failure: string | null = null;
    for (let i = 0; i < rows.length && failure === null; i++) {
      if (!mounted.current) break;
      setRun({ index: i + 1, total: rows.length });
      const row = rows[i]!;
      try {
        const reply = await api.send({ type: 'answerReview', id: row.item.id, answer: row.answer, aiSuggestion: true });
        if (reply.ok) {
          approved++;
          onApproved(row.item, reviewSignature(row.item));
        } else if (reply.error === CHANGED) {
          changed++;
        } else if (STALE_REFUSALS.includes(reply.error)) {
          gone++;
        } else if (SYSTEMIC.test(reply.error)) {
          failure = reply.error;
        } else {
          refusedCount++;
          refused ??= reply.error;
        }
      } catch {
        failure = UNREACHABLE;
      }
    }
    busy.current = false;
    if (!mounted.current) return;
    setRun(null);
    const said = [
      `Approved ${approved} of ${rows.length}.`,
      changed > 0 ? `${changed} had changed and ${changed === 1 ? 'is' : 'are'} still open.` : null,
      gone > 0 ? `${gone} ${gone === 1 ? 'was' : 'were'} no longer open.` : null,
      refusedCount > 0 ? `${refusedCount} could not be saved: ${refused}` : null,
      failure,
    ];
    made.current += 1;
    setResult({ id: made.current, text: said.filter((x) => x !== null).join(' ') });
  };

  const clear = () => setResult(null);
  return { run, result, approve, clear, focusedId };
}

/** The bundle or part a row is about, in one line: the bundle's own name, else its brand and model. */
export const rowName = (item: ReviewItem): string => (item.kind === 'split' && item.title ? item.title : `${item.brand} ${item.model}`);

/**
 * The quote a row shows: the shortest quote that contains at least one of the answer's models (of equal length, the one with more of them),
 * so it fits the row's one line. With no model in any quote, or none given, the shortest that names the answer; with none naming it, the first.
 */
export const keyQuoteOf = (quotes: readonly VerifiedQuote[], models: readonly string[] = []): VerifiedQuote | undefined => {
  const naming = quotes.filter((q) => q.names);
  if (naming.length === 0) return quotes[0];
  const wanted = [...new Set(models.map((m) => m.toUpperCase()))];
  const score = (q: VerifiedQuote): number => wanted.filter((m) => q.quote.toUpperCase().includes(m)).length;
  const withModel = naming.filter((q) => score(q) > 0);
  const pool = withModel.length > 0 ? withModel : naming;
  return [...pool].sort((x, y) => x.quote.length - y.quote.length || score(y) - score(x))[0];
};

/** A model this near the start of the line is in view at 360px already: the line is not cut at its front. */
const MODEL_IN_VIEW = 20;

/**
 * The text of a row's quote line: the quote without a search row's own label (compactQuote) and, when one of the models is
 * in it further along than the line shows, starting at the model ("…PCL525B (Tool Only)"), so the model shows before the line is cut at 360px. A model only
 * the label names makes the line the whole quote. The full quote stays the line's hover text.
 */
export const quoteLineOf = (quote: string, models: readonly string[] = []): string => {
  const find = (t: string): number => {
    const at = models.map((m) => t.toUpperCase().indexOf(m.toUpperCase())).filter((i) => i >= 0);
    return at.length > 0 ? Math.min(...at) : -1;
  };
  let text = compactQuote(quote);
  let at = find(text);
  if (at < 0 && find(quote) >= 0) {
    text = quote;
    at = find(quote);
  }
  return at > MODEL_IN_VIEW ? `…${text.slice(at)}` : text;
};

/**
 * A Home Depot search row is quoted with its own label in front ("RYOBI PCL525B (item 318898528): ONE+ 18V Cordless Jig Saw"). In a
 * compact row that label would use the line before the quote said anything, so the row shows the title after it. The full quote is the
 * line's hover text and is shown whole when the row is opened.
 */
export const compactQuote = (quote: string): string => /^[^:]{1,60}\(item \d+\):\s+(\S.*)$/.exec(quote)?.[1] ?? quote;

/** The models of a verified answer, for choosing its key quote. */
const modelsOf = (s: Suggestion): string[] => (s.status === 'verified' && 'parts' in s.answer ? s.answer.parts : []);

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="ai-row-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <path d="M4 10l4-4 4 4" /> : <path d="M4 6l4 4 4-4" />}
    </svg>
  );
}

export interface AiSuggestionsSectionProps {
  rows: readonly VerifiedRow[];
  approve: ReturnType<typeof useApproveAll>;
  scanRunning: boolean;
  /** Ids of the rows that are open. */
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** The question's full suggestion and controls, for an open row. */
  renderQuestion: (row: VerifiedRow) => ReactNode;
}

export function AiSuggestionsSection({ rows, approve, scanRunning, expanded, onToggle, renderQuestion }: AiSuggestionsSectionProps) {
  // The rows the owner was asked about. The question is put about these rows and the press applies exactly these: a row verified
  // while the question is open is not in it, and waits for the next time (docs/design.md, "Approve all verified").
  const [asked, setAsked] = useState<readonly VerifiedRow[] | null>(null);
  const titleId = useId();
  const askRef = useRef<HTMLButtonElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const confirming = asked !== null;
  // Focus follows the owner's own press: the confirmation's Approve when it opens, the button again when it is cancelled.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) yesRef.current?.focus();
    else if (wasConfirming.current && approve.run === null) askRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]); // eslint-disable-line react-hooks/exhaustive-deps
  // A scan starting, or the rows going, withdraws a question the owner has not answered.
  useEffect(() => {
    if (scanRunning || rows.length === 0) setAsked(null);
  }, [scanRunning, rows.length]);

  if (rows.length === 0 && approve.run === null) return null;
  const n = rows.length;
  const running = approve.run !== null;
  const count = asked?.length ?? n;
  return (
    <section className="ai-section" aria-labelledby={titleId}>
      <div className="ai-section-head">
        <h2 id={titleId} className="ai-section-title">
          AI suggestions · <span className="figure">{running ? approve.run!.total : n}</span>
        </h2>
        {running ? (
          <span className="ai-approve-progress" role="status">
            Approving <span className="figure">{approve.run!.index}</span> of <span className="figure">{approve.run!.total}</span>…
          </span>
        ) : confirming ? null : (
          <button type="button" className="ai-approve" ref={askRef} aria-disabled={scanRunning || undefined} onClick={() => (scanRunning ? undefined : setAsked(rows))}>
            Approve all <span className="figure">{n}</span> verified
          </button>
        )}
      </div>
      {confirming && !running ? (
        <div className="ai-confirm" role="group" aria-label="Approve all verified AI answers">
          <span className="ai-confirm-q">
            Approve <span className="figure">{count}</span> AI {count === 1 ? 'answer' : 'answers'}?
          </span>
          <button
            type="button"
            className="btn btn-primary"
            ref={yesRef}
            disabled={scanRunning}
            onClick={() => {
              setAsked(null);
              void approve.approve(asked);
            }}
          >
            Approve
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setAsked(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {scanRunning && !running ? <p className="ai-note">A scan is running. Approve when it has finished.</p> : null}
      <ul className="ai-rows">
        {rows.map((row) => {
          const open = expanded.has(row.item.id);
          const bodyId = `${titleId}-${row.item.id}`;
          const suggestion = row.stored.suggestion;
          const proposal = proposalOf(suggestion, row.item);
          const models = modelsOf(suggestion);
          const quote = suggestion.status === 'verified' ? keyQuoteOf(suggestion.quotes, models) : undefined;
          const href = quote ? webUrl(quote.url) : null;
          return (
            <li key={`${row.item.id}|${reviewSignature(row.item)}`} className="ai-row" data-open={open || undefined}>
              <button type="button" className="ai-row-head" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(row.item.id)}>
                <span className="ai-row-main">
                  <span className="ai-row-name">{rowName(row.item)}</span>
                  {proposal ? <Answer p={proposal} /> : null}
                </span>
                <Chevron open={open} />
              </button>
              {quote && !open ? (
                <p className="ai-row-quote">
                  <q className="ai-row-quote-text" title={quote.quote}>
                    {quoteLineOf(quote.quote, models)}
                  </q>
                  {href ? (
                    <a className="ai-source" href={href} target="_blank" rel="noopener noreferrer">
                      {quote.label}
                    </a>
                  ) : (
                    <span className="ai-source-plain">{quote.label}</span>
                  )}
                </p>
              ) : null}
              {open ? (
                <div id={bodyId} className="ai-row-body">
                  {renderQuestion(row)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What the last Approve all did, in one sentence. It takes focus once, like Accept all's. */
export function ApproveResultLine({ result, focusedId }: { result: ApproveResult | null; focusedId: { current: number } }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (result !== null && focusedId.current !== result.id) {
      focusedId.current = result.id;
      ref.current?.focus();
    }
  }, [result?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return result === null ? null : (
    <p className="ai-result" ref={ref} tabIndex={-1}>
      {result.text}
    </p>
  );
}
