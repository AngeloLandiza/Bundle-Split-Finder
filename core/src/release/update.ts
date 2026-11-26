// Self-update (Nov 25, docs/decisions.md "The app updates itself"): when a new version the shell found and verified may be
// installed, and what the shell's report may carry into the window. Pure: no I/O, no clock of its own.
//
// The shell (src-tauri/src/updater.rs) checks GitHub a minute after launch and then every 6 hours, downloads a newer
// version in the background and verifies its signature. Before it installs, it asks the agent (POST /api/update/pending),
// which answers with `installDecision` below: only when the owner allows it (automatically, or he pressed Install now),
// when nothing is running, and not in the quiet window before a scheduled scan.

import { compareSemver, MAX_NOTES, MAX_NOTE_CHARS, parseSemver } from './note';

/** The shell's first look after launch, then one every CHECK_EVERY_MS. src-tauri/src/updater.rs holds the same numbers (a test compares). */
export const FIRST_CHECK_AFTER_MS = 60_000;
export const CHECK_EVERY_MS = 6 * 3_600_000;
/** No install this long before a scheduled scan: the app restarts, and a scan must not start into a restart. */
export const QUIET_BEFORE_SCAN_MS = 15 * 60_000;
/**
 * A scheduled scan whose time has passed and that has not started is still about to start for this long (the scheduler
 * ticks once a minute). After that it is waiting for something else (Chrome, a pause) and does not hold an install back.
 */
export const OVERDUE_GRACE_MS = 5 * 60_000;
/** The shell says it still holds the update at least this often (it asks every 20 s while it does). Older: it does not. */
export const PENDING_FRESH_MS = 2 * 60_000;
/** A reason or a version note from the network is cut to this. */
export const MAX_WHY_CHARS = 200;

/** What is running now, by the agent's own account (work.ts live.busy, or another write such as a lookup round). */
export type RunningWork = 'scan' | 'ask' | 'paid' | 'other' | null;

export interface InstallInput {
  /** The running app's version (x.y.z), or null outside the app. */
  running: string | null;
  /** The version the shell downloaded and verified. */
  candidate: string;
  now: number;
  /** "Look for new versions" (Settings, General). Off: nothing is installed either. */
  looking: boolean;
  /** "Install new versions automatically" (Settings, General). */
  automatic: boolean;
  /** The owner pressed Install now for this version. */
  requested: boolean;
  working: RunningWork;
  /** The next scheduled scan (ISO), or null when none is scheduled (none set, or paused). */
  nextScanAt: string | null;
}

export type InstallDecision =
  | { install: true }
  | { install: false; wait: 'never' | 'owner' | 'work' | 'scan'; why: string };

const WORK_WORDS: Record<Exclude<RunningWork, null>, string> = {
  scan: 'a scan is running',
  ask: 'the AI is answering questions',
  paid: 'a paid lookup is running',
  other: 'a lookup is running',
};

/**
 * Whether to install now. Never a version that is not newer than the running one (no downgrade, and nothing when the
 * running version is unknown). Then the owner's say (automatic, or Install now), then idle, then the quiet window.
 */
export function installDecision(i: InstallInput): InstallDecision {
  const c = i.running === null ? null : compareSemver(i.candidate, i.running);
  if (c === null || c <= 0) return { install: false, wait: 'never', why: `${i.candidate} is not newer than the version running.` };
  if (!i.looking) return { install: false, wait: 'never', why: 'Looking for new versions is off.' };
  if (!i.automatic && !i.requested) return { install: false, wait: 'owner', why: 'Waiting for you to press Install now.' };
  if (i.working !== null) return { install: false, wait: 'work', why: `It installs when nothing is running; ${WORK_WORDS[i.working]}.` };
  if (i.nextScanAt !== null) {
    const due = Date.parse(i.nextScanAt);
    if (Number.isFinite(due) && i.now >= due - QUIET_BEFORE_SCAN_MS && i.now <= due + OVERDUE_GRACE_MS) {
      return { install: false, wait: 'scan', why: 'A scheduled scan starts soon; it installs after the scan.' };
    }
  }
  return { install: true };
}

// Control characters other than tab and line feed (those are handled where text is split into lines), and the Unicode
// line and paragraph separators. A RegExp from a string: U+2028 inside a regex literal would end the line.
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

/**
 * Release notes as the shell read them from latest.json (untrusted text from the network): one line per note, any markup
 * removed, control characters dropped, at most MAX_NOTES lines of MAX_NOTE_CHARS. Never fails: bad input is no notes.
 */
export function cleanNotes(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  return text
    .slice(0, 4_000)
    .split('\n')
    .map((l) => l.replace(CONTROL, '').replace(/<[^>]*>?/g, '').replace(/[<>]/g, '').replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_NOTES)
    .map((l) => (l.length > MAX_NOTE_CHARS ? `${l.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : l));
}

/** One short line of untrusted text (an error the shell met): no control characters or markup, at most MAX_WHY_CHARS. */
export function cleanWhy(text: unknown): string {
  if (typeof text !== 'string') return '';
  const one = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').replace(/[<>]/g, '').trim();
  return one.length > MAX_WHY_CHARS ? `${one.slice(0, MAX_WHY_CHARS - 1).trimEnd()}…` : one;
}

/** POST /api/update/pending: the shell holds a downloaded, verified update of this version. */
export interface PendingReport {
  version: string;
  notes: string[];
}

/** POST /api/update/report: a look at GitHub that found nothing newer, or one that failed (`why`). */
export interface CheckReport {
  outcome: 'current' | 'failed';
  why: string;
}

export function parsePendingReport(body: unknown): PendingReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (parseSemver(b.version) === null) return null;
  return { version: b.version as string, notes: cleanNotes(b.notes) };
}

export function parseCheckReport(body: unknown): CheckReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.outcome !== 'current' && b.outcome !== 'failed') return null;
  return { outcome: b.outcome, why: b.outcome === 'failed' ? cleanWhy(b.why) || 'no reason was given' : '' };
}

const sentence = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** The calm notice and the Activity line after an update: "Split Finder was updated to 0.2.0." */
export const updatedTitle = (version: string): string => `Split Finder was updated to ${version}.`;
/** The manual mode's notice and message: "Version 0.2.0 is ready." */
export const readyTitle = (version: string): string => `Version ${version} is ready.`;

/** The one message (notification, Telegram) when a version waits for Install now. */
export function readyMessage(version: string, notes: string[]): string {
  const changed = notes.length ? ` What changed: ${notes.map(sentence).join(' ')}` : '';
  return `Split Finder ${version} is ready.${changed} Open Split Finder and press Install now when you like.`;
}

/** Activity, when the install did not finish (the app started again on the old version). */
export const notInstalledSentence = (version: string, running: string): string =>
  `The update to ${version} did not finish. Split Finder is still on ${running} and looks again in 6 hours.`;

/** Activity, when a look or a download failed. */
export const checkFailedSentence = (why: string): string =>
  `Split Finder could not get its new version: ${cleanWhy(why).replace(/[.!?…\s]+$/, '') || 'no reason was given'}. It keeps running this version and looks again in 6 hours.`;
