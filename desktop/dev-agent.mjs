// Starts the Node agent before `tauri dev` (background, same repo root). Its data folder is the one the shell reads
// (Tauri's app_data_dir for identifier com.bundlesplitfinder.desktop, src-tauri/src/agent.rs data_dir), so the shell
// finds the agent's token and both see the same store. SPLIT_FINDER_DATA_DIR set by hand still wins.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { connect } from 'node:net';
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

const PORT = Number(process.env.AGENT_PORT ?? 8790);

/** True when something already listens on the agent's port (127.0.0.1 only). */
const listening = () =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.SPLIT_FINDER_DATA_DIR ?? appDataDir();

if (await listening()) {
  console.log(`An agent already answers on http://127.0.0.1:${PORT}; using it.`);
} else {
  mkdirSync(dataDir, { recursive: true });
  // The agent serves the UI built into desktop/dist/ui (npm run desktop:build-ui), from this repo root.
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'agent:dashboard'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SPLIT_FINDER_DATA_DIR: dataDir },
  });
  child.unref();
  // `tauri dev` waits for the dev URL to answer, so wait here until the agent does.
  for (let i = 0; i < 60 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 500));
  console.log(`Agent running on http://127.0.0.1:${PORT} (data in ${dataDir}); it keeps running after the app closes.`);
}
