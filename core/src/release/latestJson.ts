// latest.json: the file the installed app's updater reads from the newest GitHub release
//   https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/latest/download/latest.json
// in Tauri's static format (https://v2.tauri.app/plugin/updater/, "Static JSON File"): `version`, `notes`, `pub_date`, and
// per platform (`darwin-aarch64`, `windows-x86_64`) the `url` of the update file and its `signature`, which is the
// CONTENT of the .sig file, not a path or link. Tauri checks the whole file before the version, so every platform listed
// must be complete. Pure: the release workflow's CLI (scripts/release-latest-json.ts) reads the files and writes it.

import { MAX_NOTE_CHARS, MAX_NOTES, parseSemver } from './note';

export const REPO = 'AngeloLandiza/Bundle-Split-Finder';

/**
 * The release's files under names that never change (the README links releases/latest/download/<name>). The Windows
 * installer is also the Windows update file: Tauri v2's NSIS updater runs the -setup.exe itself.
 */
export const ASSETS = {
  windowsInstaller: 'Split-Finder-Windows-x64-setup.exe',
  macDmg: 'Split-Finder-Mac-Apple-silicon.dmg',
  macUpdate: 'Split-Finder-Mac-Apple-silicon.app.tar.gz',
} as const;

/**
 * docs/release.json's download link (release:prepare's default): what an install of 0.1.0, which cannot update itself,
 * offers behind its Download button. The newest release's page, which lists the Windows and the Mac installer: 0.1.0 is
 * installed on both, and a link to one platform's file would hand the other the wrong one.
 */
export const LEGACY_DOWNLOAD_URL = `https://github.com/${REPO}/releases/latest`;

/** The two platforms a release serves, and the file each one updates from. */
export const PLATFORM_ASSET = {
  'darwin-aarch64': ASSETS.macUpdate,
  'windows-x86_64': ASSETS.windowsInstaller,
} as const;
export type Platform = keyof typeof PLATFORM_ASSET;

/** A file of the release for this tag (the tag's own address, so an old latest.json never points at a newer file). */
export const assetUrl = (tag: string, name: string): string => `https://github.com/${REPO}/releases/download/${tag}/${name}`;

export interface LatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<Platform, { signature: string; url: string }>;
}

export interface LatestInput {
  version: string;
  notes: string[];
  /** RFC 3339, e.g. new Date().toISOString(). */
  pubDate: string;
  /** Each platform's .sig file content. */
  signatures: Record<Platform, string>;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SIGNATURE_CHARS = 2_000;

/** The file, or the one thing wrong with the input. Every platform must have a signature; nothing is guessed. */
export function buildLatestJson(i: LatestInput): { ok: true; json: LatestJson } | { ok: false; problem: string } {
  if (parseSemver(i.version) === null) return { ok: false, problem: `The version must be x.y.z, not "${i.version}".` };
  if (i.notes.length < 1 || i.notes.length > MAX_NOTES || i.notes.some((n) => n.trim() === '' || n.length > MAX_NOTE_CHARS || n.includes('\n'))) {
    return { ok: false, problem: `Give 1 to ${MAX_NOTES} notes of at most ${MAX_NOTE_CHARS} characters, one line each.` };
  }
  const at = Date.parse(i.pubDate);
  if (!Number.isFinite(at) || !/^\d{4}-\d{2}-\d{2}T/.test(i.pubDate)) return { ok: false, problem: `pub_date must be an RFC 3339 time, not "${i.pubDate}".` };
  const tag = `v${i.version}`;
  const platforms = {} as LatestJson['platforms'];
  for (const p of Object.keys(PLATFORM_ASSET) as Platform[]) {
    const sig = (i.signatures[p] ?? '').trim();
    if (!sig) return { ok: false, problem: `No signature for ${p}.` };
    if (sig.length > MAX_SIGNATURE_CHARS || !BASE64.test(sig)) return { ok: false, problem: `The ${p} signature is not the content of a .sig file.` };
    platforms[p] = { signature: sig, url: assetUrl(tag, PLATFORM_ASSET[p]) };
  }
  return { ok: true, json: { version: i.version, notes: i.notes.map((n) => n.trim()).join('\n'), pub_date: new Date(at).toISOString(), platforms } };
}
