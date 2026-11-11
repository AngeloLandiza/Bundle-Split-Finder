import { useState } from 'react';
import type { AppState } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import './Notice.css';

// The client's sentence when the network call itself fails: "Network error reaching SerpApi: <detail>".
const OFFLINE_PREFIX = 'Network error reaching SerpApi';
const OFFLINE = 'SerpApi could not be reached. Check the connection, then retry.';

/** The one sentence to show, in priority: a refused action, the worker's problem, then the last scan's error. */
export function noticeSentence(state: AppState, error: string | null): string | null {
  const job = state.lastJob;
  const stoppedBadly = job?.status === 'stopped' && (job.stopReason === 'error' || job.stopReason === 'rate_limited');
  const raw = error ?? state.problem ?? (stoppedBadly ? job.stopMessage : null);
  if (raw === null || raw === '') return null;
  return raw.startsWith(OFFLINE_PREFIX) ? OFFLINE : raw;
}

/** A failed scan or an unreachable SerpApi, in one sentence with a Retry that shows its cost. Limit stops are not shown here. */
export function Notice({ state, api, error }: { state: AppState; api: WorkerApi; error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const sentence = retryError ?? noticeSentence(state, error);
  if (sentence === null) return null;

  const n = state.settings.searchesPerScan;
  const canRetry = state.hasKey && !state.scanRunning;
  const retry = () => {
    if (busy) return;
    setBusy(true);
    api
      .send({ type: 'scanNow' })
      .then((reply) => setRetryError(reply.ok ? null : reply.error))
      .catch(() => setRetryError(UNREACHABLE))
      .finally(() => setBusy(false));
  };

  return (
    <section className="notice" aria-label="Problem">
      <p className="notice-text" role="alert">
        {sentence}
      </p>
      {canRetry ? (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={retry}>
          Retry · up to {n} {n === 1 ? 'search' : 'searches'}
        </button>
      ) : null}
    </section>
  );
}
