import type { ReactNode } from 'react';
import './Tag.css';

/**
 * attention: amber, only for "needs you" (Needs your answer, Title match, at the limit).
 * neutral: sunken, for plain states (Inactive listing, Undone).
 * verified: ink outline with a check, the one icon a grade carries.
 * buy: system green words, no icon: "Buy now" on a deal the last scan found worth buying.
 */
export function Tag({ tone = 'neutral', children, title }: { tone?: 'attention' | 'neutral' | 'verified' | 'buy'; children: ReactNode; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {tone === 'verified' ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 5.2l2 2L8 3" />
        </svg>
      ) : null}
      {children}
    </span>
  );
}

/** A count beside a label: the rail's Review count, "AI verified · 4". Amber when it needs him. */
export function Count({ n, attention = false, label }: { n: number; attention?: boolean; label?: string }) {
  return (
    <span className={`count fig${attention && n > 0 ? ' count-attention' : ''}`} aria-label={label}>
      {n}
    </span>
  );
}
