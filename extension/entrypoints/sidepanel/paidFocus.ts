import { useCallback, useEffect, useMemo, useRef } from 'react';

/** The link of a Deals row, or the Deals tab when the row is not on screen. */
export function rowLinkOrTab(key: string): HTMLElement | null {
  const link = [...document.querySelectorAll<HTMLElement>('[data-key]')].find((el) => el.dataset.key === key);
  return link ?? document.querySelector<HTMLElement>('nav[aria-label="Views"] button');
}

interface Pending {
  button: HTMLElement;
  fallback: () => HTMLElement | null;
  ended: boolean;
  /** The report on screen when the action ended: the next one is the one that shows what the action did. */
  endedAt: unknown;
}

/**
 * Focus after a paid action (a Look up or a Verify). A press on a button that the result removes would leave focus
 * on <body>. `begin` is called at the press, with the button; if focus is on it, `end` is called when the action has
 * ended, and once the report shows the result the focus goes to `fallback()` when the button is gone, and back to the
 * button when it stays but lost focus. A press with focus elsewhere is left alone.
 */
export function usePaidFocus(report: unknown) {
  const pending = useRef<Pending | null>(null);
  const latest = useRef(report);
  latest.current = report;

  const begin = useCallback((button: HTMLElement | null, fallback: () => HTMLElement | null) => {
    pending.current = button && document.activeElement === button ? { button, fallback, ended: false, endedAt: undefined } : null;
  }, []);
  const end = useCallback(() => {
    const p = pending.current;
    if (p) {
      p.ended = true;
      p.endedAt = latest.current;
    }
  }, []);

  // After every render: the result may have arrived with it.
  useEffect(() => {
    const p = pending.current;
    if (!p || !p.ended) return;
    if (!p.button.isConnected) {
      pending.current = null;
      p.fallback()?.focus();
    } else if (latest.current !== p.endedAt) {
      pending.current = null;
      if (document.activeElement === null || document.activeElement === document.body) p.button.focus();
    }
  });

  return useMemo(() => ({ begin, end }), [begin, end]);
}
