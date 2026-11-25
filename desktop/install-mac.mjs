// macOS, development only: put the built app in /Applications in place, with no copy left in the Trash.
// npm run desktop:install (after npm run desktop:build). Quits the running app, syncs the bundle over the
// installed one, tidies macOS's list of apps (mac-tidy.mjs) and opens it again in the background.
import { execFileSync, spawnSync } from 'node:child_process';
import { KEEP, stowBuiltApp, tidy } from './mac-tidy.mjs';

if (process.platform !== 'darwin') {
  console.log('desktop:install is for macOS.');
  process.exit(0);
}
const built = stowBuiltApp();
if (!built) {
  console.error('No built app. Run npm run desktop:build first.');
  process.exit(1);
}
spawnSync('osascript', ['-e', 'tell application "Split Finder" to quit'], { stdio: 'ignore' });
// Wait for the agent to let go of its port (it holds the store lock until then).
for (let i = 0; i < 40; i++) {
  if (spawnSync('lsof', ['-nP', '-iTCP:8790', '-sTCP:LISTEN'], { stdio: 'ignore' }).status !== 0) break;
  spawnSync('sleep', ['0.5']);
}
// In place: files that are gone from the new build are removed from the installed one, nothing goes to the Trash.
execFileSync('rsync', ['-a', '--delete', `${built}/`, `${KEEP}/`], { stdio: 'inherit' });
tidy();
spawnSync('open', ['-g', '-a', KEEP], { stdio: 'ignore' });
console.log(`Installed ${KEEP}.`);
