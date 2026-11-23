// The Preferences window's own link to the agent: the state, the event stream and Chrome's pairing requests, in the
// shapes the shared hooks (hooks.ts) read. The dashboard (App.tsx) holds the same for its window; this is the small
// part the Preferences window needs, with no screens, routes or inspector.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AppContextValue, type PairingValue } from './hooks';
import { ApiError, type AgentEvent, type AppState, type PendingPairRequest } from './types';

export function useAgentLink(): AppContextValue {
  const [state, setState] = useState<AppState | null>(null);
  const [online, setOnline] = useState(true);
  const [requests, setRequests] = useState<PendingPairRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listeners = useRef(new Map<AgentEvent['type'], Set<(e: AgentEvent) => void>>());

  const refreshState = useCallback(() => {
    api
      .state()
      .then((s) => {
        setState(s);
        setOnline(true);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.kind !== 'offline') return;
        setOnline(false);
      });
  }, []);

  const refreshPairing = useCallback(() => {
    api
      .pairRequests()
      .then((next) => setRequests((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next)))
      .catch(() => {
        // Offline or not allowed: the status line says so, and there is nothing to allow.
      });
  }, []);

  useEffect(() => {
    refreshState();
    refreshPairing();
    const off = api.subscribe(
      (e) => {
        if (e.type === 'state') {
          setState(e.state);
          setOnline(true);
          refreshPairing();
        }
        listeners.current.get(e.type)?.forEach((fn) => fn(e));
      },
      (status) => {
        if (status === 'live') setOnline(true);
        else refreshState();
      },
    );
    const poll = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refreshState();
      refreshPairing();
    }, 15_000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [refreshState, refreshPairing]);

  const on = useCallback<AppContextValue['on']>((type, fn) => {
    const set = listeners.current.get(type) ?? new Set();
    set.add(fn);
    listeners.current.set(type, set);
    return () => set.delete(fn);
  }, []);

  const pairing = useMemo<PairingValue>(
    () => ({
      requests,
      busyId,
      error,
      decide: async (requestId, allow) => {
        setBusyId(requestId);
        setError(null);
        try {
          await api.decidePairing(requestId, allow);
          setRequests((cur) => cur.filter((r) => r.requestId !== requestId));
          refreshState();
        } catch (e) {
          setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
          refreshPairing();
        } finally {
          setBusyId(null);
        }
      },
    }),
    [requests, busyId, error, refreshState, refreshPairing],
  );

  return useMemo(
    // There is no dashboard here to navigate: the Preferences window has tabs, which it switches itself.
    () => ({ state, online, offlineSentence: null, refreshState, navigate: () => {}, on, pairing }),
    [state, online, refreshState, on, pairing],
  );
}
