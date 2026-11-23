import { useState, type ReactNode } from 'react';
import './Fold.css';

/** Which folds he opened, kept for the session by name so the next bundle opens the same ones (as Review's Details does). */
const opened = new Map<string, boolean>();

/**
 * A long section behind its title: a native disclosure (a real button for the keyboard and for a screen reader), the title in
 * the section-head type, a count or one line beside it that says what is inside, then the content in a group box.
 * `defaultOpen` is what it does until he has chosen; after that his choice holds for the session.
 */
export function Fold({ id, title, aside, defaultOpen = false, sub = false, children }: { id: string; title: string; aside?: ReactNode; defaultOpen?: boolean; sub?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(() => opened.get(id) ?? defaultOpen);
  return (
    <details
      className={sub ? 'fold fold-sub' : 'fold'}
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now !== open) {
          setOpen(now);
          opened.set(id, now);
        }
      }}
    >
      <summary>
        <span className="fold-title">{title}</span>
        {aside ? <span className="fold-aside">{aside}</span> : null}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
