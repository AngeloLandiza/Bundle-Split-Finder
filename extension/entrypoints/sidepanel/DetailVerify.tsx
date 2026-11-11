import { useId, useRef, useState } from 'react';
import type { WorkerApi } from '../../lib/pageClient';
import { sentenceFor } from '../../lib/sentences';
import { SCAN_RUNNING } from './DealsLookUp';
import { useQuote } from './useQuote';

interface VerifyProps {
  brand: string;
  model: string;
  asin: string;
  /** The report on screen. Only its identity is read: a new one asks for the price again. */
  report: unknown;
  api: WorkerApi;
  scanRunning: boolean;
  /** Bumped by Detail each time a paid action finishes, so every quote is asked for again. */
  version: number;
  /** True while any paid action on this screen is in flight. */
  busy: boolean;
  /** Runs the paid action; resolves to the refusal sentence, or null when it ran. */
  onRun: (button: HTMLButtonElement | null) => Promise<string | null>;
}

/** Verify for a title-only match. The price is asked for before the click; a refusal disables the button and says why. */
export function Verify({ brand, model, asin, report, api, scanRunning, version, busy, onRun }: VerifyProps) {
  const [runError, setRunError] = useState<string | null>(null);
  // True from the press until the request ends: this button says so.
  const [running, setRunning] = useState(false);
  const refusalId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { fresh, problem } = useQuote(api, { kind: 'verify', brand, model, asin }, `${brand}|${model}|${asin}`, scanRunning, version, report);

  const refusal = scanRunning ? SCAN_RUNNING : (runError ?? fresh?.refusal ?? problem);
  // aria-disabled, not disabled: focus stays on the button while it is busy or refused.
  const blocked = busy || !fresh || fresh.refusal !== null;
  const run = () => {
    if (blocked) return;
    setRunError(null);
    setRunning(true);
    void onRun(buttonRef.current).then((error) => {
      setRunning(false);
      // Said in words, never as the client's raw text.
      setRunError(error === null ? null : (sentenceFor(error, 'try again') ?? error));
    });
  };

  return (
    <div className="detail-verify">
      <button
        ref={buttonRef}
        type="button"
        className="detail-verify-btn"
        aria-describedby={refusal ? refusalId : undefined}
        aria-disabled={blocked ? 'true' : undefined}
        onClick={run}
      >
        {running ? (
          'Verifying…'
        ) : (
          <>
            Verify <span className="detail-verify-cost">· 1 search</span>
          </>
        )}
      </button>
      {refusal ? (
        <p className="detail-refusal" id={refusalId}>
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
