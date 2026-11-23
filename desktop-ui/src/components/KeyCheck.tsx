import { useCallback, useEffect, useState } from 'react';
import { api, useApp } from '../api/hooks';
import type { KeyCheck, KeyName } from '../api/types';
import { checkedWords, keyCheckLine, type CheckedNow } from '../lib/keyCheck';
import { Glyph } from './Glyph';
import { Spinner } from './States';
import './KeyCheck.css';

/**
 * What a key's own service said: the answer to a Save, or to Check again. The agent also records its last verdict (`keyChecks`,
 * `keyProblems`), which is what shows when this window has no answer of its own.
 */
export function useKeyCheck(name: KeyName): {
  now: CheckedNow | null;
  /** A Check again is running. */
  rechecking: boolean;
  /** Takes the answer a Save gave. */
  adopt: (check: KeyCheck) => void;
  /** Forgets this window's answer (the key is being replaced or removed). */
  forget: () => void;
  recheck: () => void;
} {
  const { refreshState } = useApp();
  const [now, setNow] = useState<CheckedNow | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const adopt = useCallback((check: KeyCheck) => setNow({ check, at: Date.now() }), []);
  const forget = useCallback(() => setNow(null), []);
  const recheck = useCallback(() => {
    setRechecking(true);
    api
      .checkKey(name)
      .then((check) => {
        setNow({ check, at: Date.now() });
        refreshState();
      })
      .catch((e: unknown) => setNow({ check: { ok: false, kind: 'network', problem: e instanceof Error && e.message ? e.message : 'The app could not be reached. Try again in a moment.' }, at: Date.now() }))
      .finally(() => setRechecking(false));
  }, [name, refreshState]);
  return { now, rechecking, adopt, forget, recheck };
}

/** The minute hand: "Checked 2 min ago" is read against the clock, so it is redrawn every 30 seconds. */
function useClock(): number {
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAt(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return at;
}

/**
 * The result line under a saved key: a spinner and "Checking with eBay…" while it runs; "Works · 118 of 250 searches left" in
 * green; the service's own words in red with what to do; or, when the service could not be reached, one quiet sentence. "Check
 * again" asks the stored key again (no typing). Renders nothing for a key not saved and never checked.
 */
export function KeyCheckLine({ name, checking, now, onCheckAgain, canCheckAgain = true }: { name: KeyName; checking: boolean; now: CheckedNow | null; onCheckAgain: () => void; canCheckAgain?: boolean }) {
  const { state } = useApp();
  const clock = useClock();
  const line = keyCheckLine({ name, state, checking, now, at: clock });
  const saved = state?.keys[name] ?? false;
  if (line.tone === 'none' && !(saved && canCheckAgain)) return null;
  const again = saved && canCheckAgain && line.tone !== 'checking' ? (
    <button type="button" className="link-btn key-check-again" onClick={onCheckAgain}>
      Check again
    </button>
  ) : null;
  if (line.tone === 'none') return <p className="key-check key-check-none">{again}</p>;
  return (
    <p className={`key-check key-check-${line.tone}`} role={line.tone === 'rejected' ? 'alert' : 'status'} aria-live="polite">
      {line.tone === 'checking' ? <Spinner size={12} /> : line.tone === 'works' ? <Glyph name="check" size={12} /> : <Glyph name="warning" size={12} />}
      <span className="key-check-text">
        {line.text}
        {'when' in line && line.when ? <span className="key-check-when"> · {checkedWords(line.when)}</span> : null}
      </span>
      {again}
    </p>
  );
}
