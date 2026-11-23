import { useEffect, useId, useRef, type ReactNode } from 'react';
import { EmptyState } from './States';
import { clampInspector, useUi } from './ui';
import './Layout.css';

/**
 * A grouped section, as in System Settings: its title and count above one rounded box, its action at the
 * right of the title. Rows inside the box are separated by inset hairlines. One level: no box in a box.
 */
export function Section({ label, count, action, children, flush = false, id, note }: { label: string; count?: number; action?: ReactNode; children: ReactNode; flush?: boolean; id?: string; note?: ReactNode }) {
  const auto = useId();
  const labelId = id ?? auto;
  return (
    <section className="section" aria-labelledby={labelId}>
      <div className="section-head">
        <h2 className="section-title" id={labelId}>
          {label}
          {count !== undefined ? <span className="section-count fig">{count}</span> : null}
        </h2>
        {action ? <div className="section-action">{action}</div> : null}
      </div>
      <div className={flush ? 'section-box section-flush' : 'section-box'}>{children}</div>
      {note ? <p className="section-note">{note}</p> : null}
    </section>
  );
}

/**
 * The content on the left and the inspector on the right (Cmd+Option+I shows or hides it), split by a
 * divider that drags to resize. With nothing selected the inspector says so, as in Finder. Escape
 * deselects (the screen passes `onClose` and restores focus).
 */
export function InspectorSplit({ main, inspector, label, onClose, empty = 'No selection', min = 0 }: { main: ReactNode; inspector: ReactNode | null; label: string; onClose?: () => void; empty?: string; min?: number }) {
  const ui = useUi();
  const width = Math.max(ui.inspectorWidth, min);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!inspector || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspector, onClose]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const right = box.current?.getBoundingClientRect().right ?? window.innerWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => ui.setInspectorWidth(clampInspector(right - ev.clientX));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      document.documentElement.classList.remove('resizing');
    };
    document.documentElement.classList.add('resizing');
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  const onKeyResize = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      ui.setInspectorWidth(clampInspector(width + (e.key === 'ArrowLeft' ? 20 : -20)));
    }
  };

  return (
    <div className={`split${ui.inspectorShown ? ' split-open' : ''}`} ref={box} style={{ ['--inspector-w' as string]: `${width}px` }}>
      <div className="split-main">{main}</div>
      {ui.inspectorShown ? (
        <>
          <div
            className="split-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the inspector"
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={onKeyResize}
          />
          <aside className="inspector" aria-label={label}>
            {inspector ?? <EmptyState title={empty} />}
          </aside>
        </>
      ) : null}
    </div>
  );
}

/** A key cap in a hint line: "J/K to move". */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
