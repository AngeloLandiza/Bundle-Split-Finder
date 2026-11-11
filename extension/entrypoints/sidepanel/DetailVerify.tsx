import { useEffect, useRef, useState } from 'react';
import type { Quote } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { SCAN_RUNNING } from './DealsLookUp';

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
  const [quote, setQuote] = useState<{ version: number; quote: Quote } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (scanRunning) return;
    let live = true;
    apiRef.current
      .send<Quote>({ type: 'quote', action: { kind: 'verify', brand, model, asin } })
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
  }, [brand, model, asin, scanRunning, version]);

  const fresh = !scanRunning && quote !== null && quote.version === version ? quote.quote : null;
  const refusal = scanRunning ? SCAN_RUNNING : (runError ?? fresh?.refusal ?? problem);
  const run = () => {
    if (busy || !fresh || fresh.refusal) return;
    setRunError(null);
    void onRun().then(setRunError);
  };

  return (
    <div className="detail-verify">
      <button type="button" className="detail-verify-btn" disabled={busy || !fresh || fresh.refusal !== null} onClick={run}>
        Verify{' '}
        {fresh ? (
          <span className="detail-verify-cost">
            {'· '}
            {fresh.searches} {fresh.searches === 1 ? 'search' : 'searches'}
          </span>
        ) : null}
      </button>
      {refusal ? <p className="detail-refusal">{refusal}</p> : null}
    </div>
  );
}
