import { useEffect, useId, useRef, type ReactNode } from 'react';
import './Layout.css';

/** The page's title (20/28 semibold), an optional quiet line under it, and the page's actions at the right. */
export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1 className="page-title" tabIndex={-1}>
          {title}
        </h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/** A band with a section label ("BEST DEALS · 5") and its action at the right. One level of surface: no nesting. */
export function Section({ label, count, action, children, flush = false, id }: { label: string; count?: number; action?: ReactNode; children: ReactNode; flush?: boolean; id?: string }) {
  const auto = useId();
  const labelId = id ?? auto;
  return (
    <section className="section" aria-labelledby={labelId}>
      <div className="section-head">
        <h2 className="caps" id={labelId}>
          {label}
          {count !== undefined ? <span className="fig"> · {count}</span> : null}
        </h2>
        {action ? <div className="section-action">{action}</div> : null}
      </div>
      <div className={flush ? 'section-body section-flush' : 'section-body'}>{children}</div>
    </section>
  );
}

/**
 * The main list and, when something is open, a detail pane on the right. Escape closes the pane
 * and focus returns to the row that opened it (the screen passes `onClose` and restores focus).
 */
export function SplitPane({ main, pane, paneLabel, onClose }: { main: ReactNode; pane: ReactNode | null; paneLabel: string; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pane) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pane, onClose]);
  return (
    <div className={`split${pane ? ' split-open' : ''}`}>
      <div className="split-main">{main}</div>
      {pane ? (
        <aside className="split-pane view-enter" aria-label={paneLabel} ref={ref}>
          {pane}
        </aside>
      ) : null}
    </div>
  );
}

/** The pane's close control: a real button, Esc does the same. */
export function PaneClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="pane-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M3 3l8 8M11 3l-8 8" />
      </svg>
    </button>
  );
}

/** A key cap in a hint line: "J/K to move". */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
