import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { storeConformance } from '../../core/test/storeConformance';
import type { StoredSuggestion } from '@core/assist/stored';
import { IdbScanStore } from './idbStore';
import { IdbSuggestionStore } from './idbSuggestions';
import { openDB } from 'idb';
import { openDb } from './db';
import { appendLedger, readLedger } from './ledger';
import { IdbCache } from './idbCache';

let n = 0;
const fresh = () => `test-${++n}-${Math.random()}`;

storeConformance('IdbScanStore', async () => new IdbScanStore(await openDb(fresh())));

describe('the database upgrade', () => {
  it('a version 1 database gains the part prices store (step 9) and the eBay stores (step 10) and keeps what it held', async () => {
    const name = fresh();
    const v1 = await openDB(name, 1, {
      upgrade(d) {
        for (const [store, keyPath] of Object.entries({ bundles: 'key', catalog: 'key', matches: 'key', prices: 'asin', listings: 'asin', cursors: 'brand', review: 'id', scans: 'id', cache: 'key' })) {
          d.createObjectStore(store, { keyPath });
        }
        d.createObjectStore('ledger', { autoIncrement: true });
      },
    });
    await v1.put('cursors', { brand: 'RYOBI', nextPage: 3, passes: 1, updatedAt: 1 });
    await v1.add('ledger', { at: 'a', engine: 'e', key: 'k', label: 'l' });
    v1.close();
    const db = await openDb(name);
    expect(db.version).toBe(6);
    const s = new IdbScanStore(db);
    expect(await s.getCursor('RYOBI')).toEqual({ brand: 'RYOBI', nextPage: 3, passes: 1, updatedAt: 1 });
    expect(await readLedger(db)).toHaveLength(1);
    expect(await s.listPartPrices()).toEqual([]);
    const r = { key: 'RYOBI:PCL500', brand: 'RYOBI', model: 'PCL500', itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: 5 };
    await s.putPartPrice(r);
    expect(await s.getPartPrice('RYOBI:PCL500')).toEqual(r);
    expect(await s.listEbayValues()).toEqual([]);
    expect(await s.getJudgement('x')).toBeUndefined();
  });

  it('a version 2 database gains only the eBay stores (values, judgements, owner answers): what it held, partPrices included, is kept', async () => {
    const name = fresh();
    const v2 = await openDB(name, 2, {
      upgrade(d) {
        for (const [store, keyPath] of Object.entries({ bundles: 'key', catalog: 'key', matches: 'key', prices: 'asin', listings: 'asin', cursors: 'brand', review: 'id', scans: 'id', cache: 'key', partPrices: 'key' })) {
          d.createObjectStore(store, { keyPath });
        }
        d.createObjectStore('ledger', { autoIncrement: true });
      },
    });
    const r = { key: 'RYOBI:PCL500', brand: 'RYOBI', model: 'PCL500', itemId: '1', matchedModel: 'PCL500', price: 9, title: 't', link: null, seenAt: 3, checkedAt: 4 };
    await v2.put('partPrices', r);
    await v2.put('cache', { key: 'k', at: 1, data: 1 });
    v2.close();
    const db = await openDb(name);
    expect(db.version).toBe(6);
    const s = new IdbScanStore(db);
    expect(await s.getPartPrice('RYOBI:PCL500')).toEqual(r);
    expect(await new IdbCache(db).get('k')).toEqual({ at: 1, data: 1 });
    expect([...db.objectStoreNames].sort()).toEqual(['bundles', 'cache', 'catalog', 'confirmedPrices', 'cursors', 'ebayAnswers', 'ebayValues', 'judgements', 'ledger', 'listings', 'matches', 'partPrices', 'prices', 'review', 'scans', 'suggestions']);
  });
});

