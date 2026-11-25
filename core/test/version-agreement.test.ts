// The app's version lives in four files that a release bumps together (docs/install.md, "Releasing a new version").
// The Rust shell shows tauri.conf.json's and hands Cargo's to the agent, which compares it with docs/release.json; the
// helper's manifest takes package.json's. If they disagree the PO is told about a version he already has, or never told.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compareSemver, parseReleaseNote, parseSemver } from '../src/release/note';

const root = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as { version?: string };

const cargoVersion = (): string | undefined => /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(read('src-tauri/Cargo.toml'))?.[1];
const lockVersion = (): string | undefined => /name = "split-finder-desktop"\s*\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock'))?.[1];

describe('one app version', () => {
  const pkg = json('package.json').version;
  it('package.json is a plain x.y.z version', () => {
    expect(parseSemver(pkg)).not.toBeNull();
  });
  it('tauri.conf.json, Cargo.toml and Cargo.lock say the same', () => {
    expect(json('src-tauri/tauri.conf.json').version).toBe(pkg);
    expect(cargoVersion()).toBe(pkg);
    expect(lockVersion()).toBe(pkg);
  });
  it('the Windows config does not name another version', () => {
    const w = json('src-tauri/tauri.windows.conf.json').version;
    if (w !== undefined) expect(w).toBe(pkg);
  });
  it('docs/release.json is valid and not ahead of the app', () => {
    const r = parseReleaseNote(read('docs/release.json'));
    expect(r).not.toBeNull();
    expect(compareSemver(r!.note.version, pkg!)).toBeLessThanOrEqual(0);
  });
});
