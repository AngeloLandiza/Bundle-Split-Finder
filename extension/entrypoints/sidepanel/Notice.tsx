import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../lib/messages';
import { sentenceFor } from '../../lib/sentences';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { hourlyBlockTitle } from './hourlyBlock';
import './Notice.css';

/** The one sentence to show, in priority: a refused action, the worker's problem, then the last scan's error. */
export function noticeSentence(state: AppState, error: string | null): string | null {
  const job = state.lastJob;
  const stoppedBadly = job?.status === 'stopped' && (job.stopReason === 'error' || job.stopReason === 'rate_limited');
  return sentenceFor(error) ?? sentenceFor(state.problem) ?? sentenceFor(stoppedBadly ? job.stopMessage : null);
}

/** A refused Retry's sentence belongs to the state it was refused in; any change below ends it. */
const stateKey = (s: AppState) => `${s.scanRunning}|${s.problem ?? ''}|${s.lastJob?.id ?? ''}`;

/** A failed scan or an unreachable SerpApi, in one sentence with a Retry that shows its cost. Limit stops are not shown here. */
export function Notice({ state, api, error, now = Date.now }: { state: AppState; api: WorkerApi; error: string | null; now?: () => number }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ text: string; key: string } | null>(null);
  const clicked = useRef(false);

  const key = stateKey(state);
  const own = refused !== null && refused.key === key ? refused.text : null;
  const sentence = sentenceFor(own) ?? noticeSentence(state, error);

  const n = state.settings.searchesPerScan;
  const canRetry = state.hasKey && !state.scanRunning;
  const blocked = hourlyBlockTitle(state, now());

  // Retry unmounts when its scan starts, and the notice may go with it. Focus moves to the header's scan
  // control, which stays and now reads Stop.
  const running = state.scanRunning;
  useEffect(() => {
    if (running && clicked.current) {
      clicked.current = false;
      document.getElementById('scan-control')?.focus();
    }
  }, [running]);

  if (sentence === null) return null;

  const retry = () => {
    if (busy) return;
    setBusy(true);
    clicked.current = true;
    api
      .send({ type: 'scanNow' })
      .then((reply) => {
        // The scan may start before this reply is handled; the flag was already consumed then.
        if (!reply.ok) clicked.current = false;
        setRefused(reply.ok ? null : { text: reply.error, key });
      })
      .catch(() => {
        clicked.current = false;
        setRefused({ text: UNREACHABLE, key });
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="notice" aria-label="Problem">
      <p className="notice-text" role="alert">
        {sentence}
      </p>
      {canRetry && blocked !== undefined ? <p className="notice-text">{blocked}</p> : null}
      {canRetry ? (
        <button type="button" className="btn btn-secondary notice-retry" disabled={busy || blocked !== undefined} title={blocked} onClick={retry}>
          Retry <span className="notice-cost">up to {n} {n === 1 ? 'search' : 'searches'}</span>
        </button>
      ) : null}
    </section>
  );
}
