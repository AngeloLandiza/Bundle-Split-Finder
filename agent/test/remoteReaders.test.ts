import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import { remoteReaders } from '../remoteReaders';
import { Store } from '../store';
import { WorkerJobs } from '../workerJobs';

let store: Store | null = null;
let jobs: WorkerJobs | null = null;
afterEach(() => {
  jobs?.stop();
  store?.close();
});

function setup(timeoutMs = 2_000) {
  store = Store.open(mkdtempSync(join(tmpdir(), 'sf-readers-')));
  jobs = new WorkerJobs(store);
  const q = jobs;
  /** The paired extension: answers the next job with what `answer` gives for it. */
  const worker = async (answer: (kind: string, input: unknown) => unknown) => {
    const job = await q.next(1_000);
    if (job) q.complete({ id: job.id, ok: true, result: answer(job.kind, job.input) });
    return job;
  };
  return { q, worker, readers: remoteReaders({ jobs: q, timeouts: { pageMs: timeoutMs, perItemMs: 0, toolMs: timeoutMs } }) };
}

describe('remote Home Depot readers (worker jobs)', () => {
  it('reads bundle pages through a page job and keeps only well-formed outcomes', async () => {
    const { readers, worker } = setup();
    const reading = readers.readPages(['111111111', '222222222']);
    const job = await worker(() => [
      { itemId: '111111111', kind: 'read', content: { title: 'RYOBI kit' } },
      { itemId: '222222222', kind: 'refused', status: 403 },
      { itemId: '333333333', kind: 'nonsense' },
      'junk',
    ]);
    expect(job).toMatchObject({ kind: 'page', input: { itemIds: ['111111111', '222222222'] } });
    expect(await reading).toEqual([
      { itemId: '111111111', kind: 'read', content: { title: 'RYOBI kit' } },
      { itemId: '222222222', kind: 'refused', status: 403 },
    ]);
  });

  it('Nov 23: keeps what came back instead of a page (its title) as a note, plain text of at most 80 characters', async () => {
    const { readers, worker } = setup();
    const reading = readers.readPages(['111111111', '222222222', '333333333']);
    await worker(() => [
      { itemId: '111111111', kind: 'unreadable', note: 'Oops!\n\u0007 Something   went wrong' },
      { itemId: '222222222', kind: 'refused', note: 'x'.repeat(200) },
      { itemId: '333333333', kind: 'skipped', note: 'ignored' },
    ]);
    expect(await reading).toEqual([
      { itemId: '111111111', kind: 'unreadable', note: 'Oops! Something went wrong' },
      { itemId: '222222222', kind: 'refused', note: 'x'.repeat(80) },
      { itemId: '333333333', kind: 'skipped' },
    ]);
  });

  it('a helper that does not answer in time fails the read (the runner notes it), and the job is not handed out later', async () => {
    const { readers, q } = setup(50);
    await expect(readers.readPages(['111111111'])).rejects.toThrow('Chrome did not answer in time');
    expect(q.waitingCount()).toBe(0);
    expect(await q.next(0)).toBeNull();
  });

  const search = (rows: { model: string; itemId: string; brand?: string }[]) => ({
    sourceId: 'hd-search:x', label: 'Home Depot search', url: 'https://www.homedepot.com/s/x',
    results: rows.map((r) => ({ title: `RYOBI ${r.model}`, brand: r.brand ?? 'RYOBI', model: r.model, itemId: r.itemId, url: `https://www.homedepot.com/p/${r.itemId}` })),
  });
  const reading = (over: Record<string, unknown> = {}) => ({
    brand: 'RYOBI', model: 'PCL206B', status: 'found', itemId: '315155390', matchedModel: 'PCL206B', price: 59, title: 'Saw', link: 'https://www.homedepot.com/p/315155390', ...over,
  });

  it('reads a part price with the jobs the extension runs: its search, then the product page by item id', async () => {
    const { readers, worker } = setup();
    const prices = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }, { brand: 'RYOBI', model: 'PCL235B' }]);
    // The search shows a kit first (another model) and the part sold alone: the part's own model is picked.
    expect(await worker(() => search([{ model: 'PCL206K1', itemId: '111111111' }, { model: 'PCL206B', itemId: '315155390' }]))).toMatchObject({ kind: 'search', input: { query: 'RYOBI PCL206B', page: 1 } });
    expect(await worker(() => reading())).toMatchObject({ kind: 'partPrice', input: { itemId: '315155390', model: 'PCL206B', brand: 'RYOBI' } });
    // No product for the second part: not found, and no page is read for it.
    await worker(() => search([{ model: 'PCL206B', itemId: '315155390' }]));
    expect(await prices).toEqual([reading(), { brand: 'RYOBI', model: 'PCL235B', status: 'not_found', itemId: null, matchedModel: null, price: null, title: null, link: null }]);
  });

  it('a page that names another brand is not the part; a refused search leaves the rest not read', async () => {
    const { readers, worker, q } = setup();
    const prices = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }, { brand: 'RYOBI', model: 'PCL235B' }]);
    await worker(() => search([{ model: 'PCL206B', itemId: '315155390' }]));
    await worker(() => reading({ brand: 'DEWALT' }));
    // The extension answers a refused search as a failed job; the agent hands it out once more, then it fails.
    for (let i = 0; i < 2; i++) {
      const job = await q.next(1_000);
      q.complete({ id: job!.id, ok: false, error: 'Home Depot refused the search (HTTP 403); no more are made for this question.' });
    }
    const out = await prices;
    expect(out[0]).toMatchObject({ status: 'not_found', price: null });
    expect(out[1]).toMatchObject({ status: 'not_read' });
  });

  it('a reading that is not a part price is a failed read, never data', async () => {
    const { readers, worker } = setup();
    const prices = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }]);
    await worker(() => search([{ model: 'PCL206B', itemId: '315155390' }]));
    await worker(() => ({ price: 19 }));
    await expect(prices).rejects.toThrow('could not be read');
  });

  it('research tools: a page off homedepot.com is refused, a refusal ends the reads for that question, the catalog is local', async () => {
    const { readers, worker } = setup();
    const scan = new MemoryScanStore();
    await scan.putCatalogEntry({ key: 'RYOBI:PCL206B', brand: 'RYOBI', model: 'PCL206B', title: 'RYOBI ONE+ 18V Circular Saw', kinds: ['circular saw'], isKit: false, upc: null, seenAt: 1 });
    const tools = readers.researchTools(scan);
    expect(await tools.readHomeDepotPage({ url: 'https://evil.example/p/x/328690510' })).toMatchObject({ error: expect.stringMatching(/homedepot\.com/) });

    const page = tools.readHomeDepotPage({ itemId: '328690510' });
    const job = await worker(() => ({ sourceId: 'hd-page:328690510', label: 'Home Depot page', url: 'https://evil.example/', sections: {} }));
    expect(job).toMatchObject({ kind: 'researchPage', input: { itemId: '328690510' } });
    expect(await page).toMatchObject({ error: expect.any(String) });

    const search = tools.searchHomeDepot({ query: 'ryobi pcl206b' });
    await worker(() => ({ error: 'Home Depot refused the search (HTTP 403); no more are made for this question.' }));
    expect(await search).toMatchObject({ error: expect.stringMatching(/refused/) });
    expect(await tools.readHomeDepotPage({ itemId: '328690510' })).toMatchObject({ error: expect.stringMatching(/refused an earlier request/) });

    expect(await tools.catalogLookup({ model: 'PCL206B' })).toMatchObject({ entries: [{ model: 'PCL206B', kind: 'part' }] });
  });
});

