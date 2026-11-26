// The release workflow's last step before publishing (.github/workflows/release.yml):
//   npx tsx scripts/release-latest-json.ts --version 0.2.0 --dir <folder with the release files> --out <folder>/latest.json
// Reads each platform's update file and its .sig from --dir (under the names in core/src/release/latestJson.ts ASSETS),
// checks every signature against the public key in src-tauri/tauri.conf.json and the version (the same checks the app
// makes before it installs), takes the notes from docs/release.json (which must name this version), and writes latest.json.
// Any problem: exit 1 and nothing written, so the release is not published. No network.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildLatestJson, PLATFORM_ASSET, type Platform } from '../core/src/release/latestJson';
import { parseReleaseNote } from '../core/src/release/note';
import { verifyUpdaterSignature } from './updater-signature';

const root = join(import.meta.dirname, '..');

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function fail(why: string): never {
  console.error(`latest.json was not written: ${why}`);
  process.exit(1);
}

const version = arg('--version');
const dir = arg('--dir');
const out = arg('--out');
if (!version || !dir || !out) fail('usage: --version x.y.z --dir <release files> --out <latest.json>');

const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')) as { version?: string; plugins?: { updater?: { pubkey?: string } } };
if (conf.version !== version) fail(`src-tauri/tauri.conf.json says ${conf.version}, the release is ${version}.`);
const pubkey = conf.plugins?.updater?.pubkey ?? '';
if (!pubkey) fail('src-tauri/tauri.conf.json has no updater public key. Run npm run updater:setup once and commit the file.');

const note = parseReleaseNote(readFileSync(join(root, 'docs', 'release.json'), 'utf8'))?.note;
if (!note) fail('docs/release.json is not a valid release note.');
if (note.version !== version) fail(`docs/release.json is for ${note.version}, the release is ${version}. Run npm run release:prepare.`);

const signatures = {} as Record<Platform, string>;
for (const [platform, name] of Object.entries(PLATFORM_ASSET) as [Platform, string][]) {
  let data: Buffer;
  let signature: string;
  try {
    data = readFileSync(join(dir, name));
    signature = readFileSync(join(dir, `${name}.sig`), 'utf8').trim();
  } catch {
    fail(`${name} or ${name}.sig is missing from ${dir}.`);
  }
  const checked = verifyUpdaterSignature({ pubkey, signature, data, version });
  if (!checked.ok) fail(`${name}: ${checked.why}.`);
  console.log(`${name}: signature checked against the app's public key, for ${version}.`);
  signatures[platform] = signature;
}

const built = buildLatestJson({ version, notes: note.notes, pubDate: new Date().toISOString(), signatures });
if (!built.ok) fail(built.problem);
writeFileSync(out, `${JSON.stringify(built.json, null, 2)}\n`);
console.log(`Wrote ${out} for ${version}.`);
