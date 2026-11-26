// npm run release:prepare -- <version>: the app's version lives in six places, and a release changes them together
// (core/test/version-agreement.test.ts fails when they disagree). Pure text changes: the CLI (scripts/release-prepare.ts)
// reads and writes the files. Each change touches exactly one line and leaves the rest of the file as it was.

import { compareSemver, parseSemver } from './note';

/** Every file that names the app's version, relative to the repository root. docs/release.json is written separately. */
export const VERSION_FILES = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'] as const;
export type VersionFile = (typeof VERSION_FILES)[number];

interface Rule {
  /** Must match exactly once; group 1 is the text before the version, group 2 the version. */
  pattern: RegExp;
  count: number;
}

// The top-level "version" of a JSON file is the line indented by two spaces right inside the outer object.
const RULES: Record<VersionFile, Rule[]> = {
  'package.json': [{ pattern: /^( {2}"version": ")([^"]+)(")/m, count: 1 }],
  // The lock file names it twice: its own top level, and the root package (packages[""]).
  'package-lock.json': [
    { pattern: /^( {2}"version": ")([^"]+)(")/m, count: 1 },
    { pattern: /^( {4}"": \{\n {6}"name": "[^"]+",\n {6}"version": ")([^"]+)(")/m, count: 1 },
  ],
  'src-tauri/tauri.conf.json': [{ pattern: /^( {2}"version": ")([^"]+)(")/m, count: 1 }],
  'src-tauri/Cargo.toml': [{ pattern: /^(\[package\]\nname = "split-finder-desktop"\nversion = ")([^"]+)(")/m, count: 1 }],
  'src-tauri/Cargo.lock': [{ pattern: /^(name = "split-finder-desktop"\nversion = ")([^"]+)(")/m, count: 1 }],
};

/** The version each place names now, or the problem (a place that is missing or appears twice). */
export function currentVersions(files: Record<VersionFile, string>): { ok: true; versions: string[] } | { ok: false; problem: string } {
  const versions: string[] = [];
  for (const name of VERSION_FILES) {
    for (const rule of RULES[name]) {
      const all = [...files[name].matchAll(new RegExp(rule.pattern.source, 'gm'))];
      if (all.length !== rule.count) return { ok: false, problem: `${name}: expected the app's version in one place, found ${all.length}.` };
      versions.push(all[0]![2]!);
    }
  }
  return { ok: true, versions };
}

/**
 * The files with `next` in every place, or the one thing wrong: `next` is not x.y.z, the places disagree now (fix that
 * first), or `next` is not newer than what they say (a release never goes back).
 */
export function bumpVersion(files: Record<VersionFile, string>, next: string): { ok: true; from: string; files: Record<VersionFile, string> } | { ok: false; problem: string } {
  if (parseSemver(next) === null) return { ok: false, problem: `The version must be x.y.z (for example 0.2.0), not "${next}".` };
  const now = currentVersions(files);
  if (!now.ok) return now;
  const from = now.versions[0]!;
  if (now.versions.some((v) => v !== from)) return { ok: false, problem: `The files disagree on the current version (${[...new Set(now.versions)].join(', ')}). Make them agree first.` };
  const c = compareSemver(next, from);
  if (c === null || c <= 0) return { ok: false, problem: `${next} must be newer than the current ${from}.` };
  const out = { ...files };
  for (const name of VERSION_FILES) {
    for (const rule of RULES[name]) out[name] = out[name].replace(rule.pattern, (_m, before: string, _v: string, after: string) => `${before}${next}${after}`);
  }
  return { ok: true, from, files: out };
}
