// The page viewer's toolbar, pure parts: the state the shell sends (src-tauri/src/viewer/model.rs BarState, field for
// field) and which key does what while the toolbar has the focus on Windows (a Mac's keys are View menu items).

export type ViewerScreen = { kind: 'page' } | { kind: 'failed'; url: string } | { kind: 'signIn'; url: string };

export interface BarState {
  url: string | null;
  loading: boolean;
  /** 0 to 1 while loading on a Mac; null where the platform cannot tell (Windows). */
  progress: number | null;
  canBack: boolean;
  canForward: boolean;
  screen: ViewerScreen;
  /** The deal's title, when opened from a deal. */
  title: string | null;
  /** "Amazon · PCG002", or the site's name, or null. */
  label: string | null;
  /** How many of the deal's pages the page pop-up lists (0: no pop-up). */
  pages: number;
  current: number | null;
}

export type BarAction = 'close' | 'reload' | 'back' | 'forward' | 'copy';

/** Ctrl+W or Esc close, Ctrl+R or F5 reload, Ctrl+[ and Ctrl+] (and Alt+arrows) go back and forward, Ctrl+Shift+C copies. */
export function barKey(k: { key: string; mod: boolean; shift: boolean; alt: boolean }): BarAction | null {
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  if (key === 'Escape' && !k.mod && !k.alt) return 'close';
  if (key === 'F5' && !k.mod) return 'reload';
  if (k.alt && !k.mod && key === 'ArrowLeft') return 'back';
  if (k.alt && !k.mod && key === 'ArrowRight') return 'forward';
  if (!k.mod || k.alt) return null;
  if (key === 'w' && !k.shift) return 'close';
  if (key === 'r' && !k.shift) return 'reload';
  if (key === '[' && !k.shift) return 'back';
  if (key === ']' && !k.shift) return 'forward';
  if (key === 'c' && k.shift) return 'copy';
  return null;
}
