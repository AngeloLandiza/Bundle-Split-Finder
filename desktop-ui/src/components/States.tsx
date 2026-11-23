import type { ReactNode } from 'react';
import type { ApiError } from '../api/types';
import { Button } from './Button';
import './States.css';

/** An empty list says why it is empty and what to do; it never shows invented data. */
export function EmptyState({ title, cause, action }: { title: string; cause: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <p className="empty-title">{title}</p>
      <p className="empty-cause">{cause}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** A failed load: the sentence from the agent and a Retry. Not in the loss colour: rust is only for a loss. */
export function ErrorState({ sentence, onRetry, cost }: { sentence: string; onRetry: () => void; cost?: ReactNode }) {
  return (
    <div className="error" role="alert">
      <p>{sentence}</p>
      <Button size="sm" onClick={onRetry} cost={cost}>
        Retry
      </Button>
    </div>
  );
}

/** A failed load. When the agent is offline the band under the header already says so: one quiet line here. */
export function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  if (error.kind === 'offline') return <p className="load-offline">Shown again when the agent is running.</p>;
  return <ErrorState sentence={error.message} onRetry={onRetry} />;
}

/**
 * A band under the page header for a state of the whole app: the agent offline, Chrome closed,
 * the search budget at its reserve. attention is amber, for a state that needs him; quiet is sunken.
 */
export function Notice({ tone = 'quiet', title, children, action }: { tone?: 'quiet' | 'attention'; title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'attention' ? 'alert' : 'status'}>
      <div className="notice-text">
        {title ? <strong>{title}</strong> : null}
        <span>{children}</span>
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

/** Still placeholder rows while the first load runs: no spinner, no shimmer (design.md, Loading). */
export function SkeletonRows({ rows = 6, columns = 1, label = 'Loading' }: { rows?: number; columns?: number; label?: string }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-bar skeleton-main" />
          {Array.from({ length: columns - 1 }, (_, j) => (
            <span className="skeleton-bar skeleton-fig" key={j} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A 4px meter: searches left, AI spend against its cap. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      {/* The one computed style in the app: a measured width has no class. */}
      <span className="meter-fill" style={{ inlineSize: `${Math.round(share * 100)}%` }} />
    </span>
  );
}

/** "Approve 4 AI answers? Approve · Cancel" in place of the control that opened it. */
export function ConfirmInline({ question, confirmLabel, onConfirm, onCancel, busy }: { question: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <span className="confirm" role="group" aria-label="Confirm">
      <span>{question}</span>
      <Button variant="primary" size="sm" onClick={onConfirm} busy={busy} busyLabel="Working…" autoFocus>
        {confirmLabel}
      </Button>
      <Button variant="quiet" size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </span>
  );
}
