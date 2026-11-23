import type { ReactNode } from 'react';
import type { ReviewQuestion } from '../api/types';
import { Spinner } from '../components/States';
import { CHECKING_AGAIN, forceLabel, type AskNote } from '../lib/askAi';

/** What Ask AI answered, at the foot of the card: the app took it, or the reason it did not and the action that reason implies. */
export function AskNoteLine({ note, q, onForce }: { note: AskNote; q: ReviewQuestion; onForce: () => void }) {
  switch (note.phase) {
    case 'sending':
      return (
        <span role="status">
          <Spinner size={12} /> Asking…
        </span>
      );
    case 'queued':
      return (
        <span role="status">
          <Spinner size={12} /> {CHECKING_AGAIN}
        </span>
      );
    case 'declined': {
      const force = forceLabel(note, q);
      return (
        <>
          <span role="status">{note.reason}</span>
          {force ? (
            <span>
              <button type="button" className="link-btn" onClick={onForce}>
                {force}
              </button>
            </span>
          ) : null}
        </>
      );
    }
    case 'failed':
      return (
        <span role="alert" className="card-note-error">
          {note.text}
        </span>
      );
  }
}

/** While the app works the choices wait behind "or answer it yourself"; otherwise they are the pane as they were. */
export function Own({ working, open, onToggle, children }: { working: boolean; open: boolean; onToggle: (open: boolean) => void; children: ReactNode }) {
  if (!working) return <>{children}</>;
  return (
    <details className="own-answer" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>or answer it yourself</summary>
      {children}
    </details>
  );
}
