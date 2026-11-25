// How screens read the agent: one app context (state, online, events) and a small resource hook
// that keeps the last data on screen while it reloads (design.md, Loading).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Route } from '../lib/route';
import { api } from './client';
import { ApiError, type AgentEvent, type AppState, type PendingPairRequest } from './types';

export interface AppContextValue {
  state: AppState | null;
  /** False when the agent cannot be reached. */
  online: boolean;
  /** One sentence for the offline band. */
  offlineSentence: string | null;
  refreshState: () => void;
  navigate: (route: Route) => void;
  /** Subscribe to one kind of agent event. */
  on: (type: AgentEvent['type'], fn: (e: AgentEvent) => void) => () => void;
  /** Chrome's pairing requests waiting for the owner (design.md: a calm notice on every screen). */
  pairing: PairingValue;
}

export interface PairingValue {
  requests: PendingPairRequest[];
  /** The request being answered, or null. */
  busyId: string | null;
  /** One sentence when answering failed, or null. */
  error: string | null;
  decide: (requestId: string, allow: boolean) => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

/** What the profit figures leave out while sales tax or inbound shipping is unanswered ("before sales tax and inbound shipping"), or null. */
export function useProfitNote(): string | null {
  return useContext(AppContext)?.state?.profitNote ?? null;
}

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp outside AppContext');
  return v;
}

export type Resource<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: ApiError };

const asApiError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError('server', 'Something went wrong. Try again.'));

/**
 * Loads once, reloads on the given agent events, and keeps the last data while reloading so the
 * screen never blanks. `reload` is the Retry.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[], reloadOn: AgentEvent['type'][] = []): [Resource<T>, () => void] {
  const { on } = useApp();
  const [res, setRes] = useState<Resource<T>>({ status: 'loading', data: null, error: null });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    const n = ++seq.current;
    loadRef
      .current()
      .then((data) => {
        if (n === seq.current) setRes({ status: 'ready', data, error: null });
      })
      .catch((e: unknown) => {
        if (n === seq.current) setRes((cur) => ({ status: 'error', data: cur.data, error: asApiError(e) }));
      });
  }, []);

  useEffect(() => {
    setRes({ status: 'loading', data: null, error: null });
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const events = reloadOn.join(',');
  useEffect(() => {
    if (!events) return;
    const offs = events.split(',').map((t) => on(t as AgentEvent['type'], () => reload()));
    return () => offs.forEach((off) => off());
  }, [events, on, reload]);

  return [res, reload];
}

/** Runs one action with its own busy flag and error sentence. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): { run: (...args: A) => Promise<boolean>; busy: boolean; error: string | null; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      setError(null);
      try {
        await fn(...args);
        return true;
      } catch (e) {
        setError(asApiError(e).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn],
  );
  return { run, busy, error, clear: () => setError(null) };
}

export { api };