describe('IdbSuggestionStore', () => {
  const record = (askedAt: number, over: Record<string, unknown> = {}) =>
    ({ key: `split:homedepot:1|${askedAt}`, questionId: 'split:homedepot:1', seen: '[["A"]]', askedAt, costUsd: 0.01, suggestion: { status: 'cannot_tell', reason: 'r', quotes: [] }, ...over }) as unknown as StoredSuggestion;

  it('clear drops the suggestions and leaves the search ledger', async () => {
    const db = await openDb(fresh());
    const store = new IdbSuggestionStore(db);
    await store.put(record(1));
    await appendLedger({ at: 'a', engine: 'e', key: 'k', label: 'l' }, db);
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(await readLedger(db)).toHaveLength(1);
  });

  it('keeps every ask, oldest first, and replaces a record of the same key (an outcome added)', async () => {
    const store = new IdbSuggestionStore(await openDb(fresh()));
    await store.put(record(200));
    await store.put(record(100));
    expect((await store.list()).map((r) => r.askedAt)).toEqual([100, 200]);
    await store.put(record(100, { outcome: { answeredAt: 150, answer: 'none', agreed: null } }));
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.outcome).toEqual({ answeredAt: 150, answer: 'none', agreed: null });
  });

  it('a version 4 database gains only the suggestions store and keeps what it held', async () => {
    const name = fresh();
    const v4 = await openDB(name, 4, {
      upgrade(d) {
        for (const [store, keyPath] of Object.entries({ bundles: 'key', catalog: 'key', matches: 'key', prices: 'asin', listings: 'asin', cursors: 'brand', review: 'id', scans: 'id', cache: 'key', partPrices: 'key', ebayValues: 'key', judgements: 'key', ebayAnswers: 'key' })) {
          d.createObjectStore(store, { keyPath });
        }
        d.createObjectStore('ledger', { autoIncrement: true });
      },
    });
    await v4.put('cursors', { brand: 'RYOBI', nextPage: 3, passes: 1, updatedAt: 1 });
    // What step 10 stored, which the upgrade must leave as it is.
    const answer = { key: 'RYOBI:PCL206|v1|1|0', itemId: 'v1|1|0', model: 'PCL206', verdict: 'match', labelledBy: 'owner' };
    await v4.put('ebayAnswers', answer);
    v4.close();
    const db = await openDb(name);
    expect(db.version).toBe(6);
    expect(await new IdbScanStore(db).listEbayAnswers()).toEqual([answer]);
    expect(await new IdbScanStore(db).getCursor('RYOBI')).toEqual({ brand: 'RYOBI', nextPage: 3, passes: 1, updatedAt: 1 });
    expect(await new IdbSuggestionStore(db).list()).toEqual([]);
  });
});

describe('IdbCache', () => {
  it('round-trips an entry and returns undefined for a missing key', async () => {
    const c = new IdbCache(await openDb(fresh()));
    expect(await c.get('k')).toBeUndefined();
    await c.set('k', { at: 5, data: { a: [1] } });
    expect(await c.get('k')).toEqual({ at: 5, data: { a: [1] } });
    await c.set('k', { at: 6, data: 'x' });
    expect(await c.get('k')).toEqual({ at: 6, data: 'x' });
  });

  it('clearAll empties the scan records and the cache, and leaves the search ledger', async () => {
    const db = await openDb(fresh());
    const s = new IdbScanStore(db);
    const c = new IdbCache(db);
    await s.putCursor({ brand: 'DEWALT', nextPage: 2, passes: 1, updatedAt: 1 });
    await c.set('k', { at: 1, data: 1 });
    await appendLedger({ at: 'a', engine: 'e', key: 'k', label: 'l' }, db);
    await s.clearAll();
    expect(await s.getCursor('DEWALT')).toBeUndefined();
    expect(await c.get('k')).toBeUndefined();
    expect(await readLedger(db)).toHaveLength(1);
    await s.putCursor({ brand: 'RYOBI', nextPage: 1, passes: 0, updatedAt: 2 });
    expect(await s.getCursor('RYOBI')).toMatchObject({ nextPage: 1 });
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
