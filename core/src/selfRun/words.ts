// What the next scheduled scan depends on, in one sentence (Agent panel, "Next scan"): Chrome and the helper are how Home Depot
// pages are read, and a scan at 7:00 with Chrome closed has no way to read them. Pure.

export interface NextScanFacts {
  /** A scheduled scan is coming (the schedule is not manual and the agent is not paused). */
  coming: boolean;
  /** The Split Finder helper in Chrome has been paired at some point. */
  paired: boolean;
  /** The helper is connected now. */
  connected: boolean;
  /** Settings, Scanning: "Open Chrome for scheduled scans". */
  openChrome: boolean;
  /** Without Chrome a scheduled scan waits for it (it is not set to search SerpApi instead). */
  waitsForChrome: boolean;
}

/** One sentence on what the next scan needs and does not have; null when nothing is missing. */
export function nextScanNeeds(f: NextScanFacts): string | null {
  if (!f.coming || f.connected) return null;
  if (!f.paired) return 'Home Depot pages need Chrome with the Split Finder helper, which is not connected yet. Connect it in Settings, Chrome; until then a scan leaves those pages waiting.';
  if (f.openChrome) {
    return f.waitsForChrome
      ? 'Needs Chrome, which is closed. Split Finder opens it a few minutes before the scan; if it does not open, the scan runs without Home Depot pages.'
      : 'Chrome is closed. Split Finder opens it a few minutes before the scan to read Home Depot pages.';
  }
  return f.waitsForChrome
    ? 'Needs Chrome, which is closed: the scan waits until you open it. Turn on Open Chrome for scheduled scans in Settings, Scanning, to have Split Finder do it.'
    : 'Chrome is closed, so Home Depot pages wait. Turn on Open Chrome for scheduled scans in Settings, Scanning, to have Split Finder open it.';
}

/** The quiet notice (and its Activity line's beginning) when the app turned "Open at login" on for a schedule. */
export const LOGIN_NOTICE = 'Split Finder now opens when you log in, because you set a schedule: scans run only while it is running.';
