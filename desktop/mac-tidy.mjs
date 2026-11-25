// macOS, development only: keep one "Split Finder" in Spotlight, Launchpad and "Open With".
// Every `tauri build` leaves copies of the app that macOS registers as apps of their own: the bundle in
// src-tauri/target, the temporary /Volumes/dmg.* image the DMG is made from, and anything moved to the Trash.
// After some thirty builds the owner saw the app many times over (Nov 24). This unregisters every copy except
// /Applications/Split Finder.app, marks the build folders as not to be indexed, and renames the built bundle so it is
// no longer an app by name (the one thing it replaces is the previous build's renamed bundle).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
export const KEEP = '/Applications/Split Finder.app';
/** Where `tauri build` leaves the app, and where it is kept afterwards under a name macOS does not take for an app. */
export const BUILT_APP = 'src-tauri/target/release/bundle/macos/Split Finder.app';
export const STOWED_APP = 'src-tauri/target/release/bundle/macos/SplitFinder-built';

/**
 * The built bundle is a second "Split Finder" for as long as it sits in the build folder under its own name: Spotlight
 * and Launchpad showed two (Nov 24). Rename it, so the only thing on this Mac that is the app is the installed one.
 * The DMG beside it is already made by then; desktop:install reads the stowed copy. Returns the stowed path, or null
 * when nothing has been built.
 */
export function stowBuiltApp(root = process.cwd()) {
  const built = join(root, BUILT_APP);
  const stowed = join(root, STOWED_APP);
  if (existsSync(built)) {
    // The last build's stowed copy is replaced: a build output, made again by every build.
    rmSync(stowed, { recursive: true, force: true });
    renameSync(built, stowed);
  }
  return existsSync(stowed) ? stowed : null;
}

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
  try {
    stowBuiltApp(root);
  } catch {
    /* a bundle that cannot be renamed is unregistered below instead */
  }
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
