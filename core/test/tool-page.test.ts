import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { toolPageToRead } from '../src/match';
import { wantedFor } from '../src/scan/classify';
import { applyIdentify, applyLookup, type PartContext } from '../src/scan/runner';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { noCounts } from '../src/scan/paid';
import { DEFAULT_SCAN_SETTINGS, type SearchClient } from '../src/scan/types';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import { recorded } from './recorded';

// The recorded search for "RYOBI PCL406B" (fixtures/validation, 18 Nov). Its first RYOBI row is the
// sander, and the rows that name the model are pads and "fits" listings. Nothing here searches.

const search = JSON.parse(
  readFileSync(new URL('../../fixtures/validation/responses/amazon/engine=amazon_k=RYOBI_PCL406B.json', import.meta.url), 'utf8'),
) as { data: unknown };

const want = wantedFor('RYOBI', 'PCL406B', new Map());
const candidates = () => parseAmazonSearch(search.data);

describe('toolPageToRead: the first same-brand result when every titled model is an accessory', () => {
  it('reads B0BSJ97BSR for PCL406B: the sander is first, and its title does not name the model', () => {
    expect(toolPageToRead(want, candidates())).toBe('B0BSJ97BSR');
  });

  it('reads nothing when a listing that names the model is the tool', () => {
    const rows = parseAmazonSearch(recorded('amazon-search-PBLRC25B'));
    expect(toolPageToRead(wantedFor('RYOBI', 'PBLRC25B', new Map()), rows)).toBeNull();
  });

  it('reads nothing when the first same-brand result is already named in its title', () => {
    const rows = candidates();
    const first = rows.find((c) => c.asin === 'B0BSJ97BSR')!;
    const named = { ...first, title: `${first.title} PCL406B` };
    expect(toolPageToRead(want, [named, ...rows.filter((c) => c.asin !== first.asin)])).toBeNull();
  });
});

const NOW = 1_700_000_000_000;

function ctx(): PartContext {
  return {
    client: { search: async () => { throw new Error('no search'); } } as SearchClient,
    store: new MemoryScanStore(),
    settings: DEFAULT_SCAN_SETTINGS,
    now: () => NOW,
    prefix: 'test',
    catalog: new Map(),
    job: { counts: noCounts() },
  };
}

/** The recorded B0B3JWF5ZV page, pointed at another ASIN and part number. The field names are that page's. */
function pageFor(asin: string, partNumber: string): unknown {
  const page = structuredClone(recorded('amazon-product-B0B3JWF5ZV')) as {
    product_results: { asin?: string; title?: string };
    product_details?: Record<string, unknown>;
  };
  page.product_results.asin = asin;
  page.product_results.title = '18V ONE+ 5" Random Orbit Sander Cordless';
  page.product_details = { ...(page.product_details ?? {}), manufacturer_part_number: partNumber };
  return page;
}

describe('applyIdentify: a product page counts only when its part number is the model', () => {
  it('matches PCL406B when the page\'s part number is PCL406B, and closes the accessory question', async () => {
    const run = ctx();
    await applyLookup(run, { kind: 'lookup', brand: 'RYOBI', model: 'PCL406B' }, search.data, NOW);
    expect(await run.store.getMatch('RYOBI:PCL406B')).toMatchObject({ status: 'review', asin: null });
    expect(await run.store.getReview('match:RYOBI:PCL406B')).toMatchObject({ answer: null });

    await applyIdentify(run, { kind: 'identify', brand: 'RYOBI', model: 'PCL406B', asin: 'B0BSJ97BSR' }, pageFor('B0BSJ97BSR', 'PCL406B'), NOW);
    expect(await run.store.getMatch('RYOBI:PCL406B')).toMatchObject({
      status: 'matched', asin: 'B0BSJ97BSR', grade: 'strong', source: 'page',
    });
    expect(await run.store.getReview('match:RYOBI:PCL406B')).toMatchObject({ answer: 'resolved by a later scan' });
    expect((await run.store.getMatch('RYOBI:PCL406B'))?.pageDue).toBeUndefined();
  });

  it('does not read the same page again when the response has no part number', async () => {
    const run = ctx();
    await applyLookup(run, { kind: 'lookup', brand: 'RYOBI', model: 'PCL406B' }, search.data, NOW);
    await run.store.putMatch({ ...(await run.store.getMatch('RYOBI:PCL406B'))!, pageDue: 'B0BSJ97BSR' });
    await applyIdentify(run, { kind: 'identify', brand: 'RYOBI', model: 'PCL406B', asin: 'B0BSJ97BSR' }, {}, NOW);
    expect(await run.store.getMatch('RYOBI:PCL406B')).toMatchObject({ status: 'review', asin: null });
    expect((await run.store.getMatch('RYOBI:PCL406B'))?.pageDue).toBeUndefined();
  });

  it('leaves the accessory question when the page names a different model', async () => {
    const run = ctx();
    await applyLookup(run, { kind: 'lookup', brand: 'RYOBI', model: 'PCL406B' }, search.data, NOW);
    await run.store.putMatch({ ...(await run.store.getMatch('RYOBI:PCL406B'))!, pageDue: 'B0BSJ97BSR' });
    await applyIdentify(run, { kind: 'identify', brand: 'RYOBI', model: 'PCL406B', asin: 'B0BSJ97BSR' }, pageFor('B0BSJ97BSR', 'P411'), NOW);
    expect(await run.store.getMatch('RYOBI:PCL406B')).toMatchObject({ status: 'review', asin: null });
    expect((await run.store.getMatch('RYOBI:PCL406B'))?.pageDue).toBeUndefined();
    expect(await run.store.getReview('match:RYOBI:PCL406B')).toMatchObject({ answer: null });
  });
});
