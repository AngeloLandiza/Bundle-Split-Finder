// The extension's BOGO reads (Nov 23): a Featured BOGO listing page and product pages with their promotions, run as the
// agent's bogoListing and promoPage jobs. Pages are rebuilt in the recorded Apollo shape from
// fixtures/homedepot-pages/bogo-2026-11-23.json (and the pricing key of pricing-2026-11-17.json).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRAND_QUERIES } from '@core/settings';
import { bogoListingPath } from '@core/tracking/bogoPairs';
import { bundleListingPath } from '@core/scan/listingSource';
import { runJob } from './agentJobs';
import type { Readers } from './doorwayLock';
import { createBogoListingReader, createBundleListingReader, createPromoPageReader, doorwayStateInTab, fetchPathInTab, type DoorwayState, type InTabResult, type PathInTab, type ReaderEnv } from './hdReader';

interface RecordedItem { itemId: string; model: string; brand: string; title: string; price: number; original: number | null; conditionalPromotions: unknown[] | null }
const recording = JSON.parse(readFileSync('fixtures/homedepot-pages/bogo-2026-11-23.json', 'utf8')) as { lists: Record<'ryobi' | 'dewalt', { items: RecordedItem[] }> };
const PRICING_KEY = (JSON.parse(readFileSync('fixtures/homedepot-pages/pricing-2026-11-17.json', 'utf8')) as Record<string, { key: string }>)['328814689']!.key;
const ryobi = recording.lists.ryobi.items;

const productText = (it: RecordedItem) =>
  `window.__APOLLO_STATE__=${JSON.stringify({
    [`base-catalog-${it.itemId}`]: {
      identifiers: { brandName: it.brand, modelNumber: it.model, productLabel: it.title },
      [PRICING_KEY]: { value: it.price, original: it.original, conditionalPromotions: it.conditionalPromotions },
    },
  })}`;
const listingText = (items: RecordedItem[]) =>
  `window.__APOLLO_STATE__=${JSON.stringify(Object.fromEntries(items.map((i) => [`base-searchNav-${i.itemId}`, { itemId: i.itemId, identifiers: { brandName: i.brand, modelNumber: i.model, productLabel: i.title, canonicalUrl: `/p/x/${i.itemId}` } }])))}`;

function env(answer: (args: unknown[]) => unknown, doorway?: () => DoorwayState): { env: ReaderEnv; log: string[] } {
  const log: string[] = [];
  return {
    log,
    env: {
      origin: 'https://www.homedepot.com',
      openTab: async (url) => (log.push(`open ${url}`), 7),
      closeTab: async () => {},
      waitForLoad: async () => {},
      // The doorway's own page shows its state; every other call is the reader's fetch.
      runInTab: (async (_t: number, f: unknown, args: unknown[]) => (f === doorwayStateInTab ? (doorway ? doorway() : { state: true, title: 'Home Depot' }) : (log.push('fetch'), answer(args)))) as ReaderEnv['runInTab'],
      remember: async () => {},
      remembered: async () => null,
      sleep: async (ms) => { log.push(`sleep ${ms}`); },
    },
  };
}

describe('the BOGO listing reader', () => {
  it('opens the listing in the doorway and gives its products in page order', async () => {
    const path = bogoListingPath(BRAND_QUERIES.RYOBI, 0);
    const f = env(() => ({ status: 200, text: listingText(ryobi) }) satisfies PathInTab);
    const got = await createBogoListingReader(f.env, { settleMs: 0 })(path);
    expect('products' in got && got.products.map((p) => p.model)).toEqual(ryobi.map((i) => i.model));
    expect(f.log).toEqual([`open https://www.homedepot.com${path}`, 'fetch']);
  });

  it('Nov 23: a cold doorway that shows its state after 2 s is read; one that never does is the refusal, with nothing fetched', async () => {
    const path = bogoListingPath(BRAND_QUERIES.RYOBI, 0);
    let checks = 0;
    const cold = env(() => ({ status: 200, text: listingText(ryobi) }) satisfies PathInTab, () => ({ state: ++checks >= 5, title: 'Home Depot' }));
    const got = await createBogoListingReader(cold.env, { settleMs: 0 })(path);
    expect('products' in got && got.products).toHaveLength(ryobi.length);
    expect(cold.log.filter((l) => l === 'sleep 500')).toHaveLength(4);
    expect(cold.log.indexOf('fetch')).toBeGreaterThan(cold.log.lastIndexOf('sleep 500'));
    const never = env(() => ({ status: 200, text: listingText(ryobi) }), () => ({ state: false, title: 'Access Denied' }));
    expect(await createBogoListingReader(never.env, { settleMs: 0, doorwayStateMs: 2000 })(path)).toEqual({
      error: 'Home Depot refused the BOGO listing (its own page never showed its data, titled "Access Denied").',
    });
    expect(never.log).not.toContain('fetch');
  });

  it('Nov 23: a 200 without the page state is a listing that came back without its data, not a refusal; a real 429 is a refusal', async () => {
    const path = bogoListingPath(BRAND_QUERIES.RYOBI, 0);
    const empty = env(() => ({ status: 200, text: null, note: 'Home Depot' }) satisfies PathInTab);
    expect(await createBogoListingReader(empty.env, { settleMs: 0 })(path)).toEqual({ error: 'The BOGO listing came back without its data, titled "Home Depot".' });
    const refused = env(() => ({ status: 429, text: null }) satisfies PathInTab);
    expect(await createBogoListingReader(refused.env, { settleMs: 0 })(path)).toEqual({ error: 'Home Depot refused the BOGO listing (HTTP 429).' });
  });

  it('a refusal is said in words, and an address that is not the listing is never opened', async () => {
    const f = env(() => ({ status: 403, text: null }));
    expect(await createBogoListingReader(f.env, { settleMs: 0 })(bogoListingPath(BRAND_QUERIES.DEWALT, 12))).toEqual({ error: 'Home Depot refused the BOGO listing (HTTP 403).' });
    const g = env(() => ({ status: 200, text: '' }));
    expect(await createBogoListingReader(g.env)('/p/317987584')).toEqual({ error: 'That is not a Featured BOGO listing address.' });
    expect(g.log).toEqual([]);
  });
});

