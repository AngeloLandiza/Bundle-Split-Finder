// Builds src-tauri/binaries/agent-dashboard-<triple>[.exe] for the Tauri bundle as a Node Single Executable
// Application (https://nodejs.org/api/single-executable-applications.html), so the sidecar has the same runtime
// APIs (AbortSignal.any, Node 20+) the agent is tested on.
//
// The target is Tauri's (TAURI_ENV_TARGET_TRIPLE, set for beforeBuildCommand), or `--target <triple>`, or this Mac:
//   aarch64-apple-darwin / x86_64-apple-darwin  the Node running this script, re-signed ad hoc (macOS only).
//   x86_64-pc-windows-msvc                      the official Node win-x64 build, from nodejs.org only, checked against
//                                               the release's SHASUMS256.txt and the hash pinned below, cached in
//                                               desktop/node-cache/. Built on any OS (the blob is portable: no code
//                                               cache, no snapshot), but by the same Node version as the binary.
// Needs `npx postject` (npm) the first time; nothing else touches the network.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

import { runTool } from '../scripts/spawn-tool';
import { stripAuthenticode } from './pe';

const root = join(import.meta.dirname, '..');
const outJs = join(root, 'desktop', 'dist', 'agent-server.cjs');
const binDir = join(root, 'src-tauri', 'binaries');

/** The Node the Windows sidecar is built from. The SEA blob must be made by this same version. */
const NODE_VERSION = 'v24.13.0';
const WIN_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
/** From https://nodejs.org/dist/v24.13.0/SHASUMS256.txt; the downloaded list must say the same. */
const WIN_ZIP_SHA256 = 'ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88';
const DIST = `https://nodejs.org/dist/${NODE_VERSION}/`;
const cacheDir = join(root, 'desktop', 'node-cache');

const WINDOWS = 'x86_64-pc-windows-msvc';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function targetTriple(): string {
  const i = process.argv.indexOf('--target');
  const fromArg = i >= 0 ? process.argv[i + 1] : undefined;
  const t = fromArg ?? process.env.TAURI_ENV_TARGET_TRIPLE;
  if (t) return t;
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (process.platform === 'win32' && process.arch === 'x64') return WINDOWS;
  throw new Error(`No sidecar target for ${process.platform}/${process.arch}; pass --target.`);
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

async function download(url: string): Promise<Buffer> {
  if (!url.startsWith(DIST)) throw new Error(`refusing to download from outside ${DIST}`);
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The official node.exe, verified, from the cache or nodejs.org. */
async function windowsNode(): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const exe = join(cacheDir, `node-${NODE_VERSION}-win-x64.exe`);
  const zip = join(cacheDir, WIN_ZIP);
  if (!existsSync(zip) || sha256(readFileSync(zip)) !== WIN_ZIP_SHA256) {
    const sums = (await download(`${DIST}SHASUMS256.txt`)).toString('utf8');
    const listed = sums
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find((parts) => parts[1] === WIN_ZIP)?.[0];
    if (listed !== WIN_ZIP_SHA256) {
      throw new Error(`SHASUMS256.txt lists ${listed ?? 'nothing'} for ${WIN_ZIP}, not the pinned ${WIN_ZIP_SHA256}.`);
    }
    console.log(`Downloading ${DIST}${WIN_ZIP}`);
    const bytes = await download(`${DIST}${WIN_ZIP}`);
    const got = sha256(bytes);
    if (got !== WIN_ZIP_SHA256) throw new Error(`${WIN_ZIP}: SHA-256 ${got} does not match ${WIN_ZIP_SHA256}.`);
    writeFileSync(`${zip}.part`, bytes);
    renameSync(`${zip}.part`, zip);
    rmSync(exe, { force: true });
  }
  if (!existsSync(exe)) {
    const out = mkdtempSync(join(tmpdir(), 'split-finder-node-'));
    const member = `node-${NODE_VERSION}-win-x64/node.exe`;
    if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', out, member], { stdio: 'inherit' });
    else execFileSync('unzip', ['-q', '-o', zip, member, '-d', out], { stdio: 'inherit' });
    copyFileSync(join(out, member), exe);
    rmSync(out, { recursive: true, force: true });
  }
  return exe;
}

async function main(): Promise<void> {
  const triple = targetTriple();
  const windows = triple === WINDOWS;
  if (!windows && !triple.endsWith('-apple-darwin')) throw new Error(`The sidecar build does not know ${triple}.`);
  if (!windows && process.platform !== 'darwin') throw new Error('A macOS sidecar is built on macOS (codesign).');
  if (!windows && triple !== (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')) {
    throw new Error(`A macOS sidecar is this Mac's own Node; it cannot be ${triple}.`);
  }
  if (windows && process.version !== NODE_VERSION) {
    throw new Error(`The Windows sidecar is Node ${NODE_VERSION}; its blob must be made by the same version, and this is ${process.version}.`);
  }

  rmSync(outJs, { force: true });
  mkdirSync(binDir, { recursive: true });

  runTool('npx', ['vite', 'build', '--config', 'desktop-ui/vite.config.ts'], { cwd: root, stdio: 'inherit' });

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

  const outBin = join(binDir, `agent-dashboard-${triple}${windows ? '.exe' : ''}`);
  // Outside desktop/dist: that folder is Tauri's frontendDist and must not carry the blob.
  const seaDir = mkdtempSync(join(tmpdir(), 'split-finder-sea-'));
  const seaConfig = join(seaDir, 'sea-config.json');
  const blob = join(seaDir, 'agent.blob');

  rmSync(outBin, { force: true });

  writeFileSync(
    seaConfig,
    JSON.stringify({ main: outJs, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: root, stdio: 'inherit' });

  const postject = (extra: string[]) =>
    runTool('npx', ['--yes', 'postject', outBin, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SENTINEL, ...extra], { cwd: root, stdio: 'inherit' });

  if (windows) {
    // Unsigned: the injected file would not match node.exe's signature anyway (docs/decisions.md, Windows).
    const { bytes, stripped } = stripAuthenticode(readFileSync(await windowsNode()));
    writeFileSync(outBin, bytes);
    if (!stripped) console.log('node.exe carried no signature to remove.');
    postject([]);
  } else {
    copyFileSync(process.execPath, outBin);
    execFileSync('codesign', ['--remove-signature', outBin], { stdio: 'inherit' });
    postject(['--macho-segment-name', 'NODE_SEA']);
    execFileSync('codesign', ['--sign', '-', outBin], { stdio: 'inherit' });
  }

  rmSync(seaDir, { recursive: true, force: true });
  console.log(`\nAgent sidecar (Node ${windows ? NODE_VERSION : process.version}, ${triple}): ${outBin}`);
}

await main();
