import type { ReactNode } from 'react';
import type { AskAllResult } from '../../lib/messages';

// Step 12: the button that asks the AI about every open question, and the sentence about how the last time went.

export interface AskAllButtonProps {
  /** Questions it would ask about. */
  count: number;
  /** "about $3", said before the click; null when the model has no known rate. */
  cost: string | null;
  /** The queue is running: the button waits and says so. */
  running: boolean;
  scanRunning: boolean;
  onAsk: () => void;
}

/**
 * Secondary: Accept all stays the one ink button. aria-disabled rather than disabled, so the button keeps focus while it reads Asking….
 * The words are in the word face; only the price is a figure ("Ask AI about all 7 · about $0.09").
 */
export function AskAllButton({ count, cost, running, scanRunning, onAsk }: AskAllButtonProps) {
  const waiting = running || scanRunning;
  // "about $0.09": the price alone is the figure, as on every other control that says what it will cost.
  const price = cost === null ? null : /^(about )(\$.+)$/.exec(cost);
  return (
    <button type="button" className="btn btn-secondary ask-all" aria-disabled={waiting || undefined} onClick={() => (waiting ? undefined : onAsk())}>
      {running ? (
        'Asking…'
      ) : (
        <>
          {`Ask AI about all ${count}`}
          {price ? (
            <>
              {' · '}
              {price[1]}
              <span className="figure">{price[2]}</span>
            </>
          ) : cost ? (
            ` · ${cost}`
          ) : null}
        </>
      )}
    </button>
  );
}

/** The Ask AI row at the top of Review: the button, and under it the one sentence about how the last asking went. */
export function AskAllRow({ button, note }: { button: ReactNode; note: string | null }) {
  if (button === null && note === null) return null;
  return (
    <div className="ask-all-row">
      {button}
      {note ? (
        <p className="ask-all-note" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** A real cost under half a cent reads "under $0.01", never "$0.00". */
const cost = (usd: number): string => (usd > 0 && usd.toFixed(2) === '0.00' ? 'under $0.01' : `$${usd.toFixed(2)}`);
const questions = (n: number): string => `${n} ${n === 1 ? 'question' : 'questions'}`;

/** How the last Ask AI about all ended, in one sentence: what was asked, what the code verified, and what it cost. */
export function askAllSentence(r: AskAllResult): string {
  // The spending cap: what the queue cost passed twice the estimate its button showed. What was suggested stays; nothing was applied.
  if (r.overspent) return `Stopped: asking cost more than expected (${cost(r.costUsd)}). Nothing was applied.`;
  const spent = r.costUsd > 0 ? ` Cost ${cost(r.costUsd)}.` : '';
  if (r.problem !== null) return `Asking stopped after ${r.asked} of ${r.total}: ${r.problem}${spent}`;
  if (r.stopped) return `Stopped after ${r.asked} of ${r.total}: ${r.verified} verified.${spent}`;
  if (r.asked === 0) return 'Nothing was asked.';
  return `Asked ${questions(r.asked)}: ${r.verified} verified, ${r.asked - r.verified} left for you.${spent}`;
}
