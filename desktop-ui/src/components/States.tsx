import type { ReactNode } from 'react';
import type { ApiError } from '../api/types';
import { Button } from './Button';
import { Glyph } from './Glyph';
import './States.css';

/** NSProgressIndicator, spinning style: eight spokes turning in steps. Decorative to a screen reader. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1="8" y1="1.8" x2="8" y2="4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity={0.2 + (0.8 * (i + 1)) / 8} transform={`rotate(${i * 45} 8 8)`} />
      ))}
    </svg>
  );
}

/** NSProgressIndicator, bar style: a determinate 4px bar in the accent. */
export function ProgressBar({ value, label, valueText }: { value: number; label: string; valueText?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={valueText}>
      {/* A measured width has no class. */}
      <span className="progress-fill" style={{ inlineSize: `${pct}%` }} />
    </span>
  );
}

/** A level indicator: searches left, AI spend against its cap. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span className="meter-fill" style={{ inlineSize: `${Math.round(share * 100)}%` }} />
    </span>
  );
}

/**
 * The macOS empty view: centred and grey, one line that says why, one action that changes it. It never
 * shows invented data.
 */
export function EmptyState({ title, cause, action, compact = false }: { title: string; cause?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? ' empty-compact' : ''}`} role="status">
      <p className="empty-title">{title}</p>
      {cause ? <p className="empty-cause">{cause}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** The first load: a small spinner and the word, centred where the content will be. */
export function LoadingState({ label = 'Loading', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`loading${compact ? ' loading-compact' : ''}`} role="status" aria-busy="true">
      <Spinner size={16} />
      <span>{label}…</span>
    </div>
  );
}

/** A failed load: the agent's sentence and Retry. Not in the loss colour: red is only for a loss. */
export function ErrorState({ sentence, onRetry, cost }: { sentence: string; onRetry: () => void; cost?: ReactNode }) {
  return (
    <div className="empty" role="alert">
      <p className="empty-title">Could not load</p>
      <p className="empty-cause">{sentence}</p>
      <div className="empty-action">
        <Button onClick={onRetry} cost={cost}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/** A failed load. When the agent is offline the banner under the toolbar already says so: one quiet line here. */
export function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  if (error.kind === 'offline') return <EmptyState title="Not available" cause="Shown again when the agent is running." compact />;
  return <ErrorState sentence={error.message} onRetry={onRetry} />;
}

/**
 * A banner under the toolbar for a state of the whole app: the agent offline, Chrome closed, the search
 * budget at its reserve. attention is for a state that needs him; quiet is a fact about the app.
 */
export function Notice({ tone = 'quiet', title, children, action }: { tone?: 'quiet' | 'attention'; title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'attention' ? 'alert' : 'status'}>
      {tone === 'attention' ? <Glyph name="warning" size={14} className="notice-glyph" /> : null}
      <div className="notice-text">
        {title ? <strong>{title}</strong> : null}
        <span>{children}</span>
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

/** "Approve 4 AI answers? Approve · Cancel" in place of the control that opened it. */
export function ConfirmInline({ question, confirmLabel, onConfirm, onCancel, busy }: { question: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <span className="confirm" role="group" aria-label="Confirm">
      <span>{question}</span>
      <Button size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="primary" size="sm" onClick={onConfirm} busy={busy} busyLabel="Working…" autoFocus>
        {confirmLabel}
      </Button>
    </span>
  );
}