describe('the BOGO readers (worker jobs)', () => {
  // The recorded starter (bogo-2026-11-23.json) as the extension's promoPage reader answers it.
  const page = {
    itemId: '317987584', brand: 'RYOBI', model: 'PCL1201K2', title: 'ONE+ 18V Cordless 2-Tool Combo Kit', price: 179, wasPrice: null, bullets: [], description: null,
    promotions: [{ promotionId: '945815', startsAt: '2026-10-26', endsAt: '2027-01-31', description: 'Purchase Select Ryobi Starter Kit and receive a select FREE Tool' }],
  };

  it('a listing job answers its products; a refusal throws its sentence; a product off Home Depot is no answer', async () => {
    const { readers, worker } = setup();
    const path = '/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5';
    const product = { itemId: '317987584', brand: 'RYOBI', model: 'PCL1201K2', title: 'kit', url: 'https://www.homedepot.com/p/x/317987584' };
    const listing = readers.readBogoListing(path);
    expect(await worker(() => ({ products: [product] }))).toMatchObject({ kind: 'bogoListing', input: { path } });
    expect(await listing).toEqual([product]);
    const refused = readers.readBogoListing(path);
    await worker(() => ({ error: 'Home Depot refused the BOGO listing (HTTP 403).' }));
    await expect(refused).rejects.toThrow('Home Depot refused the BOGO listing (HTTP 403).');
    const odd = readers.readBogoListing(path);
    await worker(() => ({ products: [{ ...product, url: 'https://evil.example/p/1' }] }));
    await expect(odd).rejects.toThrow('could not be read');
  });

  it('free scan: a Bundle listing job answers its products and throws a refusal, as the BOGO listing job', async () => {
    const { readers, worker } = setup();
    const path = '/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5&Nao=12';
    const product = { itemId: '324903619', brand: 'RYOBI', model: 'PCL1201K2-PCL515B', title: 'kit', url: 'https://www.homedepot.com/p/x/324903619' };
    const listing = readers.readBundleListing(path);
    expect(await worker(() => ({ products: [product] }))).toMatchObject({ kind: 'bundleListing', input: { path } });
    expect(await listing).toEqual({ products: [product] });
    // Fix round: a list entry's own pricing is kept; an empty list keeps what its state held.
    const priced = { ...product, price: 179, wasPrice: 268, promotions: [{ promotionId: '945815', startsAt: '2026-10-26', endsAt: '2027-01-31', description: 'Free tool' }] };
    const withPrice = readers.readBundleListing(path);
    await worker(() => ({ products: [priced] }));
    expect(await withPrice).toEqual({ products: [priced] });
    const empty = readers.readBundleListing(path);
    await worker(() => ({ products: [], note: 'its state had 2 entries, none a product' }));
    expect(await empty).toEqual({ products: [], note: 'its state had 2 entries, none a product' });
    const bad = readers.readBundleListing(path);
    await worker(() => ({ products: [{ ...product, price: 'free' }] }));
    await expect(bad).rejects.toThrow('could not be read');
    const refused = readers.readBundleListing(path);
    await worker(() => ({ error: 'Home Depot refused the bundle list (HTTP 403).' }));
    await expect(refused).rejects.toThrow('Home Depot refused the bundle list (HTTP 403).');
  });

  it('a promoPage job keeps only well-formed pages: a promotion date not in the recorded form drops the page', async () => {
    const { readers, worker } = setup();
    const reading = readers.readPromoPages(['317987584', '324903619']);
    await worker(() => [
      { itemId: '317987584', kind: 'read', page },
      { itemId: '324903619', kind: 'read', page: { ...page, itemId: '324903619', promotions: [{ ...page.promotions[0], endsAt: 'Jan 31' }] } },
    ]);
    expect(await reading).toEqual([{ itemId: '317987584', kind: 'read', page }]);
  });
});
