import { useId, useRef, useState } from 'react';
import type { BundleRow } from '@core/scan/types';
import type { WorkerApi } from '../../lib/pageClient';
import { sentenceFor } from '../../lib/sentences';
import { waitingParts } from './dealsModel';
import { useQuote } from './useQuote';

const searches = (n: number): string => `${n} ${n === 1 ? 'search' : 'searches'}`;
const count = (n: number): string => `${n} ${n === 1 ? 'part' : 'parts'}`;

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
  /** The parts to look up, when they are not the row's own waiting parts: one way to sell's items. Names them "N items". */
  items?: { brand: string; model: string }[];
  /** An id that names what this button is for: two buttons of one name are told apart by it. */
  describedBy?: string;
  /** True in Ways to sell: a refusal is its own full-width line under the button, as in a Deals row, not squeezed beside it. */
  stacked?: boolean;
}

/**
 * The Look up control of a bundle with parts waiting for an Amazon lookup. The price comes from the worker
 * before the click and is asked for again whenever a scan starts or ends, a paid action finishes, the parts
 * change or a new report comes (useQuote). A refused quote disables the button and says why.
 */
export function LookUp({ row, report, api, scanRunning, version, busy, onRun, inRow = false, items, describedBy, stacked = false }: LookUpProps) {
  // A failed run's sentence is kept apart from the quote, so a later quote cannot wipe it. It belongs to the parts it was for.
  const [runError, setRunError] = useState<{ partKey: string; text: string } | null>(null);
  // True from the press until the request ends: this button says so.
  const [running, setRunning] = useState(false);
  const parts = items ?? waitingParts(row);
  // The row object changes on every report refresh; the quote only when the waiting parts do.
  const partKey = parts.map((p) => p.model).join(',');
  const { fresh, last, problem } = useQuote(api, { kind: 'lookUp', parts }, `${row.brand}|${partKey}`, scanRunning, version, report);

  // The last quoted count stays on the label while the next quote is asked for, so the price never disappears.
  const shown = last ? last.searches : null;
  const refusalId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refusal = scanRunning ? SCAN_RUNNING : ((runError?.partKey === partKey ? runError.text : null) ?? fresh?.refusal ?? problem);
  // aria-disabled, not disabled: focus stays on the button while it is busy or refused.
  const blocked = busy || !fresh || fresh.refusal !== null;
  const run = () => {
    if (blocked) return;
    setRunError(null);
    setRunning(true);
    void onRun(parts, buttonRef.current).then((error) => {
      setRunning(false);
      // Said in words, never as the client's raw text.
      setRunError(error ? { partKey, text: sentenceFor(error, 'try again') ?? error } : null);
    });
  };

  const cost = shown === null ? `at most ${searches(parts.length)}` : shown === 0 ? 'no search' : searches(shown);
  // Ruling 72: above the per-scan limit a press looks up only what fits, and the label says how many of the parts.
  // A quote taken for other parts (kept while the next one is asked for) can leave none: then the plain label.
  const left = last?.leftWaiting ?? 0;
  const fits = shown !== null && shown > 0 && left > 0 && left < parts.length ? parts.length - left : null;
  // A way to sell's button says how many parts: "Look up 8 parts · 8 searches"; above the limit any Look up does:
  // "Look up 5 of 8 parts · 5 searches". Then its name starts with that visible text.
  const partsLabel = fits !== null ? `${fits} of ${count(parts.length)}` : items ? count(items.length) : null;
  const costLabel = shown === 0 ? '· no search' : `${partsLabel ? '· ' : ''}${cost}`;
  // The name starts with the visible label (WCAG 2.5.3) and then says what is looked up.
  const visible = `Look up${partsLabel ? ` ${partsLabel}` : ''} ${costLabel}`;
  const what = fits !== null ? `for ${row.model}` : parts.length === 1 ? parts[0]!.model : `${parts.length} parts of ${row.model}`;

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
        aria-label={running || items ? undefined : `${visible}, ${what}`}
        aria-describedby={[describedBy, refusal ? refusalId : undefined].filter(Boolean).join(' ') || undefined}
        aria-disabled={blocked ? 'true' : undefined}
        onClick={run}
      >
        {running ? (
          'Looking up…'
        ) : (
          <>
            Look up{partsLabel ? ` ${partsLabel}` : ''} <span className="deal-lookup-cost">{costLabel}</span>
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
  if (stacked) {
    return (
      <div className="deal-lookup deal-lookup-stacked">
        {button}
        {refusalText}
      </div>
    );
  }
  return (
    <div className="deal-lookup">
      {refusalText}
      {button}
    </div>
  );
}
