import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { installExtensionFromZip, manifestLooksValid } from '../setup';
import { writeFileSync } from 'node:fs';

const zipFixture = join(import.meta.dirname, '../../output/bundle-split-finder-0.1.0-chrome.zip');

describe('Lane D: install browser helper folder', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
    temps.length = 0;
  });

  it('rejects a stale manifest with the invalid permissions string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-ext-'));
    temps.push(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ permissions: ['storage', 'permissions'] }),
    );
    writeFileSync(join(dir, 'background.js'), '//');
    expect(manifestLooksValid(dir).ok).toBe(false);
  });

  // Needs `npm run package` first; a fresh checkout or worktree has no zip.
  it.skipIf(!existsSync(zipFixture))('unpacks the chrome zip to a load-ready folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-unpack-'));
    temps.push(dir);
    installExtensionFromZip(zipFixture, dir);
    expect(manifestLooksValid(dir).ok).toBe(true);
  });
});