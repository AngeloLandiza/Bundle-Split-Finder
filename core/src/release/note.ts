// The release note (docs/release.json): what the app reads once a day to learn that a new version is ready, and what
// the developer's `npm run release:note` writes. Pure: no I/O, no clock. The app never downloads or runs anything; it
// shows a message and a link, and the owner's PO runs the installer himself (docs/decisions.md, "New versions").

export interface ReleaseNote {
  version: string;
  /** YYYY-MM-DD. */
  date: string;
  notes: string[];
  /** A link that passed `safeDownloadLink`, or null (nothing announced yet, or a link that was refused). */
  downloadUrl: string | null;
}

/** The one address the app asks, with a plain GET that sends nothing about the user. */
export const RELEASE_URL = 'https://raw.githubusercontent.com/AngeloLandiza/Bundle-Split-Finder/main/docs/release.json';
export const MAX_NOTES = 5;
export const MAX_NOTE_CHARS = 120;
export const MAX_LINK_CHARS = 300;
/** The file is read no further than this. */
export const MAX_FILE_BYTES = 16 * 1024;

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/** [major, minor, patch] of a plain x.y.z version, or null (a pre-release, a build id such as "0.1.0+3c92cc7", text). */
export function parseSemver(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive; null when either is not a plain x.y.z version. */
export function compareSemver(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

const DOWNLOAD_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'github.com']);
const GITHUB_PREFIX = '/AngeloLandiza/Bundle-Split-Finder/';

/**
 * The link as written when it is safe to show and open, else null: https only; the host exactly drive.google.com,
 * docs.google.com or github.com (and for github.com a path inside this project); no user name or password, no port, no
 * control characters or spaces, no backslash, at most 300 characters. src-tauri/src/prefs.rs `is_web_url` then opens it.
 */
export function safeDownloadLink(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_LINK_CHARS) return null;
  if (CONTROL.test(url) || /\s/.test(url) || url.includes('\\')) return null;
  if (!url.startsWith('https://')) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  if (!DOWNLOAD_HOSTS.has(u.hostname)) return null;
  if (u.hostname === 'github.com' && !u.pathname.startsWith(GITHUB_PREFIX)) return null;
  return url;
}

function validDate(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

function validNotes(n: unknown): n is string[] {
  return Array.isArray(n) && n.length >= 1 && n.length <= MAX_NOTES && n.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= MAX_NOTE_CHARS && !CONTROL.test(s));
}

export interface ParsedRelease {
  note: ReleaseNote;
  /** The file named a link and it was refused (the notice then says to ask the developer). For a developer's log. */
  linkRefused: boolean;
}

/**
 * The file's text as a release note, or null when any field is wrong: not JSON (an HTML error page), not an object, a
 * version that is not x.y.z, a date that is not a real YYYY-MM-DD, notes that are not 1 to 5 lines of at most 120
 * characters, a link that is neither null nor text. A text link that fails `safeDownloadLink` is dropped, not fatal.
 */
export function parseReleaseNote(text: unknown): ParsedRelease | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FILE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (parseSemver(o.version) === null || !validDate(o.date) || !validNotes(o.notes)) return null;
  const link = o.downloadUrl;
  if (link !== null && typeof link !== 'string') return null;
  const safe = link === null ? null : safeDownloadLink(link);
  return { note: { version: o.version as string, date: o.date, notes: o.notes.map((s) => s.trim()), downloadUrl: safe }, linkRefused: link !== null && safe === null };
}

/** True when the note is for a version newer than the one running. False for equal, older, or a running version that is not x.y.z. */
export function isNewer(note: Pick<ReleaseNote, 'version'>, running: string | null | undefined): boolean {
  if (typeof running !== 'string') return false;
  const c = compareSemver(note.version, running);
  return c !== null && c > 0;
}

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The one message every channel carries: the version, what changed, and the link or what to do without one. */
export function releaseMessage(note: ReleaseNote): string {
  const changed = note.notes.map(sentence).join(' ');
  const tail = note.downloadUrl ? `Download: ${note.downloadUrl}` : 'Ask the developer for the download link.';
  return `Split Finder ${note.version} is ready. What changed: ${changed} ${tail}`;
}

export interface ReleaseNoteInput {
  version: string;
  url: string;
  notes: string[];
  /** YYYY-MM-DD; the script passes today's date. */
  date: string;
}

/** What `npm run release:note` writes: the new note, or the one thing wrong with the input. `current` is the file as it is now (null: none). */
export function nextReleaseNote(current: Pick<ReleaseNote, 'version'> | null, input: ReleaseNoteInput): { ok: true; note: ReleaseNote } | { ok: false; problem: string } {
  if (parseSemver(input.version) === null) return { ok: false, problem: `--version must be x.y.z (for example 0.1.1), not "${input.version}".` };
  if (current) {
    const c = compareSemver(input.version, current.version);
    if (c === null || c <= 0) return { ok: false, problem: `--version ${input.version} must be greater than the ${current.version} in docs/release.json.` };
  }
  if (!validDate(input.date)) return { ok: false, problem: `The date must be a real YYYY-MM-DD, not "${input.date}".` };
  if (input.notes.length < 1 || input.notes.length > MAX_NOTES) return { ok: false, problem: `Give 1 to ${MAX_NOTES} --note lines (got ${input.notes.length}).` };
  const long = input.notes.find((n) => n.trim().length === 0 || n.length > MAX_NOTE_CHARS || CONTROL.test(n));
  if (long !== undefined) return { ok: false, problem: `Each --note must be 1 to ${MAX_NOTE_CHARS} characters with no control characters: "${long.slice(0, 40)}".` };
  if (safeDownloadLink(input.url) === null) {
    return { ok: false, problem: `--url must be https on drive.google.com, docs.google.com or github.com/AngeloLandiza/Bundle-Split-Finder/, up to ${MAX_LINK_CHARS} characters, with no user name.` };
  }
  return { ok: true, note: { version: input.version, date: input.date, notes: input.notes.map((n) => n.trim()), downloadUrl: input.url } };
}
