// The one door between the extension's pages (settings, side panel) and the rest of the extension.
// The page only ever sends the messages in lib/messages.ts; the service worker answers them.

import { browser } from 'wxt/browser';
import { useCallback, useEffect, useState } from 'react';
import type { ExtensionSettings } from '@core/settings';
import type { AppState, Reply, Request, StateChanged } from './messages';

export const UNREACHABLE = 'Could not reach the extension. Reload this page and try again.';

export interface WorkerApi {
  send<T>(request: Request): Promise<Reply<T>>;
  /** Calls the listener with each new AppState. Returns a function that stops listening. */
  onStateChanged(listener: (state: AppState) => void): () => void;
  /** Saves text to the owner's computer as a file. */
  download(filename: string, text: string, mimeType: string): void;
}

export function send<T>(request: Request): Promise<Reply<T>> {
  return browser.runtime.sendMessage(request) as Promise<Reply<T>>;
}

export function onStateChanged(listener: (state: AppState) => void): () => void {
  const handler = (message: unknown) => {
    const m = message as Partial<StateChanged> | null;
    if (m && m.type === 'stateChanged' && m.state) listener(m.state);
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
}

export function download(filename: string, text: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const realWorker: WorkerApi = { send, onStateChanged, download };


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
