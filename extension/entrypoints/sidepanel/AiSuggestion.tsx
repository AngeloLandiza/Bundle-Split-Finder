import { forwardRef, type ReactNode } from 'react';
import { choicesOf } from '@core/scan/answers';
import type { Suggestion, VerifiedQuote } from '@core/assist/types';
import type { ReviewItem } from '@core/scan/types';
import './AiSuggestion.css';

/** Never more than this many quotes are shown (design.md: at most three). */
export const MAX_QUOTES = 3;

/** The sentence a failed call leaves under the Ask AI button. */
export function notSuggestedSentence(s: Extract<Suggestion, { status: 'not_suggested' }>): string {
  // A call that ran out of its 30 seconds is an aborted one; say what happened and what to do.
  if (s.notSuggested?.reason === 'aborted') return 'The AI took too long. Ask again.';
  return s.reason;
}

/**
 * The control a suggestion preselects: a split question's reading, or a match question's listing, by the radio's value
 * (ReviewQuestion: the index, as text). Only a verified choice preselects anything; every other state leaves the owner to choose.
 */
export function preselectOf(s: Suggestion, item: ReviewItem): string | null {
  if (s.status !== 'verified' || s.answer.decision !== 'choose') return null;
  if (s.answer.kind === 'split') return choicesOf(item)[s.answer.choiceIndex] ? String(s.answer.choiceIndex) : null;
  const asin = s.answer.asin;
  const at = item.candidates.findIndex((c) => c.asin === asin);
  return at < 0 ? null : String(at);
}

type Proposal = { kind: 'parts'; parts: string[] } | { kind: 'listing'; title: string; asin: string } | { kind: 'none' };

/** What the AI proposed, for the line in ink. For an unverified suggestion this is what it claimed. */
function proposalOf(s: Suggestion, item: ReviewItem): Proposal | null {
  if (s.status === 'verified') {
    const a = s.answer;
    return a.decision === 'none' ? { kind: 'none' } : a.kind === 'split' ? { kind: 'parts', parts: a.parts } : { kind: 'listing', title: a.title, asin: a.asin };
  }
  if (s.status !== 'unverified' || s.claimed === null || s.claimed.decision === 'cannot_tell') return null;
  const raw = s.claimed;
  if (raw.decision === 'none') return { kind: 'none' };
  if (item.kind === 'split') {
    const parts = raw.choiceIndex === null ? undefined : choicesOf(item)[raw.choiceIndex];
    return parts ? { kind: 'parts', parts } : null;
  }
  const c = item.candidates.find((x) => x.asin === raw.asin);
  return c ? { kind: 'listing', title: c.title, asin: c.asin } : null;
}

/** A source's link, only when it is a web address: http or https. */
function webUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function Quotes({ quotes }: { quotes: VerifiedQuote[] }) {
  if (quotes.length === 0) return null;
  return (
    <ul className="ai-quotes">
      {quotes.slice(0, MAX_QUOTES).map((q, i) => {
        const href = webUrl(q.url);
        return (
          <li key={i}>
            <q className="ai-quote" title={q.quote}>
              {q.quote}
            </q>{' '}
            {href ? (
              <a className="ai-source" href={href} target="_blank" rel="noopener noreferrer">
                {q.label}
              </a>
            ) : (
              <span className="ai-source-plain">{q.label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** `claimed`: what the AI said that the code could not confirm. Only a verified answer is in ink; a claim is in ink-2. */
const Answer = ({ p, claimed = false }: { p: Proposal; claimed?: boolean }): ReactNode => {
  const cls = claimed ? 'ai-answer ai-claimed' : 'ai-answer';
  return p.kind === 'none' ? (
    <p className={cls}>None of these</p>
  ) : p.kind === 'parts' ? (
    <p className={`${cls} figure`}>{p.parts.join(' + ')}</p>
  ) : (
    <p className={cls}>
      <span className="ai-listing-title">{p.title}</span> <span className="figure">{p.asin}</span>
    </p>
  );
};

export interface AiSuggestionProps {
  suggestion: Exclude<Suggestion, { status: 'not_suggested' }>;
  item: ReviewItem;
}

/**
 * What the AI drafted, in a thin rule at the question's left: plain text, no fill, no card. It is a suggestion and nothing
 * more: it selects nothing but a verified choice, and saves nothing (that is Approve, in ReviewQuestion).
 */
export const AiSuggestion = forwardRef<HTMLDivElement, AiSuggestionProps>(function AiSuggestion({ suggestion, item }, ref) {
  const proposal = proposalOf(suggestion, item);
  return (
    <div className="ai-block" role="group" aria-label="AI suggestion" tabIndex={-1} ref={ref}>
      <p className="ai-label">{suggestion.status === 'unverified' ? 'AI suggestion, unverified' : 'AI suggestion'}</p>
      {suggestion.status === 'verified' ? (
        <>
          {proposal ? <Answer p={proposal} /> : null}
          <Quotes quotes={suggestion.quotes} />
        </>
      ) : suggestion.status === 'unverified' ? (
        <>
          {proposal ? <Answer p={proposal} claimed /> : null}
          <p className="ai-reason">{suggestion.reasons[0] ?? 'The code could not confirm this from the page.'}</p>
        </>
      ) : suggestion.status === 'none_suggested' ? (
        <>
          <p className="ai-answer">AI suggests none of these fits</p>
          {/* No quotes: a found quote does not show that nothing fits, and the code cannot tell which line backs the reason (none of its quotes "names" an answer). */}
          <p className="ai-reason">{suggestion.reason}</p>
        </>
      ) : (
        <>
          <p className="ai-answer">AI could not tell from the page</p>
          <p className="ai-reason">{suggestion.reason}</p>
        </>
      )}
    </div>
  );
});
