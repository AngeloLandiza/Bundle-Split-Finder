// Builds src-tauri/binaries/agent-dashboard-<triple> for the Tauri bundle as a Node Single Executable
// Application (https://nodejs.org/api/single-executable-applications.html) from the Node running this
// script, so the sidecar has the same runtime APIs (AbortSignal.any, Node 20+) the agent is tested on.
// Needs `npx postject` (npm) the first time; nothing else touches the network.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const root = join(import.meta.dirname, '..');
const outJs = join(root, 'desktop', 'dist', 'agent-server.cjs');
const binDir = join(root, 'src-tauri', 'binaries');

rmSync(outJs, { force: true });
mkdirSync(binDir, { recursive: true });

execFileSync('npx', ['vite', 'build', '--config', 'desktop-ui/vite.config.ts'], { cwd: root, stdio: 'inherit' });

esbuild.buildSync({
  entryPoints: [join(root, 'desktop', 'agent-entry.ts')],
  outfile: outJs,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  logLevel: 'info',
});

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const outBin = join(binDir, `agent-dashboard-${triple}`);
// Outside desktop/dist: that folder is Tauri's frontendDist and must not carry the blob.
const seaDir = mkdtempSync(join(tmpdir(), 'split-finder-sea-'));
const seaConfig = join(seaDir, 'sea-config.json');
const blob = join(seaDir, 'agent.blob');

if (process.platform !== 'darwin') throw new Error('The sidecar build is macOS only for now.');

rmSync(outBin, { force: true });

writeFileSync(
  seaConfig,
  JSON.stringify(
    { main: outJs, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: root, stdio: 'inherit' });

copyFileSync(process.execPath, outBin);
execFileSync('codesign', ['--remove-signature', outBin], { stdio: 'inherit' });
execFileSync(
  'npx',
  [
    '--yes',
    'postject',
    outBin,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--macho-segment-name',
    'NODE_SEA',
  ],
  { cwd: root, stdio: 'inherit' },
);
execFileSync('codesign', ['--sign', '-', outBin], { stdio: 'inherit' });

rmSync(seaDir, { recursive: true, force: true });
console.log(`\nAgent sidecar (Node ${process.version}): ${outBin}`);
