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

/** Secondary: Accept all stays the one ink button. aria-disabled rather than disabled, so the button keeps focus while it reads Asking…. */
export function AskAllButton({ count, cost, running, scanRunning, onAsk }: AskAllButtonProps) {
  const waiting = running || scanRunning;
  return (
    <button type="button" className="btn btn-secondary ask-all" aria-disabled={waiting || undefined} onClick={() => (waiting ? undefined : onAsk())}>
      {running ? (
        'Asking…'
      ) : (
        <>
          Ask AI about all <span className="figure">{count}</span>
          {cost ? (
            <>
              {' · '}
              <span className="figure">{cost}</span>
            </>
          ) : null}
        </>
      )}
    </button>
  );
}

const cost = (usd: number): string => `$${usd.toFixed(2)}`;
const questions = (n: number): string => `${n} ${n === 1 ? 'question' : 'questions'}`;

/** How the last Ask AI about all ended, in one sentence: what was asked, what the code verified, and what it cost. */
export function askAllSentence(r: AskAllResult): string {
  const spent = r.costUsd > 0 ? ` Cost ${cost(r.costUsd)}.` : '';
  if (r.problem !== null) return `Asking stopped after ${r.asked} of ${r.total}: ${r.problem}${spent}`;
  if (r.stopped) return `Stopped after ${r.asked} of ${r.total}: ${r.verified} verified.${spent}`;
  if (r.asked === 0) return 'Nothing was asked.';
  return `Asked ${questions(r.asked)}: ${r.verified} verified, ${r.asked - r.verified} left for you.${spent}`;
}
