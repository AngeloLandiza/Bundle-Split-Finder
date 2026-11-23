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

/** The check beside a model Home Depot's page confirmed. Not colour alone: it has a name for a screen reader and a tooltip. */
export function SettledMark() {
  return (
    <svg className="settled-mark" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Confirmed by Home Depot's page">
      <title>Confirmed by Home Depot's page</title>
      <path d="M2 5.2l2 2L8 3" />
    </svg>
  );
}

/** A reading's models, each with the check when Home Depot's page confirmed it. */
export function MarkedModels({ marks }: { marks: { model: string; settled: boolean }[] }) {
  return (
    <>
      {marks.map((m, i) => (
        <span key={`${m.model}|${i}`} className="marked-model">
          {i > 0 ? <span aria-hidden="true"> + </span> : null}
          {m.model}
          {m.settled ? <SettledMark /> : null}
        </span>
      ))}
    </>
  );
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
