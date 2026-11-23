// What the popover asks of the desktop shell (src-tauri/src/popover.rs `popover_do`): hide itself, open the main
// window at a screen, open Preferences, quit. In a plain browser (`npm run ui:mock`) there is no shell and these do nothing.

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: Invoke };
  }
}

export type PopoverAction = 'hide' | 'open' | 'preferences' | 'quit';

/** True when the shell took the request. */
export async function popoverDo(action: PopoverAction, route?: string): Promise<boolean> {
  const tauri = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;
  if (!tauri) return false;
  try {
    await tauri.invoke('popover_do', { action, route: route ?? null });
    return true;
  } catch {
    return false;
  }
}
