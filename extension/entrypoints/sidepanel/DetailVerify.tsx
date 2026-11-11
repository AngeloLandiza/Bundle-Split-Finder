import { useId, useState } from 'react';
import type { WorkerApi } from '../../lib/pageClient';
import { SCAN_RUNNING } from './DealsLookUp';
import { useQuote } from './useQuote';

interface VerifyProps {
  brand: string;
  model: string;
  asin: string;
  api: WorkerApi;
  scanRunning: boolean;
  /** Bumped by Detail each time a paid action finishes, so every quote is asked for again. */
  version: number;
  /** True while any paid action on this screen is in flight. */
  busy: boolean;
  /** Runs the paid action; resolves to the refusal sentence, or null when it ran. */
  onRun: () => Promise<string | null>;
}

/** Verify for a title-only match. The price is asked for before the click; a refusal disables the button and says why. */
export function Verify({ brand, model, asin, api, scanRunning, version, busy, onRun }: VerifyProps) {
  const [runError, setRunError] = useState<string | null>(null);
  const refusalId = useId();
  const { fresh, problem } = useQuote(api, { kind: 'verify', brand, model, asin }, `${brand}|${model}|${asin}`, scanRunning, version);

  const refusal = scanRunning ? SCAN_RUNNING : (runError ?? fresh?.refusal ?? problem);
  const run = () => {
    if (busy || !fresh || fresh.refusal) return;
    setRunError(null);
    void onRun().then(setRunError);
  };

  return (
    <div className="detail-verify">
      <button
        type="button"
        className="detail-verify-btn"
        aria-describedby={refusal ? refusalId : undefined}
        disabled={busy || !fresh || fresh.refusal !== null}
        onClick={run}
      >
        Verify <span className="detail-verify-cost">· 1 search</span>
      </button>
      {refusal ? (
        <p className="detail-refusal" id={refusalId}>
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
