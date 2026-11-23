// Builds src-tauri/binaries/agent-dashboard-<triple> for the Tauri bundle. No network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
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
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
});

const targets: Record<string, string> = {
  arm64: 'node18-macos-arm64',
  x64: 'node18-macos-x64',
};

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const outBin = join(binDir, `agent-dashboard-${triple}`);

rmSync(outBin, { force: true });

execFileSync(
  'npx',
  ['pkg', outJs, '--targets', targets[arch]!, '--output', outBin, '--compress', 'GZip'],
  { cwd: root, stdio: 'inherit' },
);

console.log(`\nAgent sidecar: ${outBin}`);