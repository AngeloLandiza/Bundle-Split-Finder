// P1: guided browser-helper install (Lane D). No network.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INVALID_PERMISSION = 'permissions';

export function extensionInstallDir(): string {
  return process.env.SPLIT_FINDER_EXTENSION_DIR ?? join(homedir(), 'Documents', 'split-finder');
}

export function extensionZipSource(): string | null {
  const fromEnv = process.env.SPLIT_FINDER_EXTENSION_ZIP;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const out = join(process.cwd(), 'output');
  if (!existsSync(out)) return null;
  const zips = readdirSync(out).filter((f) => f.endsWith('-chrome.zip'));
  if (zips.length === 1) return join(out, zips[0]!);
  return null;
}

export function manifestLooksValid(dir: string): { ok: boolean; message: string } {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    return { ok: false, message: 'manifest.json is missing in the install folder.' };
  }
  if (!existsSync(join(dir, 'background.js'))) {
    return { ok: false, message: 'background.js is missing. Load the folder that contains both files, not the zip.' };
  }
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { permissions?: string[] };
    if (manifest.permissions?.includes(INVALID_PERMISSION)) {
      return {
        ok: false,
        message: 'This copy is outdated (invalid permissions). Use Install helper again or rebuild from the app.',
      };
    }
  } catch {
    return { ok: false, message: 'manifest.json could not be read.' };
  }
  return { ok: true, message: 'Ready for Load unpacked in Chrome.' };
}

export function installExtensionFromZip(zipPath: string, destDir: string): void {
  if (!existsSync(zipPath)) throw new Error('Extension zip not found.');
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir]);
  const inner = readdirSync(destDir)
    .map((name) => join(destDir, name))
    .find((p) => existsSync(join(p, 'manifest.json')));
  if (inner && inner !== destDir) {
    for (const name of readdirSync(inner)) {
      cpSync(join(inner, name), join(destDir, name), { recursive: true });
    }
    rmSync(inner, { recursive: true, force: true });
  }
  const check = manifestLooksValid(destDir);
  if (!check.ok) throw new Error(check.message);
}

export type SetupStatus = {
  extensionDir: string;
  extensionReady: boolean;
  extensionMessage: string;
  zipAvailable: boolean;
  lane: 'D';
};

export function setupStatus(): SetupStatus {
  const extensionDir = extensionInstallDir();
  const manifest = manifestLooksValid(extensionDir);
  return {
    extensionDir,
    extensionReady: manifest.ok,
    extensionMessage: manifest.message,
    zipAvailable: extensionZipSource() !== null,
    lane: 'D',
  };
}