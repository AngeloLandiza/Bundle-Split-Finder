// Benchmark: the agent scan store's write path at real scale. Zero network.
//
//   npx tsx scripts/perf/store-burst.ts
//
// Copies the committed after-scan6 scan store (258 bundles, 535 KB) into a temp folder, opens the real FileScanStore on
// it, and runs the burst core/src/scan/runner.ts splitBundles does: every stored bundle put back unchanged. Then a second
// burst in which every bundle really changes (seenAt + 1), so real writes are timed and checked as well. fsyncs are
// counted by wrapping fs.fsyncSync before the store is imported. Prints one line:
//
//   burst_ms=<ms> fsyncs=<n> changed_ms=<ms> changed_fsyncs=<n> sha_unchanged=<sha256> sha=<sha256>
//
// sha_unchanged is every scan file's bytes after the unchanged burst, sha the same after the changed burst; both read
// after the store is reopened from disk. They must not change when the store's write path is optimised.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6', 'scan');

let fsyncs = 0;
const realFsync = fs.fsyncSync;
fs.fsyncSync = (fd: number): void => {
  fsyncs++;
  realFsync(fd);
};
syncBuiltinESMExports();

const { FileScanStore } = await import('../../agent/scanStore');

const digest = (dir: string): string => {
  const h = createHash('sha256');
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    h.update(name);
    h.update('\0');
    h.update(fs.readFileSync(join(dir, name)));
    h.update('\0');
  }
  return h.digest('hex');
};

const dir = fs.mkdtempSync(join(tmpdir(), 'sf-store-burst-'));
try {
  for (const name of fs.readdirSync(SOURCE).filter((n) => n.endsWith('.json'))) fs.copyFileSync(join(SOURCE, name), join(dir, name));

  const store = new FileScanStore(dir);
  const bundles = await store.listBundles();
  if (bundles.length !== 258) throw new Error(`expected 258 bundles, found ${bundles.length}`);

  fsyncs = 0;
  let t = performance.now();
  for (const b of await store.listBundles()) await store.putBundle({ ...b });
  const burstMs = performance.now() - t;
  const burstFsyncs = fsyncs;
  const shaUnchanged = digest(dir);
  const reread = await new FileScanStore(dir).listBundles();
  if (JSON.stringify(reread) !== JSON.stringify(bundles)) throw new Error('the unchanged burst changed what reads back');

  fsyncs = 0;
  t = performance.now();
  for (const b of await store.listBundles()) await store.putBundle({ ...b, seenAt: b.seenAt + 1 });
  const changedMs = performance.now() - t;
  const changedFsyncs = fsyncs;

  const after = await new FileScanStore(dir).listBundles();
  if (after.length !== bundles.length) throw new Error('bundles lost');
  after.forEach((b, i) => {
    if (b.seenAt !== bundles[i]!.seenAt + 1) throw new Error(`changed bundle ${b.key} not written`);
  });
  const sha = digest(dir);

  console.log(
    `burst_ms=${burstMs.toFixed(1)} fsyncs=${burstFsyncs} changed_ms=${changedMs.toFixed(1)} changed_fsyncs=${changedFsyncs} sha_unchanged=${shaUnchanged} sha=${sha}`,
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
