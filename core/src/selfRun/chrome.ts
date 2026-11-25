// Running without the owner (Nov 25): when the app starts his Chrome for a scheduled scan, and what it says when that did not
// work. Pure: the clock and the facts are handed in; the agent (agent/selfRun.ts) does the starting.
//
// Home Depot's pages are read through the owner's own Chrome and the Split Finder helper in it. A 7:00 scan with Chrome closed
// has nothing to read them with, so a few minutes before it the app starts that same Chrome, in the background, and waits for the
// helper. It is his ordinary Chrome with his ordinary profile: nothing hidden, no automation flags (docs/decisions.md).

/** The app starts Chrome this long before a scheduled scan is due (and at once when the scan is already overdue). */
export const CHROME_LEAD_MS = 5 * 60_000;
/** After starting it, the app waits this long for the helper to connect, then scans what can be done without it. */
export const CHROME_WAIT_MS = 4 * 60_000;
/** Home Depot pages that have waited this long with Chrome closed are a reason to start it between scans (once a day). */
export const PAGES_WAIT_MS = 60 * 60_000;

/** What one try to start Chrome came to. Stored (runtime.selfRun.chrome) so a restart does not try again for the same run. */
export interface ChromeAttempt {
  /** The run it was for: `scan:<anchor>` (the schedule's anchor, so one per scan) or `pages:<local day>`. */
  key: string;
  reason: 'scan' | 'pages';
  /** When it was tried (epoch ms). */
  at: number;
  /** `started`: the system accepted the start; `failed`: it did not (no Chrome found, or the start was refused). */
  result: 'started' | 'failed';
  /** Why it failed, in a few words; never a path with a user name in it. */
  why?: string;
  /** Chrome was not running when the app started it. Only a Chrome the app started is ever closed by the app. */
  weStarted: boolean;
  /** When the helper first connected after the start (epoch ms). */
  connectedAt?: number;
  /** When the app closed the Chrome it started (setting: close it after the scan). */
  closedAt?: number;
}

export interface ChromeFacts {
  now: number;
  /** Settings, Scanning: "Open Chrome for scheduled scans". */
  setting: boolean;
  /** The schedule is not manual. */
  scheduled: boolean;
  paused: boolean;
  helperConnected: boolean;
  /** A scan or another paid run is working now. */
  busy: boolean;
  /** When the next scheduled scan is due (epoch ms; already past for a catch-up), or null (manual, paused). */
  nextScanAt: number | null;
  /** The key of that scan: the same until it starts. */
  scanKey: string;
  /** Home Depot pages wait for a read, and the drip would read them, and since when they have waited with no helper. */
  pagesWaitingSince: number | null;
  /** Home Depot refused a page and every read is paused until this time. */
  hdPausedUntil: number | null;
  /** The local day, "2026-11-25". */
  today: string;
  /** What the last try was. */
  last: ChromeAttempt | undefined;
}

export interface ChromeWanted {
  reason: 'scan' | 'pages';
  key: string;
}

/** Whether to start Chrome now, and for what. Never when the helper is connected; never twice for the same run. */
export function chromeWanted(f: ChromeFacts): ChromeWanted | null {
  if (!f.setting || !f.scheduled || f.paused || f.helperConnected || f.busy) return null;
  if (f.nextScanAt !== null && f.now >= f.nextScanAt - CHROME_LEAD_MS && f.last?.key !== f.scanKey) return { reason: 'scan', key: f.scanKey };
  const pagesKey = `pages:${f.today}`;
  if (
    f.pagesWaitingSince !== null && f.now - f.pagesWaitingSince >= PAGES_WAIT_MS && (f.hdPausedUntil === null || f.hdPausedUntil <= f.now) && f.last?.key !== pagesKey
    // One start a day for the pages, and none while a scheduled scan's own start is near or under way.
    && !(f.nextScanAt !== null && f.nextScanAt - f.now <= CHROME_LEAD_MS + CHROME_WAIT_MS)
  ) return { reason: 'pages', key: pagesKey };
  return null;
}

/**
 * Whether a scheduled scan that waits for Chrome may start without it: the app tried for this scan and the wait is over (or
 * the start failed at once). The scan then does what needs no Home Depot page and says so (chromeSentence).
 */
export function mayScanWithoutChrome(last: ChromeAttempt | undefined, scanKey: string, now: number, helperConnected: boolean): boolean {
  if (helperConnected || !last || last.key !== scanKey) return false;
  return last.result === 'failed' || now - last.at >= CHROME_WAIT_MS;
}

/** The sentence for a scan that ran without Chrome after the app tried; null when it did not try (the usual sentence stands). */
export function chromeSentence(last: ChromeAttempt | undefined, scanKey: string): string | null {
  if (!last || last.key !== scanKey) return null;
  if (last.result === 'failed') return 'Chrome did not open, so Home Depot pages wait.';
  if (last.weStarted) return 'Chrome opened, but the Split Finder helper did not connect, so Home Depot pages wait.';
  return 'Chrome is open, but the Split Finder helper did not connect, so Home Depot pages wait.';
}

/** The Activity line for a try. */
export function attemptSentence(a: ChromeAttempt, dueWords: string | null): string {
  const forWhat = a.reason === 'scan' ? (dueWords ? `the ${dueWords} scan` : 'a scheduled scan') : 'the Home Depot pages that wait';
  if (a.result === 'failed') return `Chrome could not be opened for ${forWhat}${a.why ? `: ${a.why}` : '.'}`;
  return `Opened Chrome in the background for ${forWhat}, and waited for the Split Finder helper. It is your own Chrome and profile.`;
}

/** The Activity line when the helper connected after the app started Chrome. */
export function connectedSentence(a: ChromeAttempt): string {
  const secs = a.connectedAt !== undefined ? Math.max(1, Math.round((a.connectedAt - a.at) / 1000)) : null;
  return `The Split Finder helper connected${secs !== null ? ` ${secs < 90 ? `${secs} seconds` : `${Math.round(secs / 60)} minutes`} after Chrome was opened` : ''}.`;
}

/** Windows: where an installed chrome.exe is usually found, from the process's environment. Pure; the caller checks which exists. */
export function windowsChromeFolders(env: Readonly<Record<string, string | undefined>>): string[] {
  const rel = '\\Google\\Chrome\\Application\\chrome.exe';
  const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA].filter((b): b is string => typeof b === 'string' && b.length > 0);
  return [...new Set(bases.map((b) => b.replace(/[\\/]+$/, '') + rel))];
}

/** The path `reg query ... /ve` prints for chrome.exe's App Paths key, or null. */
export function pathFromRegQuery(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line) ?? /^\s*<NO NAME>\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m && /chrome\.exe$/i.test(m[1]!)) return m[1]!;
  }
  return null;
}
