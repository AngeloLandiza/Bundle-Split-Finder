import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error a plain .mjs build tool
import { BUILT_APP, KEEP, STOWED_APP, registeredCopies, stowBuiltApp } from './mac-tidy.mjs';

// Lines as `lsregister -dump` printed them on the owner's Mac (Nov 24), where the app showed many times over.
const DUMP = [
  'path:                       /Users/someone/Developer/GitHub/Bundle-Split-Finder/src-tauri/target/release/bundle/macos/Split Finder.app (0x1a75c)',
  'path:                       /Users/someone/.Trash/Split Finder 1.04.37 PM.app (0x19c9c)',
  'path:                       /Volumes/dmg.umNJMW/Split Finder.app (0x19944)',
  'path:                       /Volumes/dmg.umNJMW/Split Finder.app (0x19945)',
  'path:                       /Applications/Split Finder.app (0x1a828)',
  'path:                       /Applications/Safari.app (0x100)',
  'name:                       Split Finder',
].join('\n');

describe('mac-tidy', () => {
  it('finds every registered copy once, and only the app', () => {
    const all = registeredCopies(DUMP);
    expect(all).toHaveLength(4);
    expect(all).toContain(KEEP);
    expect(all.filter((p: string) => p !== KEEP)).toEqual([
      '/Users/someone/Developer/GitHub/Bundle-Split-Finder/src-tauri/target/release/bundle/macos/Split Finder.app',
      '/Users/someone/.Trash/Split Finder 1.04.37 PM.app',
      '/Volumes/dmg.umNJMW/Split Finder.app',
    ]);
  });

  it('renames the built bundle so the build folder holds no second app, and a new build replaces the stowed one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tidy-'));
    expect(stowBuiltApp(root)).toBeNull();
    const build = (mark: string) => {
      mkdirSync(join(root, BUILT_APP, 'Contents'), { recursive: true });
      writeFileSync(join(root, BUILT_APP, 'Contents', 'Info.plist'), mark);
    };
    build('first');
    expect(stowBuiltApp(root)).toBe(join(root, STOWED_APP));
    expect(existsSync(join(root, BUILT_APP))).toBe(false);
    expect(STOWED_APP.endsWith('.app')).toBe(false);
    build('second');
    stowBuiltApp(root);
    expect(readFileSync(join(root, STOWED_APP, 'Contents', 'Info.plist'), 'utf8')).toBe('second');
    expect(existsSync(join(root, BUILT_APP))).toBe(false);
    // With nothing new built, the stowed copy stays where desktop:install reads it.
    expect(stowBuiltApp(root)).toBe(join(root, STOWED_APP));
  });
});
