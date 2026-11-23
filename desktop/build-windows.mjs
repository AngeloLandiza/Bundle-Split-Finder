// npm run desktop:build:windows: the Windows x64 NSIS installer. On a Mac (or Linux) it cross-compiles as Tauri's
// guide does (https://v2.tauri.app/distribute/windows-installer/, "Build Windows apps on Linux and macOS"):
// cargo-xwin with the MSVC target, LLVM's clang-cl/lld-link, and NSIS's makensis. On Windows it is a plain build.
// The sidecar comes from beforeBuildCommand (desktop/bundle-agent.ts reads TAURI_ENV_TARGET_TRIPLE).
//
// Output: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Split Finder_<version>_x64-setup.exe
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const TARGET = 'x86_64-pc-windows-msvc';
const windows = process.platform === 'win32';
const env = { ...process.env };

if (!windows) {
  // Homebrew's llvm and lld are keg-only: put their bin folders first so cargo-xwin finds clang-cl, llvm-lib, lld-link.
  const kegs = ['/opt/homebrew/opt/llvm/bin', '/opt/homebrew/opt/lld/bin', '/usr/local/opt/llvm/bin', '/usr/local/opt/lld/bin'];
  env.PATH = [...kegs.filter((k) => existsSync(k)), env.PATH].join(delimiter);
  const missing = ['clang-cl', 'lld-link', 'llvm-lib', 'makensis', 'cargo-xwin'].filter(
    (tool) => !env.PATH.split(delimiter).some((dir) => existsSync(join(dir, tool))),
  );
  if (missing.length) {
    console.error(
      `Missing ${missing.join(', ')}. Install once:\n` +
        '  rustup target add x86_64-pc-windows-msvc\n' +
        '  cargo install --locked cargo-xwin\n' +
        '  brew install nsis llvm lld',
    );
    process.exit(1);
  }
}

const args = ['tauri', 'build', '--target', TARGET, ...(windows ? [] : ['--runner', 'cargo-xwin'])];
const r = spawnSync('npx', args, { stdio: 'inherit', env, shell: windows });
process.exit(r.status ?? 1);
