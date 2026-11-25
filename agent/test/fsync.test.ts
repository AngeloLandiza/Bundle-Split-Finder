// The flush to disk is skipped in the default suite (agent/test/setup.ts). These tests keep the real one covered: the
// agent's own default, a write through the real fsyncSync for the file and its folder, and that only test code can
// swap it out.

import { spawnSync } from 'node:child_process';
import { fstatSync, fsyncSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { setSyncForTests } from '../fsync';
import { writeFileAtomic } from '../store';

const ROOT = join(import.meta.dirname, '..', '..');

describe('the flush to disk', () => {
  afterEach(() => setSyncForTests(() => {}));

  it('a write flushes the file and then its folder through the real fsyncSync, and leaves only the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-fsync-'));
    const seen: ('file' | 'folder')[] = [];
    setSyncForTests((fd) => {
      seen.push(fstatSync(fd).isDirectory() ? 'folder' : 'file');
      fsyncSync(fd);
    });
    const path = join(dir, 'bundles.json');
    writeFileAtomic(path, '[["a",1]]');
    writeFileAtomic(path, '[["a",2]]');
    expect(seen).toEqual(['file', 'folder', 'file', 'folder']);
    expect(readFileSync(path, 'utf8')).toBe('[["a",2]]');
    expect(readdirSync(dir)).toEqual(['bundles.json']);
  });

  it('a flush that fails fails the write, and the old file stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-fsync-'));
    const path = join(dir, 'keys.json');
    writeFileAtomic(path, 'old');
    setSyncForTests(() => {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    });
    expect(() => writeFileAtomic(path, 'new')).toThrow(/EIO/);
    expect(readFileSync(path, 'utf8')).toBe('old');
  });

  it('outside the test setup the agent flushes with the real fsyncSync: two flushes per write', () => {
    // A fresh Node process, as the agent runs: no setup file, fs.fsyncSync counted before the agent's code loads.
    const script = [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'let n = 0; const real = fs.fsyncSync; fs.fsyncSync = (fd) => { n++; real(fd); }; syncBuiltinESMExports();',
      "const { writeFileAtomic } = await import('./agent/store.ts');",
      "const dir = fs.mkdtempSync(process.argv[1]); writeFileAtomic(dir + '/x.json', '[]');",
      'console.log(`fsyncs=${n}`);',
    ].join('\n');
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, join(tmpdir(), 'sf-fsync-child-')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('fsyncs=2');
  });

  it('only the test setup and tests swap the flush out', () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && readFileSync(path, 'utf8').includes('setSyncForTests')) callers.push(relative(ROOT, path).replaceAll('\\', '/'));
      }
    };
    for (const top of ['agent', 'core', 'desktop', 'desktop-ui', 'extension', 'scripts']) walk(join(ROOT, top));
    const outsideTests = callers.filter((p) => p !== 'agent/fsync.ts' && !/(^|\/)test\//.test(p) && !/\.test\.ts$/.test(p));
    expect(outsideTests).toEqual([]);
    expect(callers).toContain('agent/test/setup.ts');
  });
});
