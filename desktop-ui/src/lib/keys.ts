// The keyboard map (docs/design.md, Desktop app > Keyboard). One pure function per scope turns a
// key press into an action, so the map is tested once and every screen reads the same keys.
//
// Rules: a letter or digit never acts while the owner types in a field; Enter never steals a press
// from a focused button or link (the browser already presses it); Cmd (macOS) or Ctrl (Windows)
// with 1-5 moves between screens from anywhere.

export type Screen = 'today' | 'deals' | 'review' | 'activity' | 'settings';
export const SCREENS: readonly Screen[] = ['today', 'deals', 'review', 'activity', 'settings'];

/** What has focus when the key is pressed. */
export type Target = 'text' | 'control' | 'choice' | 'none';

export interface KeyPress {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  target: Target;
}

export type GlobalAction = { type: 'go'; screen: Screen } | { type: 'find' };
export type ListAction = { type: 'next' } | { type: 'prev' } | { type: 'open' } | { type: 'close' };
export type ReviewAction = ListAction | { type: 'choose'; index: number } | { type: 'save' } | { type: 'ask' };

const plain = (p: KeyPress): boolean => !p.meta && !p.ctrl && !p.alt;

export function globalKey(p: KeyPress): GlobalAction | null {
  if ((p.meta || p.ctrl) && !p.alt && !p.shift && /^[1-5]$/.test(p.key)) {
    return { type: 'go', screen: SCREENS[Number(p.key) - 1] as Screen };
  }
  // The shell's menu also sends Cmd/Ctrl+F as the split-finder:find event; focusing twice is harmless.
  if ((p.meta || p.ctrl) && !p.alt && !p.shift && (p.key === 'f' || p.key === 'F')) return { type: 'find' };
  return null;
}

/** A table or list with a detail: J/K or arrows move, Enter opens, Escape closes. */
export function listKey(p: KeyPress): ListAction | null {
  if (p.key === 'Escape') return { type: 'close' };
  if (!plain(p) || p.target === 'text') return null;
  if (p.key === 'ArrowDown' || p.key === 'j' || p.key === 'J') return { type: 'next' };
  if (p.key === 'ArrowUp' || p.key === 'k' || p.key === 'K') return { type: 'prev' };
  if (p.key === 'Enter' && p.target !== 'control') return { type: 'open' };
  return null;
}

/**
 * Review: J/K move between questions, 1-9 pick a choice, Enter saves (or approves), A asks the AI.
 * Arrow keys are left to the radio group, which already moves its own selection with them.
 */
export function reviewKey(p: KeyPress): ReviewAction | null {
  if (p.key === 'Escape') return { type: 'close' };
  if (!plain(p) || p.target === 'text') return null;
  if (p.key === 'j' || p.key === 'J') return { type: 'next' };
  if (p.key === 'k' || p.key === 'K') return { type: 'prev' };
  if (/^[1-9]$/.test(p.key)) return { type: 'choose', index: Number(p.key) - 1 };
  if (p.key === 'Enter' && p.target !== 'control') return { type: 'save' };
  if (p.key === 'a' || p.key === 'A') return { type: 'ask' };
  return null;
}

/** Reads the focus target from a DOM event's target. */
export function targetOf(el: EventTarget | null): Target {
  if (!(el instanceof HTMLElement)) return 'none';
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return 'text';
  if (el instanceof HTMLInputElement) {
    return el.type === 'radio' || el.type === 'checkbox' ? 'choice' : 'text';
  }
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || el.getAttribute('role') === 'switch') return 'control';
  return 'none';
}

export function pressOf(e: KeyboardEvent): KeyPress {
  return { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, target: targetOf(e.target) };
}

/** The label a shortcut is shown with: ⌘1 on macOS, Ctrl+1 elsewhere. */
export function modLabel(key: string, mac: boolean): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}
