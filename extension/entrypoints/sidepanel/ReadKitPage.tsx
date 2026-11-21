// Reads one unread kit's Home Depot page. The page is the only source of what is inside the kit.
// The button spends no search. A price is not copied off a link, and the kit is not priced as one part.

import { useEffect, useId, useRef, useState } from 'react';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { KitNotRead } from './WaysToSell';

const SCAN_LATER = 'A scan is running. Read the page when it has finished.';
const PAID_LATER = 'A Look up or Verify is running. Read the page when it has finished.';
const ASK_LATER = 'Asking AI is running. Read the page when it has finished.';
const NO_ID = 'The next scan has to find this kit on Home Depot before its page can be read.';

export function UnreadKit({
  brand, model, itemId, known, api, scanRunning, busy, asking,
}: {
  brand: string;
  model: string;
  /** The item id a scan would read. Null when the kit has no Home Depot item id yet. */
  itemId: string | null;
  /** False on a row built before kit pages could be read from here: the sentence stays, and no button is invented. */
  known: boolean;
  api: WorkerApi;
  scanRunning: boolean;
  busy: boolean;
  asking: boolean;
}) {
  const sentenceId = useId();
  return (
    <div className="detail-kit-unread">
      <p className="detail-estimate" id={sentenceId}>
        <KitNotRead model={model} />
      </p>
      {known && itemId ? (
        <ReadKitButton brand={brand} model={model} api={api} scanRunning={scanRunning} busy={busy} asking={asking} describedBy={sentenceId} />
      ) : null}
      {known && !itemId ? <p className="detail-estimate">{NO_ID}</p> : null}
    </div>
  );
}

function ReadKitButton({
  brand, model, api, scanRunning, busy, asking, describedBy,
}: {
  brand: string;
  model: string;
  api: WorkerApi;
  scanRunning: boolean;
  busy: boolean;
  asking: boolean;
  describedBy: string;
}) {
  const noteId = useId();
  const live = useRef(true);
  const lock = useRef(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => {
    live.current = false;
  }, []);

  const why = scanRunning ? SCAN_LATER : busy ? PAID_LATER : asking ? ASK_LATER : null;
  const blocked = why !== null || reading;

  const read = () => {
    if (lock.current || why !== null) return;
    lock.current = true;
    setReading(true);
    setError(null);
    api
      .send({ type: 'readKitPage', brand, model })
      .then((reply) => {
        if (live.current && !reply.ok) setError(reply.error);
      })
      .catch(() => {
        if (live.current) setError(UNREACHABLE);
      })
      .finally(() => {
        lock.current = false;
        if (live.current) setReading(false);
      });
  };

  return (
    <>
      <button
        type="button"
        className="detail-btn"
        disabled={blocked}
        aria-describedby={why ? `${describedBy} ${noteId}` : describedBy}
        onClick={read}
      >
        {reading ? 'Reading ' : 'Read '}
        <span className="figure">{model}</span>
        {reading ? ' page…' : ' page'}
      </button>
      {why ? (
        <p className="detail-estimate" id={noteId}>
          {why}
        </p>
      ) : null}
      {error ? (
        <p className="detail-refusal" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
