// npm run updater:setup [-- --force]
//
// Run once by the owner, in his own terminal, on his own Mac. It makes the key pair that signs every update, so that an
// installed Split Finder only installs files signed by it:
//   1. if ~/.tauri/split-finder-updater.key does not exist: `tauri signer generate --ci -w <that file>` (no password; the
//      file is readable by him only, mode 0600). An existing key is used as it is and never overwritten, unless --force.
//   2. stores the private key as the repository secret TAURI_SIGNING_PRIVATE_KEY with `gh secret set`, which reads it from
//      standard input (never from the command line, where other programs could see it);
//   3. writes the public key into src-tauri/tauri.conf.json (plugins.updater.pubkey), where the build and the app read it.
// It never prints the private key. No password is set: the key file is protected by his account (0600, FileVault), and
// GitHub keeps the secret encrypted; a password would be one more secret that, lost, ends updates as surely as the key.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REPO } from '../core/src/release/latestJson';
import { setPubkey } from '../core/src/release/pubkey';

const root = join(import.meta.dirname, '..');
const force = process.argv.includes('--force');
const keyDir = join(homedir(), '.tauri');
const keyFile = join(keyDir, 'split-finder-updater.key');
const pubFile = `${keyFile}.pub`;
// Tests point this at a copy (desktop/updater-setup.test.ts); the owner never sets it.
const confFile = process.env.SPLIT_FINDER_TAURI_CONF ?? join(root, 'src-tauri', 'tauri.conf.json');
const tauriBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');

function stop(why: string): never {
  console.error(`${why}\nNothing else was changed.`);
  process.exit(1);
}

/** Text from a program's output with the private key removed, should it ever appear there. */
function scrubbed(text: string, secret: string | null): string {
  const lines = secret ? secret.split(/\s+/).filter((s) => s.length >= 16) : [];
  let out = text;
  for (const s of lines) out = out.split(s).join('[private key]');
  return out.trim();
}

// gh first: without it nothing can be finished, so nothing is started.
const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
if (auth.error) stop('The GitHub command line tool (gh) is not installed. Install it (brew install gh), run gh auth login, then run this again.');
if (auth.status !== 0) stop('gh is not signed in to GitHub. Run gh auth login, then run this again.');

let made = false;
if (existsSync(keyFile) && !force) {
  console.log(`A signing key already exists at ${keyFile}. It is used as it is (run with --force to make a new one).`);
} else {
  if (existsSync(keyFile)) {
    console.log('Making a new key (--force). Copies of Split Finder that trust the old key will not install updates signed with the new one; they must be installed again by hand once.');
  }
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const gen = spawnSync(tauriBin, ['signer', 'generate', '--ci', '-w', keyFile, ...(force ? ['--force'] : [])], { encoding: 'utf8', env: { ...process.env, CI: 'true' } });
  if (gen.status !== 0 || !existsSync(keyFile) || !existsSync(pubFile)) {
    const secret = existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : null;
    stop(`Making the key failed: ${scrubbed(`${gen.stderr ?? ''}${gen.stdout ?? ''}`, secret) || gen.error?.message || 'no reason was given'}`);
  }
  made = true;
}
chmodSync(keyFile, 0o600);
if (!existsSync(pubFile)) stop(`The public key ${pubFile} is missing. Run this again with --force to make a new pair.`);

const privateKey = readFileSync(keyFile, 'utf8');
const publicKey = readFileSync(pubFile, 'utf8').trim();

const secret = spawnSync('gh', ['secret', 'set', 'TAURI_SIGNING_PRIVATE_KEY', '--repo', REPO], { input: privateKey, encoding: 'utf8' });
if (secret.status !== 0) {
  stop(`Storing the key on GitHub failed: ${scrubbed(`${secret.stderr ?? ''}${secret.stdout ?? ''}`, privateKey) || 'no reason was given'}\nThe key is kept at ${keyFile}; run this again when gh works.`);
}

const conf = readFileSync(confFile, 'utf8');
const next = setPubkey(conf, publicKey);
if (!next.ok) stop(`The public key could not be written: ${next.problem}`);
if (next.text !== conf) writeFileSync(confFile, next.text);

console.log(
  [
    made ? `Made a new signing key at ${keyFile} (only you can read it).` : null,
    `Stored the private key on GitHub as the secret TAURI_SIGNING_PRIVATE_KEY of ${REPO}. The release workflow signs with it.`,
    next.text !== conf ? 'Wrote the public key into src-tauri/tauri.conf.json. Commit that file: the app trusts only this key.' : 'src-tauri/tauri.conf.json already has this public key.',
    `Keep a copy of ${keyFile} somewhere safe, such as your password manager. If it is lost, installed copies of Split Finder can no longer be updated and must be installed again by hand.`,
  ]
    .filter(Boolean)
    .join('\n'),
);
