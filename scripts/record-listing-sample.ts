// npx tsx scripts/record-listing-sample.ts <app data folder> [--out <file>]. Free, no network, reads no key store: takes
// the newest scan in <folder>/store/activity.json whose Home Depot bundle lists carry a sample (a list whose state held
// entries but no product we read: RunRecord.bundleLists[].sample, fix round 2 of the free scan) and writes the lists and
// their samples to fixtures/homedepot-pages/listing-sample-<date>.json, so the real shape is read from a fixture, never
// guessed. Prints what it wrote, or why nothing was written.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord } from '../core/src/api/contract';
import { readStoreFile } from './data-folder';
import { ROOT } from './node-store';

export function latestSample(runs: readonly RunRecord[]): { run: RunRecord; lists: NonNullable<RunRecord['bundleLists']> } | null {
  const sorted = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  for (const run of sorted) {
    if (run.kind !== 'scan' || !run.bundleLists?.some((l) => l.sample)) continue;
    return { run, lists: run.bundleLists };
  }
  return null;
}

function main(argv: string[]): void {
  const dir = argv[0];
  if (!dir || dir.startsWith('--')) {
    console.error('Usage: npx tsx scripts/record-listing-sample.ts <app data folder> [--out <file>]');
    process.exitCode = 1;
    return;
  }
  const at = argv.indexOf('--out');
  const activity = readStoreFile<{ runs?: RunRecord[] }>(dir, 'activity.json', {});
  const found = latestSample(activity.runs ?? []);
  if (!found) {
    console.log('No scan in this folder recorded a bundle list sample (every list read had products, or none was read).');
    return;
  }
  const day = (found.run.finishedAt ?? found.run.startedAt).slice(0, 10);
  const out = at >= 0 && argv[at + 1] ? argv[at + 1]! : join(ROOT, 'fixtures', 'homedepot-pages', `listing-sample-${day}.json`);
  const file = {
    recordedAt: found.run.finishedAt ?? found.run.startedAt,
    source: `The helper's bundleListing answers in the owner's Chrome, scan ${found.run.id}: per list its totalProducts, pages read and products found; for a list whose state held no product we read, a slim sample of that state (key kinds with counts; the first entry of the 3 largest kinds as JSON, at most 1,500 characters, credential-named fields dropped).`,
    lists: found.lists,
  };
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Wrote ${out}: ${found.lists.length} lists, ${found.lists.filter((l) => l.sample).length} with a sample.`);
}

if (process.argv[1]?.endsWith('record-listing-sample.ts')) main(process.argv.slice(2));
