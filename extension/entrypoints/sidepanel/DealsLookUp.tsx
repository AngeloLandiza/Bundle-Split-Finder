import { useEffect, useState } from 'react';
import type { BundleRow } from '@core/scan/types';
import type { Quote } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { waitingParts } from './dealsModel';

const searches = (n: number): string => `${n} ${n === 1 ? 'search' : 'searches'}`;

/**
 * The Look up control of a bundle with parts waiting for an Amazon lookup. The price comes from the worker
 * before the click, a refused quote disables the button and says why, and only one request is in flight.
 */
export function LookUp({ row, api }: { row: BundleRow; api: WorkerApi }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const parts = waitingParts(row);
  // The row object changes on every report refresh; the quote only when the waiting parts do.
  const partKey = parts.map((p) => p.model).join(',');

  useEffect(() => {
    let live = true;
    setQuote(null);
    api
      .send<Quote>({ type: 'quote', action: { kind: 'lookUp', parts } })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) setQuote(reply.data);
        else setProblem(reply.error);
      })
      .catch(() => live && setProblem(UNREACHABLE));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, row.brand, partKey]);

  const refusal = quote?.refusal ?? problem;
  const run = () => {
    if (sending || !quote || quote.refusal) return;
    setSending(true);
    setProblem(null);
    api
      .send({ type: 'runPaid', action: { kind: 'lookUp', parts } })
      .then((reply) => {
        if (!reply.ok) setProblem(reply.error);
      })
      .catch(() => setProblem(UNREACHABLE))
      .finally(() => setSending(false));
  };

  return (
    <div className="deal-lookup">
      {refusal ? <p className="deal-refusal">{refusal}</p> : null}
      <button type="button" className="deal-lookup-btn" disabled={sending || !quote || quote.refusal !== null} onClick={run}>
        Look up{' '}
        {quote ? <span className="deal-lookup-cost">· {searches(quote.searches)}</span> : null}
      </button>
    </div>
  );
}
