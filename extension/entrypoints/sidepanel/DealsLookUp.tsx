import { useEffect, useRef, useState } from 'react';
import type { BundleRow } from '@core/scan/types';
import type { Quote } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { waitingParts } from './dealsModel';

const searches = (n: number): string => `${n} ${n === 1 ? 'search' : 'searches'}`;

export const SCAN_RUNNING = 'A scan is running.';

interface LookUpProps {
  row: BundleRow;
  api: WorkerApi;
  scanRunning: boolean;
  /** Bumped by the tab each time a paid action finishes, so every quote is asked for again. */
  version: number;
  /** True while any Look up in the tab is in flight. */
  busy: boolean;
  /** Runs the paid action; resolves to the refusal sentence, or null when it ran. */
  onRun: (parts: { brand: string; model: string }[]) => Promise<string | null>;
}

/**
 * The Look up control of a bundle with parts waiting for an Amazon lookup. The price comes from the worker
 * before the click and is asked for again whenever a scan starts or ends, a paid action finishes, or the parts
 * change. A refused quote disables the button and says why.
 */
export function LookUp({ row, api, scanRunning, version, busy, onRun }: LookUpProps) {
  // The quote is kept with the version it answers, so a stale one can never enable the button.
  const [quote, setQuote] = useState<{ version: number; quote: Quote } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A failed run's sentence is kept apart from the quote, so a later quote cannot wipe it. It belongs to the parts it was for.
  const [runError, setRunError] = useState<{ partKey: string; text: string } | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const parts = waitingParts(row);
  // The row object changes on every report refresh; the quote only when the waiting parts do.
  const partKey = parts.map((p) => p.model).join(',');

  useEffect(() => {
    if (scanRunning) return;
    let live = true;
    apiRef.current
      .send<Quote>({ type: 'quote', action: { kind: 'lookUp', parts } })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) {
          setQuote({ version, quote: reply.data });
          setProblem(null);
        } else setProblem(reply.error);
      })
      .catch(() => live && setProblem(UNREACHABLE));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.brand, partKey, scanRunning, version]);

  const fresh = !scanRunning && quote !== null && quote.version === version ? quote.quote : null;
  const refusal = scanRunning ? SCAN_RUNNING : ((runError?.partKey === partKey ? runError.text : null) ?? fresh?.refusal ?? problem);
  const run = () => {
    if (busy || !fresh || fresh.refusal) return;
    setRunError(null);
    void onRun(parts).then((error) => setRunError(error ? { partKey, text: error } : null));
  };

  return (
    <div className="deal-lookup">
      {refusal ? <p className="deal-refusal">{refusal}</p> : null}
      <button type="button" className="deal-lookup-btn" disabled={busy || !fresh || fresh.refusal !== null} onClick={run}>
        Look up{' '}
        {fresh ? <span className="deal-lookup-cost">{searches(fresh.searches)}</span> : null}
      </button>
    </div>
  );
}
