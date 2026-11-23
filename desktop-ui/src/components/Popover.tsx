import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import type { GlyphName } from './Glyph';
import './Popover.css';

/**
 * NSPopover from a toolbar item: a button that opens a small panel under it. Escape or a click outside
 * closes it and focus goes back to the button. The panel is not a drag region of the title bar.
 */
export function Popover({ label, glyph, title, children, width = 280 }: { label?: ReactNode; glyph: GlyphName; title: string; children: ReactNode; width?: number }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    panel.current?.querySelector<HTMLElement>('input, button, select')?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <span className="popover-anchor">
      <Button ref={button} variant="toolbar" glyph={glyph} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" title={title} aria-label={label ? undefined : title} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open ? (
        <div className="popover" id={id} role="dialog" aria-label={title} ref={panel} data-tauri-drag-region="false" style={{ inlineSize: width }}>
          {children}
        </div>
      ) : null}
    </span>
  );
}

/** One labelled block inside a popover: "Appearance", then its control. */
export function PopoverSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="popover-section">
      <h3 className="popover-title">{title}</h3>
      {children}
    </section>
  );
}
