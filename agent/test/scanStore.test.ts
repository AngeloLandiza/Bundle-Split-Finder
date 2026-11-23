import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { storeConformance } from '../../core/test/storeConformance';
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
