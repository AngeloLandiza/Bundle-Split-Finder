// Starts the Node agent before `tauri dev` (background, same repo root).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'agent:dashboard'], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env },
});
child.unref();
console.log('Agent dashboard starting on http://127.0.0.1:8790');