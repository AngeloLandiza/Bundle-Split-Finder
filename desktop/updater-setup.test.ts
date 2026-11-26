// npm run updater:setup, run for real against a temporary HOME, a copy of tauri.conf.json and a fake `gh` on PATH: the
// real `tauri signer generate` makes a throwaway key, and nothing reaches GitHub or the owner's home folder.
// macOS and Linux only (the fake gh is a shell script); the owner runs the setup on his Mac.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { pubkeyOf } from '../core/src/release/pubkey';

const root = join(import.meta.dirname, '..');
// The config the tests copy is the real one, which holds the project's public key once the owner has run the setup: a run
// that must change nothing leaves that key as it was (it was '' before Nov 25).
const UNCHANGED = pubkeyOf(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const script = join(root, 'scripts', 'updater-setup.ts');

/** A fake gh: `auth status` answers as told; `secret set` records its arguments and what it read on stdin. */
function fakeGh(dir: string, o: { signedIn?: boolean; secretFails?: boolean } = {}): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "auth" ]; then exit ${o.signedIn === false ? 1 : 0}; fi
if [ "$1" = "secret" ]; then
  echo "$@" > "${dir}/gh-args"
  cat > "${dir}/gh-stdin"
  ${o.secretFails ? 'echo "HTTP 403: Resource not accessible" >&2; exit 1' : 'exit 0'}
fi
exit 2
`,
  );
  chmodSync(gh, 0o755);
  return bin;
}

function setup(o: { signedIn?: boolean; secretFails?: boolean; noGh?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-updater-setup-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const conf = join(dir, 'tauri.conf.json');
  copyFileSync(join(root, 'src-tauri', 'tauri.conf.json'), conf);
  const base = [dirname(process.execPath), '/usr/bin', '/bin'];
  const path = (o.noGh ? base : [fakeGh(dir, o), ...base]).join(':');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: root,
      env: { HOME: home, PATH: path, SPLIT_FINDER_TAURI_CONF: conf, TMPDIR: tmpdir() },
      encoding: 'utf8',
    });
  const key = join(home, '.tauri', 'split-finder-updater.key');
  return { dir, home, conf, key, run };
}

describe.skipIf(process.platform === 'win32')('npm run updater:setup', () => {
  it('makes a key only he can read, gives it to gh on stdin, writes the public key, and never prints the private key', () => {
    const s = setup();
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(s.key).mode & 0o777).toBe(0o600);
    const privateKey = readFileSync(s.key, 'utf8');
    const publicKey = readFileSync(`${s.key}.pub`, 'utf8').trim();
    // gh read the key from stdin; the command line names only the secret and the repository.
    expect(readFileSync(join(s.dir, 'gh-stdin'), 'utf8')).toBe(privateKey);
    expect(readFileSync(join(s.dir, 'gh-args'), 'utf8').trim()).toBe('secret set TAURI_SIGNING_PRIVATE_KEY --repo AngeloLandiza/Bundle-Split-Finder');
    expect(pubkeyOf(readFileSync(s.conf, 'utf8'))).toBe(publicKey);
    const said = `${r.stdout}${r.stderr}`;
    expect(said).not.toContain(privateKey.trim());
    expect(said).not.toContain(Buffer.from(privateKey.trim(), 'base64').toString('utf8').split('\n')[1]);
    expect(r.stdout).toContain('Made a new signing key');
    expect(r.stdout).toContain('Commit that file');
  }, 60_000);

  it('a second run keeps the key; --force makes a new one', () => {
    const s = setup();
    expect(s.run().status).toBe(0);
    const first = readFileSync(s.key, 'utf8');
    const again = s.run();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already exists');
    expect(again.stdout).toContain('already has this public key');
    expect(readFileSync(s.key, 'utf8')).toBe(first);
    const forced = s.run('--force');
    expect(forced.status, forced.stderr).toBe(0);
    expect(readFileSync(s.key, 'utf8')).not.toBe(first);
    expect(pubkeyOf(readFileSync(s.conf, 'utf8'))).toBe(readFileSync(`${s.key}.pub`, 'utf8').trim());
  }, 60_000);

  it('without gh, or gh not signed in, makes nothing', () => {
    for (const o of [{ noGh: true }, { signedIn: false }]) {
      const s = setup(o);
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/gh/);
      expect(existsSync(s.key)).toBe(false);
      expect(pubkeyOf(readFileSync(s.conf, 'utf8'))).toBe(UNCHANGED);
    }
  }, 60_000);

  it('when GitHub refuses the secret, keeps the key, writes no public key, and says what to do', () => {
    const s = setup({ secretFails: true });
    const r = s.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Storing the key on GitHub failed: HTTP 403');
    expect(r.stderr).toContain('run this again');
    expect(existsSync(s.key)).toBe(true);
    expect(pubkeyOf(readFileSync(s.conf, 'utf8'))).toBe(UNCHANGED);
  }, 60_000);
});
