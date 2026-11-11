import { useId, useRef, useState } from 'react';
import type { BundleRow } from '@core/scan/types';
import type { WorkerApi } from '../../lib/pageClient';
import { sentenceFor } from '../../lib/sentences';
import { waitingParts } from './dealsModel';
import { useQuote } from './useQuote';

const searches = (n: number): string => `${n} ${n === 1 ? 'search' : 'searches'}`;

export const SCAN_RUNNING = 'A scan is running.';

interface LookUpProps {
  row: BundleRow;
  /** The report the row is from. Only its identity is read: a new one asks for the price again. */
  report: unknown;
  api: WorkerApi;
  scanRunning: boolean;
  /** Bumped by the tab each time a paid action finishes, so every quote is asked for again. */
  version: number;
  /** True while any Look up in the tab is in flight. */
  busy: boolean;
  /** Runs the paid action; resolves to the refusal sentence, or null when it ran. */
  onRun: (parts: { brand: string; model: string }[], button: HTMLButtonElement | null) => Promise<string | null>;
  /** True in a Deals row: the button and its refusal are the row's own grid cells, not a wrapper of their own. */
  inRow?: boolean;
}

/**
 * The Look up control of a bundle with parts waiting for an Amazon lookup. The price comes from the worker
 * before the click and is asked for again whenever a scan starts or ends, a paid action finishes, the parts
 * change or a new report comes (useQuote). A refused quote disables the button and says why.
 */
export function LookUp({ row, report, api, scanRunning, version, busy, onRun, inRow = false }: LookUpProps) {
  // A failed run's sentence is kept apart from the quote, so a later quote cannot wipe it. It belongs to the parts it was for.
  const [runError, setRunError] = useState<{ partKey: string; text: string } | null>(null);
  // True from the press until the request ends: this button says so.
  const [running, setRunning] = useState(false);
  const parts = waitingParts(row);
  // The row object changes on every report refresh; the quote only when the waiting parts do.
  const partKey = parts.map((p) => p.model).join(',');
  const { fresh, last, problem } = useQuote(api, { kind: 'lookUp', parts }, `${row.brand}|${partKey}`, scanRunning, version, report);

  // The last quoted count stays on the label while the next quote is asked for, so the price never disappears.
  const shown = last ? last.searches : null;
  const refusalId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refusal = scanRunning ? SCAN_RUNNING : ((runError?.partKey === partKey ? runError.text : null) ?? fresh?.refusal ?? problem);
  const run = () => {
    if (busy || !fresh || fresh.refusal) return;
    setRunError(null);
    setRunning(true);
    void onRun(parts, buttonRef.current).then((error) => {
      setRunning(false);
      // Said in words, never as the client's raw text.
      setRunError(error ? { partKey, text: sentenceFor(error, 'try again') ?? error } : null);
    });
  };

  const cost = shown === null ? `at most ${searches(parts.length)}` : shown === 0 ? 'no search' : searches(shown);
  // The name says what is looked up; the visible label stays short.
  const what = parts.length === 1 ? parts[0]!.model : `${parts.length} parts of ${row.model}`;

  const refusalText = refusal ? (
    <p className="deal-refusal" id={refusalId}>
      {refusal}
    </p>
  ) : null;
  const button = (
      <button
        ref={buttonRef}
        type="button"
        className="deal-lookup-btn"
        aria-label={running ? undefined : `Look up ${what}, ${cost}`}
        aria-describedby={refusal ? refusalId : undefined}
        disabled={busy || !fresh || fresh.refusal !== null}
        onClick={run}
      >
        {running ? (
          'Looking up…'
        ) : (
          <>
            Look up <span className="deal-lookup-cost">{shown === 0 ? '· no search' : cost}</span>
          </>
        )}
      </button>
  );
  if (inRow) {
    return (
      <>
        {button}
        {refusalText}
      </>
    );
  }
  return (
    <div className="deal-lookup">
      {refusalText}
      {button}
    </div>
  );
}
