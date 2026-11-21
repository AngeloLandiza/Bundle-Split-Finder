import { describe, expect, it } from 'vitest';

import { kitPageTarget, pickUnread } from '../src/scan/kitPage';
import { bundleKey, type BundleRecord, type CatalogRecord, partKey } from '../src/scan/types';

// Which page a scan, and the panel's Read kit page, would read. Records here are the shapes the
// store holds; the page a click saves is the recorded Home Depot page, tested with the worker.

const T0 = Date.UTC(2026, 10, 20, 12);

const catalog = (model: string, itemId: string | null, page = false): CatalogRecord => ({
  key: partKey('RYOBI', model),
  brand: 'RYOBI',
  model,
  title: model,
  kinds: [],
  isKit: true,
  upc: null,
  seenAt: T0,
  ...(itemId === null ? {} : { itemId }),
  ...(page ? { page: { bullets: ['Includes: (1) PCL206 Drill'], description: null, readAt: T0 } } : {}),
});

const bundle = (itemId: string, model: string, page = false): BundleRecord => ({
  key: bundleKey(itemId),
  retailer: 'homedepot',
  itemId,
  title: model,
  brand: 'RYOBI',
  model,
  upc: null,
  price: 100,
  regularPrice: null,
  percentOff: null,
  link: null,
  seenAt: T0,
  split: null,
  ...(page ? { page: { bullets: [], description: null, readAt: T0 } } : {}),
});

describe('kitPageTarget', () => {
  it('reads the catalog kit by the item id its listing row stored', () => {
    expect(kitPageTarget([], [catalog('PCL1201K2', '317987584')], 'RYOBI', 'PCL1201K2')).toEqual({
      kind: 'page', where: 'catalog', key: partKey('RYOBI', 'PCL1201K2'), itemId: '317987584',
    });
  });

  it('does not read a catalog id when the kit is stored as its own bundle: the bundle pass reads that one', () => {
    const own = bundle('317987591', 'PCL1600K2');
    const other = catalog('PCL1600K2', '999');
    expect(kitPageTarget([own], [other], 'RYOBI', 'PCL1600K2')).toEqual({
      kind: 'page', where: 'bundle', key: own.key, itemId: '317987591',
    });
  });

  it('of two bundle records, reads the model the owner named', () => {
    const twin = bundle('1', 'PCL1600K2B');
    const exact = bundle('317987591', 'PCL1600K2');
    expect(kitPageTarget([twin, exact], [], 'ryobi', ' pcl1600k2 ')).toMatchObject({ where: 'bundle', itemId: '317987591', key: exact.key });
  });

  it('a catalog kit is the first readable record in stored order, the same pick the scan uses', () => {
    const first = catalog('PCL1600K2B', '1');
    const second = catalog('PCL1600K2', '317987591');
    expect(kitPageTarget([], [first, second], 'RYOBI', 'PCL1600K2')).toMatchObject({ where: 'catalog', itemId: '1', key: first.key });
    expect(pickUnread([first, second], new Set(['1']))).toBe(second);
  });

  it('a page already stored is not read again, and a missing or non-digit id is not a page address', () => {
    expect(kitPageTarget([], [catalog('PCL1600K2', '317987591', true)], 'RYOBI', 'PCL1600K2')).toEqual({ kind: 'stored' });
    expect(kitPageTarget([], [catalog('PCL1201K2', null)], 'RYOBI', 'PCL1201K2')).toEqual({ kind: 'no-id' });
    expect(kitPageTarget([], [catalog('PCL1201K2', 'not-an-id')], 'RYOBI', 'PCL1201K2')).toEqual({ kind: 'no-id' });
    expect(kitPageTarget([bundle('abc', 'PCL1600K2')], [catalog('PCL1600K2', '317987591')], 'RYOBI', 'PCL1600K2')).toEqual({ kind: 'no-id' });
    expect(kitPageTarget([], [], 'RYOBI', 'PCL1201K2')).toEqual({ kind: 'none' });
  });
});
