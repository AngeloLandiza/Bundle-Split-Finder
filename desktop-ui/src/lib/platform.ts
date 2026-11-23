// Which system the window runs on, decided once: WKWebView on a Mac, WebView2 on Windows. It sets `data-platform` on
// <html> (windows.css reads it), picks the words a system uses for the same thing (Preferences or Settings, the Dock
// or the taskbar), and writes shortcut labels the way that system does (⌥⌘I or Ctrl+Alt+I). Pure except for `platform`.

export type Platform = 'mac' | 'windows' | 'other';

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  userAgentData?: { platform?: string };
}

/**
 * The user agent decides first (it names Windows NT or Macintosh in both webviews, and it is what a test overrides),
 * then the client hints, then the older platform string. Anything else (a Linux browser, a script) is `other`: it gets
 * Ctrl labels and the Mac words, and no Windows styling.
 */
export function detectPlatform(nav: NavigatorLike | undefined): Platform {
  if (!nav) return 'other';
  const from = (text: string | undefined): Platform | null => {
    if (!text) return null;
    if (/Windows|Win32|Win64/i.test(text)) return 'windows';
    if (/Macintosh|Mac OS|MacIntel|MacPPC|macOS/i.test(text)) return 'mac';
    return null;
  };
  return from(nav.userAgent) ?? from(nav.userAgentData?.platform) ?? from(nav.platform) ?? 'other';
}

export const platform: Platform = detectPlatform(typeof navigator !== 'undefined' ? navigator : undefined);
export const isMac = platform === 'mac';
export const isWindows = platform === 'windows';

/** Puts `data-platform` on <html> before the first paint: windows, mac, or other (which takes the Mac's look). */
export function applyPlatform(p: Platform = platform, root: HTMLElement = document.documentElement): void {
  root.dataset.platform = p;
}

/**
 * One shortcut as a person reads it. Tokens are `mod` (Cmd, Ctrl), `alt`, `shift`, `enter` or the key itself:
 * a Mac runs the glyphs together in its own order (⌥⇧⌘K), Windows joins words with plus signs (Ctrl+Alt+Shift+K).
 */
export function formatShortcut(tokens: readonly string[], mac: boolean): string {
  const has = (t: string) => tokens.includes(t);
  const keys = tokens.filter((t) => t !== 'mod' && t !== 'alt' && t !== 'shift').map((t) => (t === 'enter' ? (mac ? '↩' : 'Enter') : t));
  if (mac) return `${has('alt') ? '⌥' : ''}${has('shift') ? '⇧' : ''}${has('mod') ? '⌘' : ''}${keys.join('')}`;
  return [has('mod') ? 'Ctrl' : '', has('alt') ? 'Alt' : '', has('shift') ? 'Shift' : '', ...keys].filter(Boolean).join('+');
}

/** The words that differ between the two systems. The Mac's are the default: other systems read them too. */
export interface Words {
  /** The window and the screen: "Preferences" on a Mac, "Settings" in Windows. */
  preferences: string;
  /** The popover's menu row for it. */
  preferencesRow: string;
  /** The popover's last row. */
  quit: string;
  /** Opens the folder in the system's file manager. */
  revealFolder: string;
  /** Where the app lives while its window is closed: the menu bar or the notification area. */
  trayPlace: string;
  /** "Show menu bar icon" / "Show notification area icon". */
  trayIconSwitch: string;
  /** "Show Dock icon" / "Show in taskbar". */
  dockSwitch: string;
  /** This computer, as a sentence names it. */
  computer: string;
}

const MAC_WORDS: Words = {
  preferences: 'Preferences',
  preferencesRow: 'Preferences…',
  quit: 'Quit Split Finder',
  revealFolder: 'Show in Finder',
  trayPlace: 'menu bar',
  trayIconSwitch: 'Show menu bar icon',
  dockSwitch: 'Show Dock icon',
  computer: 'Mac',
};

const WINDOWS_WORDS: Words = {
  preferences: 'Settings',
  preferencesRow: 'Settings',
  quit: 'Exit',
  revealFolder: 'Show in File Explorer',
  trayPlace: 'notification area',
  trayIconSwitch: 'Show notification area icon',
  dockSwitch: 'Show in taskbar',
  computer: 'PC',
};

export const wordsFor = (windows: boolean): Words => (windows ? WINDOWS_WORDS : MAC_WORDS);
export const words: Words = wordsFor(isWindows);
