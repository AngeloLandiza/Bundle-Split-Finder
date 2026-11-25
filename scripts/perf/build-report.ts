// Benchmark: buildReport (core/src/scan/report.ts) on the owner's real store, at the scale a store reaches after months.
// The store after scan 6 (fixtures/e2e-2026-11-23/after-scan6/scan, 258 bundles) is read into the in-memory store, and
// every bundle is stored again COPIES - 1 more times with a distinct key and digit item id (its split question with it),
// so about 2000 bundles. The share of bundles whose kit page is not read stays the real one (4 of 258 after scan 6, all
// four with a kit page to read): it is not raised. Times REPS reports after one warm-up. Prints one line: ms, rows,
// rows with a kit not read, and a sha256 of the JSON of the last report, which must not change when buildReport is
// optimized. Reads files only: no network, nothing written back.
//
//   npx tsx scripts/perf/build-report.ts

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { buildReport } from '../../core/src/scan/report';
import { DEFAULT_SCAN_SETTINGS, type ScanReport } from '../../core/src/scan/types';
import { loadScanFolder } from '../data-folder';

const COPIES = 8;
const REPS = 5;

const store = await loadScanFolder(join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6'));
const real = await store.listBundles();
const reviews = new Map((await store.listReview()).map((r) => [r.id, r] as const));
for (let copy = 1; copy < COPIES; copy++) {
  for (const b of real) {
    const itemId = /^\d+$/.test(b.itemId) ? `${b.itemId}0${copy}` : `${b.itemId}~${copy}`;
    const key = b.key === `homedepot:${b.itemId}` ? `homedepot:${itemId}` : `${b.key}~${copy}`;
    await store.putBundle({ ...b, key, itemId });
    const q = reviews.get(`split:${b.key}`);
    if (q) await store.putReview({ ...q, id: `split:${key}`, subject: key });
  }
}

const settings = DEFAULT_SCAN_SETTINGS;
await buildReport(store, settings); // warm up
let report: ScanReport | undefined;
const t0 = performance.now();
for (let i = 0; i < REPS; i++) report = await buildReport(store, settings);
const ms = performance.now() - t0;

const kitsNotRead = report!.bundles.filter((b) => b.kitsNotRead.length > 0).length;
const sha = createHash('sha256').update(JSON.stringify(report)).digest('hex');
console.error(`bundles ${real.length} real, ${report!.bundles.length} stored; reps ${REPS}`);
console.log(`ms=${ms.toFixed(1)} rows=${report!.bundles.length} kitsNotRead=${kitsNotRead} sha=${sha}`);
