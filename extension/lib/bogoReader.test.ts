// The extension's BOGO reads (Nov 23): a Featured BOGO listing page and product pages with their promotions, run as the
// agent's bogoListing and promoPage jobs. Pages are rebuilt in the recorded Apollo shape from
// fixtures/homedepot-pages/bogo-2026-11-23.json (and the pricing key of pricing-2026-11-17.json).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BRAND_QUERIES } from '@core/settings';
import { bogoListingPath } from '@core/tracking/bogoPairs';
import { runJob } from './agentJobs';
import type { Readers } from './doorwayLock';
import { createBogoListingReader, createPromoPageReader, type InTabResult, type ListingInTab, type ReaderEnv } from './hdReader';

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

function env(answer: (args: unknown[]) => unknown): { env: ReaderEnv; log: string[] } {
  const log: string[] = [];
  return {
    log,
    env: {
      origin: 'https://www.homedepot.com',
      openTab: async (url) => (log.push(`open ${url}`), 7),
      closeTab: async () => {},
      waitForLoad: async () => {},
      runInTab: (async (_t: number, _f: unknown, args: unknown[]) => answer(args)) as ReaderEnv['runInTab'],
      remember: async () => {},
      remembered: async () => null,
      sleep: async () => {},
    },
  };
}

describe('the BOGO listing reader', () => {
  it('opens the listing in the doorway and gives its products in page order', async () => {
    const path = bogoListingPath(BRAND_QUERIES.RYOBI, 0);
    const f = env(() => ({ status: 200, text: listingText(ryobi) }) satisfies ListingInTab);
    const got = await createBogoListingReader(f.env, { settleMs: 0 })(path);
    expect('products' in got && got.products.map((p) => p.model)).toEqual(ryobi.map((i) => i.model));
    expect(f.log).toEqual([`open https://www.homedepot.com${path}`]);
  });

  it('a refusal is said in words, and an address that is not the listing is never opened', async () => {
    const f = env(() => ({ status: 403, text: null }));
    expect(await createBogoListingReader(f.env, { settleMs: 0 })(bogoListingPath(BRAND_QUERIES.DEWALT, 12))).toEqual({ error: 'Home Depot refused the BOGO listing (HTTP 403).' });
    const g = env(() => ({ status: 200, text: '' }));
    expect(await createBogoListingReader(g.env)('/p/317987584')).toEqual({ error: 'That is not a Featured BOGO listing address.' });
    expect(g.log).toEqual([]);
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

  it('promoPage takes digits only', async () => {
    const r: Readers = { ...base, readPromoPages: async (ids) => ids.map((itemId) => ({ itemId, kind: 'unreadable' as const })) };
    expect(await runJob({ kind: 'promoPage', input: { itemIds: ['317987584'] } }, r)).toEqual({ ok: true, result: [{ itemId: '317987584', kind: 'unreadable' }] });
    expect((await runJob({ kind: 'promoPage', input: { itemIds: ['../x'] } }, r)).ok).toBe(false);
  });
});
