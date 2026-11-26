// Two preferences of this computer, kept with the look in the browser storage the app's windows share (as
// lib/appearance.ts): where links open (Settings › General › Open links) and whether product pictures show (Settings ›
// General › Show product pictures). Each picture is a request to Amazon's image server, so it can be turned off.

export type OpenLinksIn = 'app' | 'browser';

export interface LinkPrefs {
  openLinksIn: OpenLinksIn;
  showPictures: boolean;
}

export const DEFAULT_LINK_PREFS: LinkPrefs = { openLinksIn: 'app', showPictures: true };

const KEY = 'splitFinder.links';

export function parseLinkPrefs(raw: string | null): LinkPrefs {
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<Record<keyof LinkPrefs, unknown>> | null;
    if (!v || typeof v !== 'object') return DEFAULT_LINK_PREFS;
    return {
      openLinksIn: v.openLinksIn === 'browser' ? 'browser' : 'app',
      showPictures: v.showPictures === false ? false : true,
    };
  } catch {
    return DEFAULT_LINK_PREFS;
  }
}

export function readLinkPrefs(): LinkPrefs {
  try {
    return parseLinkPrefs(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_LINK_PREFS;
  }
}

export function saveLinkPrefs(p: LinkPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // this session only
  }
  listeners.forEach((fn) => fn(p));
}

const listeners = new Set<(p: LinkPrefs) => void>();

/** This window or another one (Preferences) changed them. */
export function onLinkPrefsChange(cb: (p: LinkPrefs) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) cb(readLinkPrefs());
  };
  listeners.add(cb);
  window.addEventListener('storage', handler);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', handler);
  };
}
