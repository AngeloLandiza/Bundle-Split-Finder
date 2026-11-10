import { useCallback, useEffect, useState } from 'react';
import type { ExtensionSettings } from '@core/settings';
import type { AppState } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from './worker';

export interface AppStateHook {
  state: AppState | null;
  loading: boolean;
  /** Set when the worker could not be reached or refused. One plain sentence. */
  error: string | null;
  /** Resolves to an error sentence, or null when the settings were saved. */
  save(settings: ExtensionSettings): Promise<string | null>;
}

export function useAppState(api: WorkerApi): AppStateHook {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const stop = api.onStateChanged((s) => {
      if (live) setState(s);
    });
    api
      .send<AppState>({ type: 'getState' })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) setState((current) => current ?? reply.data);
        else setError(reply.error);
      })
      .catch(() => {
        if (live) setError(UNREACHABLE);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      stop();
    };
  }, [api]);

  const save = useCallback(
    async (settings: ExtensionSettings): Promise<string | null> => {
      try {
        const reply = await api.send<unknown>({ type: 'saveSettings', settings });
        return reply.ok ? null : reply.error;
      } catch {
        return UNREACHABLE;
      }
    },
    [api],
  );

  return { state, loading, error, save };
}
