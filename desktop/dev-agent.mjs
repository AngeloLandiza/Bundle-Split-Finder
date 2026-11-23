// Starts the Node agent before `tauri dev` (background, same repo root). Its data folder is the one the shell reads
// (Tauri's app_data_dir for identifier com.bundlesplitfinder.desktop, src-tauri/src/agent.rs data_dir), so the shell
// finds the agent's token and both see the same store. SPLIT_FINDER_DATA_DIR set by hand still wins.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDENTIFIER = 'com.bundlesplitfinder.desktop';

/** Tauri 2's app_data_dir: the platform's data directory joined with the bundle identifier. */
function appDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', IDENTIFIER);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), IDENTIFIER);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), IDENTIFIER);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.SPLIT_FINDER_DATA_DIR ?? appDataDir();
mkdirSync(dataDir, { recursive: true });
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'agent:dashboard'], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, SPLIT_FINDER_DATA_DIR: dataDir },
});
child.unref();
console.log(`Agent starting on http://127.0.0.1:8790 (data in ${dataDir})`);
