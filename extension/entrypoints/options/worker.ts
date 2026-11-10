// The one door between the settings page and the rest of the extension.
// The page only ever sends the messages in lib/messages.ts; the service worker answers them.

import { browser } from 'wxt/browser';
import type { AppState, Reply, Request, StateChanged } from '../../lib/messages';

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
