// macOS, development only: keep one "Split Finder" in Spotlight, Launchpad and "Open With".
// Every `tauri build` leaves copies of the app that macOS registers as apps of their own: the bundle in
// src-tauri/target, the temporary /Volumes/dmg.* image the DMG is made from, and anything moved to the Trash.
// After some thirty builds the owner saw the app many times over (Nov 24). This unregisters every copy except
// /Applications/Split Finder.app and marks the build folders as not to be indexed. It deletes nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
export const KEEP = '/Applications/Split Finder.app';

/** The registered paths of every copy of the app, from `lsregister -dump` output. */
export function registeredCopies(dump) {
  const out = new Set();
  for (const line of dump.split('\n')) {
    const m = /^path:\s+(.*Split Finder[^/]*\.app) \(0x[0-9a-f]+\)$/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

export function tidy(root = process.cwd(), log = console.log) {
  if (process.platform !== 'darwin' || !existsSync(LSREGISTER)) return 0;
  // Spotlight skips a folder that holds this file.
  for (const dir of ['src-tauri/target', 'output']) {
    const d = join(root, dir);
    try {
      mkdirSync(d, { recursive: true });
      if (!existsSync(join(d, '.metadata_never_index'))) writeFileSync(join(d, '.metadata_never_index'), '');
    } catch {
      /* a folder that cannot be written is not worth failing a build for */
    }
  }
  let dump = '';
  try {
    dump = execFileSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch {
    return 0;
  }
  const stale = registeredCopies(dump).filter((p) => p !== KEEP);
  for (const p of stale) {
    try {
      execFileSync(LSREGISTER, ['-u', p], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  if (stale.length) log(`Unregistered ${stale.length} extra ${stale.length === 1 ? 'copy' : 'copies'} of Split Finder; ${KEEP} is the one macOS knows.`);
  return stale.length;
}

if (import.meta.url === `file://${process.argv[1]}`) tidy();
