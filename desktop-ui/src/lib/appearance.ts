// How the window looks: light, dark or the system's; the system accent or a chosen one; regular or
// compact rows. Kept in this Mac's browser storage (a per-viewer convenience, not agent state) and
// applied as data attributes on <html> that base.css reads. D2's Preferences window writes the same.

export type Appearance = 'system' | 'light' | 'dark';
export type Accent = 'system' | 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'graphite';
export type Density = 'regular' | 'compact';

export interface Look {
  appearance: Appearance;
  accent: Accent;
  density: Density;
}

export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];
export const ACCENTS: readonly Accent[] = ['system', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite'];
export const DENSITIES: readonly Density[] = ['regular', 'compact'];

export const DEFAULT_LOOK: Look = { appearance: 'system', accent: 'system', density: 'regular' };

const KEY = 'splitFinder.look';

/** A stored look, with anything unknown or missing back at its default. */
export function parseLook(raw: string | null): Look {
  let v: Partial<Record<keyof Look, unknown>> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') v = parsed as typeof v;
  } catch {
    // default below
  }
  const pick = <T extends string>(all: readonly T[], x: unknown, d: T): T => (all.find((a) => a === x) ?? d);
  return {
    appearance: pick(APPEARANCES, v.appearance, DEFAULT_LOOK.appearance),
    accent: pick(ACCENTS, v.accent, DEFAULT_LOOK.accent),
    density: pick(DENSITIES, v.density, DEFAULT_LOOK.density),
  };
}

export function readLook(): Look {
  try {
    return parseLook(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

export function saveLook(look: Look): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    // this session only
  }
}

export function applyLook(look: Look, root: HTMLElement = document.documentElement): void {
  root.dataset.appearance = look.appearance;
  root.dataset.accent = look.accent;
  root.dataset.density = look.density;
}

/** "unified" inside the macOS shell (shell.rs init script): the sidebar is left clear for the window's material. */
export function shellChrome(): 'unified' | 'standard' {
  const shell = (window as { __SPLIT_FINDER_SHELL__?: { chrome?: string } }).__SPLIT_FINDER_SHELL__;
  return shell?.chrome === 'unified' ? 'unified' : 'standard';
}
