// npm run release:note -- --version 0.1.1 --url <https link> --note "…" [--note "…"] [--date YYYY-MM-DD]
// Validates and writes docs/release.json: the file the app reads once a day to announce a new version. It only writes the
// file; committing and pushing stay with the developer. No network.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { nextReleaseNote, parseReleaseNote } from '../core/src/release/note';

const file = join(import.meta.dirname, '..', 'docs', 'release.json');

function args(argv: string[]): { version: string; url: string; notes: string[]; date: string } | string {
  const out = { version: '', url: '', notes: [] as string[], date: new Date().toLocaleDateString('en-CA') };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) return `${flag} needs a value.`;
    if (flag === '--version') out.version = value;
    else if (flag === '--url') out.url = value;
    else if (flag === '--note') out.notes.push(value);
    else if (flag === '--date') out.date = value;
    else return `Unknown option ${flag}.`;
  }
  if (!out.version || !out.url || out.notes.length === 0) return 'Needs --version, --url and at least one --note.';
  return out;
}

const input = args(process.argv.slice(2));
if (typeof input === 'string') {
  console.error(`${input}\nUsage: npm run release:note -- --version 0.1.1 --url <https link> --note "…" [--note "…"]`);
  process.exit(1);
}
let current: { version: string } | null = null;
try {
  current = parseReleaseNote(readFileSync(file, 'utf8'))?.note ?? null;
} catch {
  current = null;
}
const result = nextReleaseNote(current, input);
if (!result.ok) {
  console.error(result.problem);
  process.exit(1);
}
writeFileSync(file, `${JSON.stringify(result.note, null, 2)}\n`);
console.log(`Wrote docs/release.json for ${result.note.version}. Commit and push it to announce the version.`);
