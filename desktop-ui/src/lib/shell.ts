// What the page asks of the macOS shell (src-tauri): opening the Preferences window, fitting its height, the
// app's version and data folder. Inside a plain browser (`npm run ui:mock`) there is no shell, and every call
// says so by returning null or doing the nearest thing a browser can.

import { DEFAULT_TAB, prefsHash, type PrefTab } from './prefs';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  }
}

export const inShell = (): boolean => typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

export interface AppInfo {
  version: string;
  dataDir: string | null;
  port: number;
}

/** Calls a shell command; rejects with its sentence. Only inside the app. */
export function invokeShell<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;
  if (!t) return Promise.reject(new Error('This works only inside the Split Finder app.'));
  return t.invoke(cmd, args) as Promise<T>;
}

/** Opens the Preferences window on a tab (Cmd+, does the same from the menu). In a browser: a small window. */
export function openPreferences(tab: PrefTab = DEFAULT_TAB): void {
  if (inShell()) {
    void invokeShell('open_preferences', { tab }).catch(() => {
      // The shell says why in the main window; there is nothing more to do here.
    });
    return;
  }
  window.open(`${window.location.pathname}${window.location.search}${prefsHash(tab)}`, 'split-finder-preferences', 'width=720,height=720');
}