describe('the Bundle listing reader (free scan)', () => {
  const path = bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, 12)!;
  it('reads a Bundle listing page as the BOGO listing reader does, and only a Bundle listing address', async () => {
    const f = env(() => ({ status: 200, text: listingText(ryobi) }) satisfies PathInTab);
    const got = await createBundleListingReader(f.env, { settleMs: 0 })(path);
    expect('products' in got && got.products.map((p) => p.model)).toEqual(ryobi.map((i) => i.model));
    expect(f.log).toEqual([`open https://www.homedepot.com${path}`, 'fetch']);
    const g = env(() => ({ status: 200, text: '' }));
    expect(await createBundleListingReader(g.env)(bogoListingPath(BRAND_QUERIES.RYOBI, 0))).toEqual({ error: 'That is not a Home Depot Bundle listing address.' });
    expect(g.log).toEqual([]);
  });
  it('a refusal is said in words, and nothing is retried', async () => {
    const f = env(() => ({ status: 403, text: null }));
    expect(await createBundleListingReader(f.env, { settleMs: 0 })(path)).toEqual({ error: 'Home Depot refused the bundle list (HTTP 403).' });
    expect(f.log.filter((l) => l === 'fetch')).toHaveLength(1);
  });
});

describe('fetchPathInTab (run from its own source)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives the state text of a 200, the title of a 200 without it, and the status of anything else', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === '/a') return { status: 200, text: async () => 'x<script>window.__APOLLO_STATE__={"k":1}</script><script>y</script>' };
      if (url === '/b') return { status: 200, text: async () => '<html><title> Access   Denied </title></html>' };
      if (url === '/d') throw new Error('network');
      return { status: 403, text: async () => 'no' };
    });
    const rebuilt = new Function(`return (${fetchPathInTab.toString()})`)() as typeof fetchPathInTab;
    expect(await rebuilt('/a')).toEqual({ status: 200, text: 'window.__APOLLO_STATE__={"k":1}' });
    expect(await rebuilt('/b')).toEqual({ status: 200, text: null, note: 'Access Denied' });
    expect(await rebuilt('/c')).toEqual({ status: 403, text: null });
    expect(await rebuilt('/d')).toEqual({ status: 0, text: null });
  });
});

