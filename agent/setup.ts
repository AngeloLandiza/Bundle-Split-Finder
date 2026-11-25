// P1: guided browser-helper install (Lane D). No network.
import { execFileSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

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

/**
 * How the zip is unpacked: unzip on macOS and Linux; on Windows the tar.exe that ships in System32 since Windows 10
 * 1803 (bsdtar, which reads zip files). By its full path, so a GNU tar earlier on PATH (Git for Windows) is not used.
 */
export function unzipCommand(
  zipPath: string,
  destDir: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): [string, string[]] {
  if (platform === 'win32') return [win32.join(systemRoot, 'System32', 'tar.exe'), ['-xf', zipPath, '-C', destDir]];
  return ['unzip', ['-q', '-o', zipPath, '-d', destDir]];
}

export function installExtensionFromZip(zipPath: string, destDir: string): void {
  if (!existsSync(zipPath)) throw new Error('Extension zip not found.');
  rmSync(destDir, { recursive: true, force: true });
  unpackZipInto(zipPath, destDir);
}

/** The zip's files into `destDir` (made if missing), one folder level flattened; throws when the result is not a load-ready helper. */
export function unpackZipInto(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const [file, args] = unzipCommand(zipPath, destDir);
  execFileSync(file, args, { windowsHide: true });
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
// ---------------------------------------------------------------- the helper build the app ships (Nov 23)

/**
 * One file of a zip, as text, found by its name (the entry named `name`, or the shortest entry ending with `/name`), or
 * null when the zip has none or cannot be read. Reads the central directory at the end of the file; stored and deflated
 * entries only (what `wxt zip` writes). Never runs a program.
 */
export function zipEntryText(zipPath: string, name: string, maxBytes = 1024 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(zipPath, 'r');
    const size = fstatSync(fd).size;
    const read = (at: number, length: number): Buffer => {
      const b = Buffer.alloc(length);
      const got = readSync(fd!, b, 0, length, at);
      return b.subarray(0, got);
    };
    // The end of central directory record: 22 bytes, plus a comment of at most 65535.
    const tailLength = Math.min(size, 22 + 65_535);
    const tail = read(size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirAt = tail.readUInt32LE(eocd + 16);
    const dir = read(dirAt, dirSize);
    let best: { method: number; compressed: number; local: number; name: string } | null = null;
    for (let p = 0, n = 0; n < count && p + 46 <= dir.length; n++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) return null;
      const nameLength = dir.readUInt16LE(p + 28);
      const entry = {
        method: dir.readUInt16LE(p + 10), compressed: dir.readUInt32LE(p + 20), local: dir.readUInt32LE(p + 42),
        name: dir.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
      };
      if ((entry.name === name || entry.name.endsWith(`/${name}`)) && (!best || entry.name.length < best.name.length)) best = entry;
      p += 46 + nameLength + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    if (!best || best.compressed > maxBytes) return null;
    const local = read(best.local, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return null;
    const data = read(best.local + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), best.compressed);
    if (best.method === 0) return data.toString('utf8');
    if (best.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes }).toString('utf8');
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A helper build as its manifest names it: version_name ("0.1.0+3c92cc7"), else version. Null when neither is text. */
export function manifestBuild(manifestText: string | null): string | null {
  if (manifestText === null) return null;
  try {
    const m = JSON.parse(manifestText) as { version_name?: unknown; version?: unknown };
    const v = typeof m.version_name === 'string' && m.version_name.trim() !== '' ? m.version_name : m.version;
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Nov 23: the build of the helper zip this app ships (extensionZipSource), from its manifest; null without one. */
export function shippedHelperVersion(zip: string | null = extensionZipSource()): string | null {
  return zip === null ? null : manifestBuild(zipEntryText(zip, 'manifest.json'));
}
