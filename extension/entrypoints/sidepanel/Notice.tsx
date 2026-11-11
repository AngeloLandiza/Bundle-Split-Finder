import { useEffect, useRef, useState } from 'react';
import { NETWORK_ERROR_PREFIX } from '../../../core/src/serpapi/client';
import type { AppState } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { hourlyBlockTitle } from './hourlyBlock';
import './Notice.css';

const OFFLINE = 'SerpApi could not be reached. Check the connection, then retry.';

/** Every sentence this notice can show goes through here, so a network failure always reads the same. */
export function sentenceFor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  return raw.startsWith(NETWORK_ERROR_PREFIX) ? OFFLINE : raw;
}

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
  const textRef = useRef<HTMLParagraphElement>(null);
  const clicked = useRef(false);

  const key = stateKey(state);
  const own = refused !== null && refused.key === key ? refused.text : null;
  const sentence = sentenceFor(own) ?? noticeSentence(state, error);

  const n = state.settings.searchesPerScan;
  const canRetry = state.hasKey && !state.scanRunning;
  const blocked = hourlyBlockTitle(state, now());

  // The button unmounts when its scan starts; keyboard focus goes to the sentence rather than to nowhere.
  useEffect(() => {
    if (!canRetry && clicked.current) {
      clicked.current = false;
      textRef.current?.focus();
    }
  }, [canRetry]);

  if (sentence === null) return null;

  const retry = () => {
    if (busy) return;
    setBusy(true);
    api
      .send({ type: 'scanNow' })
      .then((reply) => {
        clicked.current = reply.ok;
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
      <p className="notice-text" role="alert" tabIndex={-1} ref={textRef}>
        {sentence}
      </p>
      {canRetry ? (
        <button type="button" className="btn btn-secondary" disabled={busy || blocked !== undefined} title={blocked} onClick={retry}>
          Retry · up to {n} {n === 1 ? 'search' : 'searches'}
        </button>
      ) : null}
    </section>
  );
}
