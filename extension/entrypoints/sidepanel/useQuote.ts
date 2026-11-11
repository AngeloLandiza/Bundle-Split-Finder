import { useEffect, useRef, useState } from 'react';
import type { PaidAction, Quote } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';

/** How many times `value` has changed since the component mounted. */
function useChanges(value: unknown): number {
  const [seen, setSeen] = useState({ value, changes: 0 });
  if (Object.is(seen.value, value)) return seen.changes;
  const next = { value, changes: seen.changes + 1 };
  setSeen(next);
  return next.changes;
}

export interface Quoted {
  /** The quote for the action as it stands now; null until it has come, and always while a scan runs. */
  fresh: Quote | null;
  /** The last quote that came, fresh or not: its count stays on a label while the next one is asked for. */
  last: Quote | null;
  /** The sentence of the last quote that could not be had; null once one came. */
  problem: string | null;
}

/**
 * The worker's quote for a Verify or Look up. It is asked for again whenever `actionKey` (what the action is
 * for: the parts, the listing), `version` (bumped by the screen after its own paid action) or the scan period
 * changes; a scan's start and its end each begin a new period. Nothing is asked while a scan runs. A quote is
 * fresh only under the key, version and period it was taken under, so a quote from before a scan, another
 * paid action or other parts never enables a button.
 */
export function useQuote(api: WorkerApi, action: PaidAction, actionKey: string, scanRunning: boolean, version: number): Quoted {
  const period = useChanges(scanRunning);
  const key = `${actionKey}|${version}|${period}`;
  const [held, setHeld] = useState<{ key: string; quote: Quote } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (scanRunning) return;
    let live = true;
    apiRef.current
      .send<Quote>({ type: 'quote', action })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) {
          setHeld({ key, quote: reply.data });
          setProblem(null);
        } else setProblem(reply.error);
      })
      .catch(() => live && setProblem(UNREACHABLE));
    return () => {
      live = false;
    };
    // `action` is described by actionKey; the object itself is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scanRunning]);

  return { fresh: !scanRunning && held?.key === key ? held.quote : null, last: held?.quote ?? null, problem };
}
