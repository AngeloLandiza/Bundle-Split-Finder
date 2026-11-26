// npm run release:prepare: the version changes in every file that names it, and nowhere else.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { bumpVersion, currentVersions, VERSION_FILES, type VersionFile } from '../src/release/bump';
import { LEGACY_DOWNLOAD_URL } from '../src/release/latestJson';
import { parseReleaseNote } from '../src/release/note';

const root = join(import.meta.dirname, '..', '..');
const real = () => Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(root, f), 'utf8')])) as Record<VersionFile, string>;

describe('bumpVersion on the real files', () => {
  it('finds the version once in each place, all the same', () => {
    const r = currentVersions(real());
    expect(r.ok).toBe(true);
    if (r.ok) expect(new Set(r.versions).size).toBe(1);
  });

  it('changes exactly the version lines, six of them, to the new version', () => {
    const files = real();
    const from = JSON.parse(files['package.json']).version as string;
    const next = from.replace(/\d+$/, (p) => String(Number(p) + 1));
    const r = bumpVersion(files, next);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toBe(from);
    let changed = 0;
    for (const f of VERSION_FILES) {
      const a = files[f].split('\n');
      const b = r.files[f].split('\n');
      expect(b).toHaveLength(a.length);
      const diff = b.filter((l, i) => l !== a[i]);
      changed += diff.length;
      for (const l of diff) expect(l).toContain(next);
    }
    expect(changed).toBe(6);
    expect(JSON.parse(r.files['package.json']).version).toBe(next);
    expect(JSON.parse(r.files['package-lock.json']).packages[''].version).toBe(next);
    expect(JSON.parse(r.files['src-tauri/tauri.conf.json']).version).toBe(next);
    expect(currentVersions(r.files)).toEqual({ ok: true, versions: Array(6).fill(next) });
  });

  it('refuses a version that is not newer, not x.y.z, or files that disagree', () => {
    const files = real();
    const from = JSON.parse(files['package.json']).version as string;
    expect(bumpVersion(files, from)).toMatchObject({ ok: false });
    expect(bumpVersion(files, '0.0.1')).toMatchObject({ ok: false });
    expect(bumpVersion(files, 'v9.0.0')).toMatchObject({ ok: false });
    expect(bumpVersion(files, '9.0')).toMatchObject({ ok: false });
    const odd = { ...files, 'src-tauri/Cargo.toml': files['src-tauri/Cargo.toml'].replace(`version = "${from}"`, 'version = "7.7.7"') };
    expect(bumpVersion(odd, '9.0.0')).toMatchObject({ ok: false, problem: expect.stringContaining('disagree') });
  });
});

describe('npm run release:prepare (the script, on a copy)', () => {
  it('writes the version everywhere and docs/release.json with the notes and the installer link, and prints the commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-release-'));
    for (const f of [...VERSION_FILES, 'docs/release.json']) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      cpSync(join(root, f), join(dir, f));
    }
    const from = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version as string;
    const next = from.replace(/^(\d+)\.(\d+)\.\d+$/, (_m, a: string, b: string) => `${a}.${Number(b) + 1}.0`);
    const out = execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'release-prepare.ts'), next, '--note', 'Installs new versions by itself.', '--date', '2026-11-26'], {
      env: { ...process.env, SPLIT_FINDER_RELEASE_ROOT: dir },
      encoding: 'utf8',
    });
    expect(out).toContain(`git tag v${next}`);
    expect(out).toContain(`git push origin v${next}`);
    expect(out.indexOf(`git push origin v${next}`)).toBeLessThan(out.indexOf('git push origin main'));
    const note = parseReleaseNote(readFileSync(join(dir, 'docs', 'release.json'), 'utf8'))!.note;
    expect(note).toEqual({ version: next, date: '2026-11-26', notes: ['Installs new versions by itself.'], downloadUrl: LEGACY_DOWNLOAD_URL });
    const files = Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(dir, f), 'utf8')])) as Record<VersionFile, string>;
    expect(currentVersions(files)).toEqual({ ok: true, versions: Array(6).fill(next) });

    // A second run with the same version changes nothing and says why.
    writeFileSync(join(dir, 'marker'), '');
    let failed = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'release-prepare.ts'), next, '--note', 'Again.'], { env: { ...process.env, SPLIT_FINDER_RELEASE_ROOT: dir }, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = String((e as { stderr?: string }).stderr);
    }
    expect(failed).toContain('Nothing was changed.');
  });
});
