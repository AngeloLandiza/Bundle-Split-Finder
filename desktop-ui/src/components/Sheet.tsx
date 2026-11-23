import { useEffect, useRef, type ReactNode } from 'react';
import './Sheet.css';

/**
 * A window sheet (design.md, Desktop app > Sheet): it slides down from under the title bar over the
 * live window, which dims behind it and stays as it was. Escape cancels; Tab stays inside the sheet;
 * focus goes back where it was when the sheet closes. The window behind is made inert by App.
 */
export function Sheet({ label, onCancel, children, footer, width = 560 }: { label: string; onCancel: () => void; children: ReactNode; footer: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('input, button:not([disabled])');
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]'));
      if (!items.length) return;
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.({ preventScroll: true });
    };
    // onCancel is read fresh on each key; the effect runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="sheet-layer">
      <div className="sheet-dim" aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} ref={ref} style={{ inlineSize: width }}>
        <div className="sheet-body">{children}</div>
        <div className="sheet-foot">{footer}</div>
      </div>
    </div>
  );
}
