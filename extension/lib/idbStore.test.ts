import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { storeConformance } from '../../core/test/storeConformance';
import { IdbScanStore } from './idbStore';
import { openDb } from './db';
import { appendLedger, readLedger } from './ledger';
import { IdbCache } from './idbCache';

let n = 0;
const fresh = () => `test-${++n}-${Math.random()}`;

storeConformance('IdbScanStore', async () => new IdbScanStore(await openDb(fresh())));

describe('IdbCache', () => {
  it('round-trips an entry and returns undefined for a missing key', async () => {
    const c = new IdbCache(await openDb(fresh()));
    expect(await c.get('k')).toBeUndefined();
    await c.set('k', { at: 5, data: { a: [1] } });
    expect(await c.get('k')).toEqual({ at: 5, data: { a: [1] } });
    await c.set('k', { at: 6, data: 'x' });
    expect(await c.get('k')).toEqual({ at: 6, data: 'x' });
  });

  it('clear empties only the cache store', async () => {
    const db = await openDb(fresh());
    const c = new IdbCache(db);
    const s = new IdbScanStore(db);
    await c.set('k', { at: 1, data: 1 });
    await appendLedger({ at: 'a', engine: 'e', key: 'k', label: 'l' }, db);
    await s.putCursor({ brand: 'DEWALT', nextPage: 1, passes: 0, updatedAt: 1 });
    await c.clear();
    expect(await c.get('k')).toBeUndefined();
    expect(await s.getCursor('DEWALT')).toBeDefined();
    expect(await readLedger(db)).toHaveLength(1);
  });
});

describe('ledger', () => {
  it('reads entries in insertion order', async () => {
    const db = await openDb(fresh());
    expect(await readLedger(db)).toEqual([]);
    const es = ['z', 'a', 'm'].map((k) => ({ at: k, engine: 'e', key: k, label: k }));
    for (const e of es) await appendLedger(e, db);
    expect(await readLedger(db)).toEqual(es);
  });
});

describe('openDb', () => {
  it('reuses one connection per name', async () => {
    const name = fresh();
    expect(await openDb(name)).toBe(await openDb(name));
  });
});
