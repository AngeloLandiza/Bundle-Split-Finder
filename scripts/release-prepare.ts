// npm run release:prepare -- 0.2.0 --note "What changed, one line" [--note "…"] [--url <https link>] [--date YYYY-MM-DD]
//
// Gets a release ready on this machine and prints the git commands that make it. It changes the app's version in every
// file that names it (core/src/release/bump.ts) and writes docs/release.json (core/src/release/note.ts, the same checks
// `npm run release:note` makes): its notes become the release's "What changed" in the app, and installs of 0.1.0 (which
// cannot update themselves) read it from main to learn of the new version. It does not commit, tag or push: the developer
// does, in the order printed. No network.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bumpVersion, VERSION_FILES, type VersionFile } from '../core/src/release/bump';
import { LEGACY_DOWNLOAD_URL as DEFAULT_DOWNLOAD } from '../core/src/release/latestJson';
import { nextReleaseNote, parseReleaseNote } from '../core/src/release/note';

const root = process.env.SPLIT_FINDER_RELEASE_ROOT ?? join(import.meta.dirname, '..');

function parse(argv: string[]): { version: string; notes: string[]; url: string; date: string } | string {
  const [version, ...rest] = argv;
  if (!version || version.startsWith('--')) return 'Give the new version first, for example: npm run release:prepare -- 0.2.0 --note "…"';
  const out = { version: version.replace(/^v/, ''), notes: [] as string[], url: DEFAULT_DOWNLOAD, date: new Date().toLocaleDateString('en-CA') };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) return `${flag} needs a value.`;
    if (flag === '--note') out.notes.push(value);
    else if (flag === '--url') out.url = value;
    else if (flag === '--date') out.date = value;
    else return `Unknown option ${flag}.`;
  }
  if (out.notes.length === 0) return 'Give at least one --note: one line on what changed, in plain words.';
  return out;
}

const input = parse(process.argv.slice(2));
if (typeof input === 'string') {
  console.error(input);
  process.exit(1);
}

const files = Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(root, f), 'utf8')])) as Record<VersionFile, string>;
const bumped = bumpVersion(files, input.version);
if (!bumped.ok) {
  console.error(`Nothing was changed. ${bumped.problem}`);
  process.exit(1);
}

const notePath = join(root, 'docs', 'release.json');
let current: { version: string } | null = null;
try {
  current = parseReleaseNote(readFileSync(notePath, 'utf8'))?.note ?? null;
} catch {
  current = null;
}
const note = nextReleaseNote(current, { version: input.version, url: input.url, notes: input.notes, date: input.date });
if (!note.ok) {
  console.error(`Nothing was changed. ${note.problem}`);
  process.exit(1);
}

// Every check has passed: now write, all at once.
for (const f of VERSION_FILES) writeFileSync(join(root, f), bumped.files[f]);
writeFileSync(notePath, `${JSON.stringify(note.note, null, 2)}\n`);

const v = input.version;
console.log(`Changed the version from ${bumped.from} to ${v} in ${VERSION_FILES.join(', ')}, and wrote docs/release.json.

Next, in this order:

  npm run typecheck && npm test
  git add ${VERSION_FILES.join(' ')} docs/release.json
  git commit -m "release: ${v}"
  git tag v${v}
  git push origin v${v}

Pushing the tag starts the release workflow on GitHub (Actions, "release"). It builds Windows and Mac, runs the Windows
smoke test, signs the update files and publishes release v${v}. When it has finished and the release is on GitHub:

  git push origin main

Pushing main last matters: installs of 0.1.0 read docs/release.json from main, and should not hear of ${v} before
its release exists. Installs of newer versions update themselves from the release.`);