describe('the promotion page reader', () => {
  it('reads each page’s price, was-price and BOGO promotion', async () => {
    const byId = new Map(ryobi.map((i) => [i.itemId, i]));
    const f = env((args) => (args[0] as string[]).map((id): InTabResult => ({ itemId: id, status: 200, text: productText(byId.get(id)!) })));
    const out = await createPromoPageReader(f.env, { settleMs: 0 })([ryobi[0]!.itemId, ryobi[1]!.itemId]);
    expect(out[0]).toMatchObject({ kind: 'read', page: { model: 'PCL1201K2', price: 179, promotions: [{ promotionId: '945815', endsAt: '2027-01-31' }] } });
    expect(out[1]).toMatchObject({ kind: 'read', page: { model: 'PCL1201K2-PCL515B', price: 179, wasPrice: 268, promotions: [] } });
  });

  // Nov 23: the doorway rule, through the same reader as the bundle pages (hdReader.ts withDoorway).
  const ids = ryobi.slice(0, 4).map((i) => i.itemId);
  const byId = new Map(ryobi.map((i) => [i.itemId, i]));
  const readIt = (id: string): InTabResult => ({ itemId: id, status: 200, text: productText(byId.get(id)!) });

  it('a cold doorway that shows its state after 2 s is read; one that never does is the refusal, with its title and nothing fetched', async () => {
    let checks = 0;
    const cold = env((args) => (args[0] as string[]).map(readIt), () => ({ state: ++checks >= 5, title: 'Home Depot' }));
    const out = await createPromoPageReader(cold.env, { settleMs: 0 })(ids.slice(0, 2));
    expect(out.map((o) => o.kind)).toEqual(['read', 'read']);
    expect(cold.log.filter((l) => l === 'sleep 500')).toHaveLength(4);
    expect(cold.log.indexOf('fetch')).toBeGreaterThan(cold.log.lastIndexOf('sleep 500'));
    const never = env((args) => (args[0] as string[]).map(readIt), () => ({ state: false, title: 'Access Denied' }));
    expect(await createPromoPageReader(never.env, { settleMs: 0, doorwayStateMs: 2000 })(ids.slice(0, 3))).toEqual([
      { itemId: ids[0], kind: 'refused', note: 'Access Denied' },
      { itemId: ids[1], kind: 'skipped' },
      { itemId: ids[2], kind: 'skipped' },
    ]);
    expect(never.log).not.toContain('fetch');
  });

  it('one empty 200 in the middle is that page unreadable with its title; the next pages are read; two in a row stop; a 403 stops at once', async () => {
    const middle = env((args) => (args[0] as string[]).map((id): InTabResult => (id === ids[1] ? { itemId: id, status: 200, text: null, note: 'Home Depot' } : readIt(id))));
    expect((await createPromoPageReader(middle.env, { settleMs: 0 })(ids)).map((o) => o.kind)).toEqual(['read', 'unreadable', 'read', 'read']);
    const two = env((args) => (args[0] as string[]).map((id, i): InTabResult => (i === 1 || i === 2 ? { itemId: id, status: 200, text: null } : readIt(id))));
    expect((await createPromoPageReader(two.env, { settleMs: 0 })(ids)).map((o) => o.kind)).toEqual(['read', 'unreadable', 'unreadable', 'skipped']);
    const refused = env((args) => (args[0] as string[]).map((id, i): InTabResult => (i === 1 ? { itemId: id, status: 403, text: null } : i > 1 ? { itemId: id, status: -1, text: null } : readIt(id))));
    expect((await createPromoPageReader(refused.env, { settleMs: 0 })(ids)).map((o) => o.kind)).toEqual(['read', 'refused', 'skipped', 'skipped']);
  });
});

describe('the BOGO jobs', () => {
  const base: Readers = { readPages: async () => [], readPartPrices: async () => [], readItemPrice: async () => ({}) as never, researchTools: { forQuestion: () => ({}) as never } };

  it('bogoListing reads only a listing address; a browser without the reader says so', async () => {
    const path = bogoListingPath(BRAND_QUERIES.RYOBI, 0);
    const r: Readers = { ...base, readBogoListing: async () => ({ products: [] }) };
    expect(await runJob({ kind: 'bogoListing', input: { path } }, r)).toEqual({ ok: true, result: { products: [] } });
    expect(await runJob({ kind: 'bogoListing', input: { path: 'https://evil.example/' } }, r)).toEqual({ ok: false, error: 'The job\'s listing address is not one this browser can read.' });
    expect(await runJob({ kind: 'bogoListing', input: { path } }, base)).toEqual({ ok: false, error: 'This browser does not read BOGO listings yet.' });
  });

  it('bundleListing reads only a Bundle listing address; an older browser without the reader answers as outdated', async () => {
    const path = bundleListingPath('DEWALT', BRAND_QUERIES.DEWALT, 0)!;
    const r: Readers = { ...base, readBundleListing: async () => ({ products: [] }) };
    expect(await runJob({ kind: 'bundleListing', input: { path } }, r)).toEqual({ ok: true, result: { products: [] } });
    expect(await runJob({ kind: 'bundleListing', input: { path: bogoListingPath(BRAND_QUERIES.RYOBI, 0) } }, r)).toEqual({ ok: false, error: 'The job\'s listing address is not one this browser can read.' });
    expect(await runJob({ kind: 'bundleListing', input: { path } }, base)).toMatchObject({ ok: false, outdated: true });
  });

  it('promoPage takes digits only', async () => {
    const r: Readers = { ...base, readPromoPages: async (ids) => ids.map((itemId) => ({ itemId, kind: 'unreadable' as const })) };
    expect(await runJob({ kind: 'promoPage', input: { itemIds: ['317987584'] } }, r)).toEqual({ ok: true, result: [{ itemId: '317987584', kind: 'unreadable' }] });
    expect((await runJob({ kind: 'promoPage', input: { itemIds: ['../x'] } }, r)).ok).toBe(false);
  });
});
