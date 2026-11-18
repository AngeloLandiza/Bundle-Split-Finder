// The one door between the extension's pages (settings, side panel) and the rest of the extension.
// The page only ever sends the messages in lib/messages.ts; the service worker answers them.

import { browser } from 'wxt/browser';
import { useCallback, useEffect, useState } from 'react';
import type { ExtensionSettings } from '@core/settings';
import type { AppState, Reply, Request, ShowThisPage, StateChanged } from './messages';

export const UNREACHABLE = 'Could not reach the extension. Reload this page and try again.';

/** The tab the panel's window shows. Null url: Chrome did not say. */
export interface ActiveTab {
  id: number;
  url: string | null;
}

/** The browser's tabs, as the This page tab follows them. Behind the seam so tests use fakes. */
export interface PanelTabs {
  /** The active tab of this panel's window, or null when there is none. */
  active(): Promise<ActiveTab | null>;
  /** Calls the listener when the active tab changes or a tab's page loads or navigates. Returns a function that stops listening. */
  onChanged(listener: () => void): () => void;
  /** Calls the listener with the tab id when the chip opened the panel on This page. Returns a function that stops listening. */
  onShowThisPage(listener: (tabId: number) => void): () => void;
}

export interface WorkerApi {
  send<T>(request: Request): Promise<Reply<T>>;
  /** Calls the listener with each new AppState. Returns a function that stops listening. */
  onStateChanged(listener: (state: AppState) => void): () => void;
  /** Saves text to the owner's computer as a file. */
  download(filename: string, text: string, mimeType: string): void;
  /** Absent in a page with no tabs to follow: This page then shows no page. */
  tabs?: PanelTabs;
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

export const realTabs: PanelTabs = {
  async active() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab && typeof tab.id === 'number' ? { id: tab.id, url: tab.url ?? null } : null;
  },
  onChanged(listener) {
    const updated = (_id: number, change: { url?: string; status?: string }) => {
      if (change.url !== undefined || change.status === 'complete') listener();
    };
    browser.tabs.onActivated.addListener(listener);
    browser.tabs.onUpdated.addListener(updated);
    return () => {
      browser.tabs.onActivated.removeListener(listener);
      browser.tabs.onUpdated.removeListener(updated);
    };
  },
  onShowThisPage(listener) {
    const handler = (message: unknown) => {
      const m = message as Partial<ShowThisPage> | null;
      if (m && m.type === 'showThisPage' && typeof m.tabId === 'number') listener(m.tabId);
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  },
};

export const realWorker: WorkerApi = { send, onStateChanged, download, tabs: realTabs };

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
