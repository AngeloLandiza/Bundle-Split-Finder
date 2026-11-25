import { useCallback, useRef, useState } from 'react';

/**
 * The agent's state, held so that an answer equal to the one on screen changes nothing. Every poll and every state
 * event brings a fresh object; setting it would render the whole window (and rebuild the context every screen reads)
 * for nothing. The returned setter compares by content and does not touch React when the content is the same.
 */
export function useKeptState<T>(): [T | null, (next: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  const held = useRef<{ value: T; json: string } | null>(null);
  const set = useCallback((next: T) => {
    const json = JSON.stringify(next);
    if (held.current !== null && held.current.json === json) return;
    held.current = { value: next, json };
    setValue(next);
  }, []);
  return [value, set];
}
