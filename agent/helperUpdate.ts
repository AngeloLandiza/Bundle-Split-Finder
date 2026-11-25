// Nov 25: a new app version brings the Chrome helper along. Chrome loads the helper from a folder, and only that folder's
// files make a reload useful, so when the connected helper is older than the one the app ships the agent unpacks the
// shipped helper into the folder Chrome loaded it from, then queues the reload it already knew how to queue. No network.
//
// Which folder: an unpacked extension's id is the first 16 bytes of the SHA-256 of its folder's path, each nibble as a
// letter a to p (Chrome's crx_file::id_util::GenerateIdForPath; the manifest has no "key"). The paired helper's id is
// known (its token's principal), so the one folder that hashes to it is the folder Chrome loaded it from, and the same
// folder keeps the same id, so pairing holds. A folder that hashes to another id, or whose manifest is not the helper's,
// is never written. Checked on macOS against a real Chrome profile; on Windows the id is taken over the UTF-16 path.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestBuild, manifestLooksValid, unpackZipInto } from './setup';

/** The names the helper's manifest carries: the app's build (`Split Finder`) and the helper-only build (wxt.config.ts). */
export const HELPER_NAMES: readonly string[] = ['Split Finder', 'Split Finder Helper'];

/** The id Chrome gives an unpacked extension loaded from `path` (letters a to p, 32 of them). */
export function extensionIdForPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const bytes = platform === 'win32' ? Buffer.from(path, 'utf16le') : Buffer.from(path, 'utf8');
  const hash = createHash('sha256').update(bytes).digest().subarray(0, 16);
  let id = '';
  for (const b of hash) id += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
  return id;
}

/** The paths Chrome may have been given for `dir`: as written, and with links resolved (Chrome normalizes some). */
function pathSpellings(dir: string): string[] {
  const spellings = [dir];
  try {
    const real = realpathSync.native(dir);
    if (!spellings.includes(real)) spellings.push(real);
  } catch {
    // The folder is not there: nothing to match.
  }
  return spellings;
}

/** Whether `dir` holds Split Finder's own helper: its manifest names it, and the files Chrome runs are there. */
export function isHelperFolder(dir: string): { ok: boolean; why: string } {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, why: 'it has no manifest.json' };
  let manifest: { name?: unknown; host_permissions?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return { ok: false, why: 'its manifest.json cannot be read' };
  }
  if (typeof manifest.name !== 'string' || !HELPER_NAMES.includes(manifest.name)) return { ok: false, why: 'its manifest is not Split Finder\'s' };
  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  if (!hosts.includes('https://www.homedepot.com/*')) return { ok: false, why: 'its manifest is not Split Finder\'s' };
  if (!existsSync(join(dir, 'background.js'))) return { ok: false, why: 'background.js is missing' };
  return { ok: true, why: '' };
}

/** Of `candidates`, the folder Chrome loaded the helper with id `extensionId` from, or null. */
export function folderForExtension(extensionId: string, candidates: readonly string[], platform: NodeJS.Platform = process.platform): string | null {
  for (const dir of candidates) {
    if (pathSpellings(dir).some((p) => extensionIdForPath(p, platform) === extensionId)) return dir;
  }
  return null;
}

export type UpdateOutcome = { ok: true } | { ok: false; why: string };

/**
 * The shipped helper into `dir`, which must be the helper's own folder (isHelperFolder, before and after: the new files
 * are unpacked beside it and checked first, so a bad zip leaves the folder as it was). Never creates `dir`.
 */
