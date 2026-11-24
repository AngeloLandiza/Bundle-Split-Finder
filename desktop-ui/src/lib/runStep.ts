// How the Preferences window asks the main window to open the welcome sheet at "Let it run by itself". The two are
// separate pages of the same origin, so a localStorage write in one arrives as a `storage` event in the other (the way
// lib/appearance.ts carries the look across windows). Storage that cannot be used is no reason to throw: the button
// then does nothing.

export const RUN_STEP_KEY = 'splitFinder.openRunStep';

/** From the Preferences window: ask the main window to open the sheet. */
export function askMainForRunStep(storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(RUN_STEP_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** Whether a storage event is that request. */
export function isRunStepRequest(e: { key: string | null; newValue: string | null }): boolean {
  return e.key === RUN_STEP_KEY && e.newValue !== null;
}

/** In the main window: call `open` whenever the Preferences window asks. Returns the unsubscribe. */
export function onRunStepRequest(open: () => void, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const handler = (e: StorageEvent) => {
    if (isRunStepRequest(e)) open();
  };
  target.addEventListener('storage', handler as EventListener);
  return () => target.removeEventListener('storage', handler as EventListener);
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
