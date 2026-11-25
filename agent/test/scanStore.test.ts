import { copyFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { BundleRecord, ConfirmedPrice, PartPriceRecord, ScanJob } from '../../core/src/scan/types';
import { storeConformance } from '../../core/test/storeConformance';
import { setSyncForTests } from '../fsync';
import { DirCache, FileScanStore } from '../scanStore';

const fresh = () => mkdtempSync(join(tmpdir(), 'sf-scan-'));

storeConformance('FileScanStore', async () => new FileScanStore(fresh()));

describe('FileScanStore on disk', () => {
  it('reads back what an earlier agent wrote', async () => {
    const dir = fresh();
    const a = new FileScanStore(dir);
    await a.putReview({ id: 'split:homedepot:1', kind: 'split', subject: 'homedepot:1', brand: 'RYOBI', model: 'PCL1600K2-P553', title: null, reason: 'r', candidates: [], choices: [['PCL1600K2', 'P553']], openedAt: 1, answer: null, answeredAt: null });
    const b = new FileScanStore(dir);
    expect((await b.getReview('split:homedepot:1'))?.choices).toEqual([['PCL1600K2', 'P553']]);
    await b.clearAll();
    expect(await new FileScanStore(dir).listReview()).toEqual([]);
  });

  it('caches by key, and a key that hashes alike is not someone else\'s answer', async () => {
    const dir = fresh();
    const cache = new DirCache(dir);
    await cache.set('engine=amazon&k=drill', { at: 5, data: { x: 1 } });
    expect(await new DirCache(dir).get('engine=amazon&k=drill')).toEqual({ at: 5, data: { x: 1 } });
    expect(await cache.get('engine=amazon&k=saw')).toBeUndefined();
  });
});

// An unchanged record is not written again (core/src/scan/runner.ts splitBundles puts every stored bundle back each scan,
// usually as it was). The file it would have written is byte for byte the one on disk, so skipping it changes nothing a
// reader or a restart sees. Each write renames a new file into place, so a write shows as a new inode. Real records: the
// owner's sixth scan (fixtures/e2e-2026-11-23/after-scan6).
describe('FileScanStore skips a write that would not change the file', () => {
  const SCAN6 = 'fixtures/e2e-2026-11-23/after-scan6/scan';
  const real = <T>(kind: string): [string, T][] => JSON.parse(readFileSync(join(SCAN6, `${kind}.json`), 'utf8')) as [string, T][];
  const bundles = real<BundleRecord>('bundles').map(([, b]) => b);
  const scans = real<ScanJob>('scans').map(([, s]) => s);
  const part = real<PartPriceRecord>('partPrices').map(([, p]) => p).find((p) => p.price !== null)!;
  const confirmed: ConfirmedPrice = { key: part.key, brand: part.brand, model: part.model, price: part.price!, link: part.link!, confirmedAt: part.checkedAt };
  const ino = (file: string) => statSync(file).ino;
  const jsonFiles = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.json')).sort();

  /** A store over a copy of the owner's sixth scan, its bundles file written once by this store. */
  async function seeded() {
    const dir = fresh();
    for (const name of readdirSync(SCAN6)) copyFileSync(join(SCAN6, name), join(dir, name));
    const s = new FileScanStore(dir);
    await s.putBundle(bundles[0]!);
    return { dir, s, file: join(dir, 'bundles.json') };
  }

  it('an unchanged bundle is not rewritten, a changed one is, and the bytes are what a full write gives', async () => {
    const { dir, s, file } = await seeded();
    const before = readFileSync(file, 'utf8');
    expect(before).toBe(JSON.stringify(real<BundleRecord>('bundles')));
    const node = ino(file);
    for (const b of await s.listBundles()) await s.putBundle({ ...b });
    expect(ino(file)).toBe(node);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const b = bundles[7]!;
    await s.putBundle({ ...b, seenAt: b.seenAt + 1 });
    expect(ino(file)).not.toBe(node);
    expect((await new FileScanStore(dir).getBundle(b.key))?.seenAt).toBe(b.seenAt + 1);
  });

  it('the first put after opening always writes: the file on disk may not be what this store would write', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'bundles.json'), JSON.stringify(real<BundleRecord>('bundles'), null, 2));
    const s = new FileScanStore(dir);
    await s.putBundle({ ...bundles[0]! });
    expect(readFileSync(join(dir, 'bundles.json'), 'utf8')).toBe(JSON.stringify(real<BundleRecord>('bundles')));
  });

  it('reads back exactly what was put, own undefined fields included, though the file is not rewritten', async () => {
    const { s, file } = await seeded();
    const b = bundles.find((r) => !('page' in r))!;
    const node = ino(file);
    await s.putBundle({ ...b, page: undefined });
    expect(ino(file)).toBe(node);
    const got = await s.getBundle(b.key);
    expect(Object.hasOwn(got!, 'page')).toBe(true);
    expect(got).toEqual({ ...b, page: undefined });
  });

  it('a file deleted, replaced or changed behind the store is written again by the next put, even an unchanged one', async () => {
    const { dir, s, file } = await seeded();
    const full = readFileSync(file, 'utf8');
    rmSync(file);
    await s.putBundle({ ...bundles[0]! });
    expect(readFileSync(file, 'utf8')).toBe(full);

    writeFileSync(`${file}.other`, '[]');
    renameSync(`${file}.other`, file);
    await s.putBundle({ ...bundles[0]! });
    expect(readFileSync(file, 'utf8')).toBe(full);

    writeFileSync(file, '[]');
    await s.putBundle({ ...bundles[0]! });
    expect(readFileSync(file, 'utf8')).toBe(full);
    expect(await new FileScanStore(dir).listBundles()).toHaveLength(bundles.length);
  });

  it('a write that failed is not taken as on disk: the same put afterwards writes', async () => {
    const { dir, s, file } = await seeded();
    const b = bundles[3]!;
    // The write is made to fail at its flush, before the rename (a folder made read-only does not stop a write on Windows).
    setSyncForTests(() => {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    });
    try {
      await expect(s.putBundle({ ...b, seenAt: b.seenAt + 1 })).rejects.toThrow(/EIO/);
    } finally {
      setSyncForTests(() => {});
    }
    expect(readFileSync(file, 'utf8')).not.toContain(`"seenAt":${b.seenAt + 1}`);
    await s.putBundle({ ...b, seenAt: b.seenAt + 1 });
    expect((await new FileScanStore(dir).getBundle(b.key))?.seenAt).toBe(b.seenAt + 1);
    expect(readFileSync(file, 'utf8')).toContain(`"seenAt":${b.seenAt + 1}`);
  });

  it('a record that cannot be written still fails, and a good one put over it is written', async () => {
    const { dir, s } = await seeded();
    const b = bundles[0]!;
    await expect(s.putBundle({ ...b, seenAt: 1n } as unknown as BundleRecord)).rejects.toThrow();
    await s.putBundle({ ...b });
    expect((await new FileScanStore(dir).getBundle(b.key))?.seenAt).toBe(b.seenAt);
  });

  it('an unchanged scan job, a delete of a missing key and a clear of empty kinds write nothing', async () => {
    const { dir, s } = await seeded();
    const scansFile = join(dir, 'scans.json');
    const pricesFile = join(dir, 'confirmedPrices.json');
    await s.putScan(scans[0]!);
    await s.deleteConfirmedPrice('no-such-key');
    const nodes = [ino(scansFile), ino(pricesFile)];
    await s.putScan({ ...scans[0]! });
    await s.deleteConfirmedPrice('no-such-key');
    expect([ino(scansFile), ino(pricesFile)]).toEqual(nodes);

    await s.putConfirmedPrice(confirmed);
    const withPrice = ino(pricesFile);
    await s.deleteConfirmedPrice(confirmed.key);
    expect(ino(pricesFile)).not.toBe(withPrice);
    expect(await new FileScanStore(dir).getConfirmedPrice(confirmed.key)).toBeUndefined();

    await s.clearAll();
    const cleared = jsonFiles(dir).map((n) => [n, ino(join(dir, n))]);
    await s.clearAll();
    expect(jsonFiles(dir).map((n) => [n, ino(join(dir, n))])).toEqual(cleared);
    for (const n of jsonFiles(dir)) expect(readFileSync(join(dir, n), 'utf8')).toBe('[]');
  });

  it('after Reset scan data an unchanged put writes the record again', async () => {
    const { dir, s } = await seeded();
    await s.clearAll();
    await s.putBundle({ ...bundles[0]! });
    expect((await new FileScanStore(dir).listBundles()).map((b) => b.key)).toEqual([bundles[0]!.key]);
  });
});