export function updateHelperFolder(zip: string, dir: string, shipped: string, unpack: (zip: string, dest: string) => void = unpackZipInto): UpdateOutcome {
  const before = isHelperFolder(dir);
  if (!before.ok) return { ok: false, why: `The folder ${dir} is not Split Finder's helper folder: ${before.why}.` };
  const staging = mkdtempSync(join(tmpdir(), 'sf-helper-'));
  try {
    unpack(zip, staging);
    const fresh = isHelperFolder(staging);
    if (!fresh.ok || !manifestLooksValid(staging).ok) return { ok: false, why: 'The helper this app ships could not be unpacked.' };
    if (manifestBuild(readFileSync(join(staging, 'manifest.json'), 'utf8')) !== shipped) return { ok: false, why: 'The helper this app ships is not the build it names.' };
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
    for (const name of readdirSync(staging)) cpSync(join(staging, name), join(dir, name), { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : 'The helper could not be updated.' };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the rule: once per shipped build, never a loop

/** What the app tells him about the helper's files; absent while the helper is the shipped build. */
export type HelperUpdateState =
  /** The agent unpacked the new files and asked Chrome to reload; waiting for the helper to say its build. */
  | { state: 'updating' }
  /** The agent cannot do it (or did, and the helper still reports the old build): the one button is "Install the helper again". */
  | { state: 'install'; why: string };

/** After the reload is queued, the helper has this long to come back with the new build before the app says it did not work. */
export const RELOAD_GRACE_MS = 90_000;

export interface HelperUpdateDeps {
  /** The build the app ships (its zip's manifest), or null with no zip. */
  shipped: string | null;
  zip: () => string | null;
  /** Where the install button puts the helper: the one folder the agent may recognise. */
  candidates: () => string[];
  now: () => number;
  /** The shipped builds already tried, kept across restarts (once per build). */
  tried: { get(build: string): number | undefined; add(build: string, at: number): void };
  queueReload: () => void;
  /** One line in Activity. */
  say: (text: string) => void;
  /** Test seam: unpacks the zip. */
  unpack?: (zip: string, dest: string) => void;
  platform?: NodeJS.Platform;
}

export const UPDATED_LINE = 'The Chrome helper was updated to match the app.';

/**
 * Called whenever the connected helper says its build. `extensionId`: the helper's id from its token. Returns what to
 * show, null when the helper is the shipped build (or no zip is shipped to compare with).
 */
export class HelperUpdate {
  private outcome: { state: 'updating'; until: number } | { state: 'install'; why: string } | null = null;

  constructor(private readonly d: HelperUpdateDeps) {}

  /** The helper reported `version` from the extension with id `extensionId`. */
  contact(extensionId: string | null, version: string | null): void {
    const { shipped } = this.d;
    if (shipped === null || version === null || version === shipped) {
      if (version === shipped) this.outcome = null;
      return;
    }
    if (this.outcome !== null) return;
    const triedAt = this.d.tried.get(shipped);
    if (triedAt !== undefined) {
      // Already tried for this build (before an app restart, or before the owner pressed Install again): never again. Inside
      // the reload's time it may still be on its way; after it, the files are not the ones Chrome loads.
      const until = triedAt + RELOAD_GRACE_MS;
      this.outcome = this.d.now() < until
        ? { state: 'updating', until }
        : { state: 'install', why: 'The helper in Chrome is still not the one this app ships after it was updated and reloaded.' };
      return;
    }
    this.d.tried.add(shipped, this.d.now());
    const zip = this.d.zip();
    const dir = extensionId === null ? null : folderForExtension(extensionId, this.d.candidates(), this.d.platform);
    if (zip === null) {
      this.outcome = { state: 'install', why: 'This app has no copy of the helper to install.' };
    } else if (dir === null) {
      this.outcome = { state: 'install', why: 'The app cannot tell which folder Chrome loaded the helper from.' };
    } else {
      const done = updateHelperFolder(zip, dir, shipped, this.d.unpack);
      if (!done.ok) this.outcome = { state: 'install', why: done.why };
      else {
        this.outcome = { state: 'updating', until: this.d.now() + RELOAD_GRACE_MS };
        this.d.say(UPDATED_LINE);
        this.d.queueReload();
      }
    }
  }

  /** The state to show now. An update that has had its time and not shown a new build becomes the failure. */
  state(): HelperUpdateState | null {
    const o = this.outcome;
    if (o === null) return null;
    if (o.state === 'updating' && this.d.now() >= o.until) {
      this.outcome = { state: 'install', why: 'The helper still reports the old build after it was updated and reloaded.' };
      return this.outcome;
    }
    return o.state === 'updating' ? { state: 'updating' } : o;
  }

  /** The owner installed the helper again: the next report is judged fresh (and tried once more for this build). */
  reset(): void {
    this.outcome = null;
  }
}

/** The shipped builds already tried, as a small file in the data folder (a restart does not try a build again). */
export function fileTried(path: string): HelperUpdateDeps['tried'] {
  const load = (): Record<string, number> => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (build) => {
      const at = load()[build];
      return typeof at === 'number' ? at : undefined;
    },
    add: (build, at) => {
      try {
        writeFileSync(path, JSON.stringify({ ...load(), [build]: at }), 'utf8');
      } catch {
        // Not written: the build is tried once more after a restart, never in a loop (the outcome stays in memory).
      }
    },
  };
}
