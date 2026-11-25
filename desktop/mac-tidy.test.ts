import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs build tool
import { KEEP, registeredCopies } from './mac-tidy.mjs';

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
});
