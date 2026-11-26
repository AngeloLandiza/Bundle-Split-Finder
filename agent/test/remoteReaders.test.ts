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

  it('Nov 25: what a page states about buying it travels in its checked shape: a wrong kind or a fake date is null, a page that states nothing keeps none', async () => {
    const { readers, worker } = setup();
    const stated = { buyable: true, discontinued: false, availability: 'Online', quantityLimit: 3, returnable: '90-Day', promotionStart: '2026-10-26', promotionEnd: '2027-01-31' };
    const reading = readers.readPages(['111111111', '222222222', '333333333']);
    await worker(() => [
      { itemId: '111111111', kind: 'read', content: { bullets: [], description: null, buying: stated } },
      { itemId: '222222222', kind: 'read', content: { bullets: [], description: null, buying: { ...stated, buyable: 'yes', quantityLimit: -1, promotionEnd: '2027-02-31' } } },
      { itemId: '333333333', kind: 'read', content: { bullets: [], description: null, buying: { evil: true } } },
    ]);
    const out = await reading;
    expect(out[0]).toMatchObject({ content: { buying: stated } });
    expect(out[1]).toMatchObject({ content: { buying: { ...stated, buyable: null, quantityLimit: null, promotionEnd: null } } });
    expect(out[2]).toEqual({ itemId: '333333333', kind: 'read', content: { bullets: [], description: null } });
  });

  it('Nov 25: an item page (promoPage) carries it too', async () => {
    const { readers, worker } = setup();
    const stated = { buyable: false, discontinued: true, availability: 'Online', quantityLimit: null, returnable: null, promotionStart: null, promotionEnd: null };
    const reading = readers.readPromoPages(['344305163']);
    await worker(() => [
      { itemId: '344305163', kind: 'read', page: { itemId: '344305163', brand: 'RYOBI', model: 'PSK1212SB-PCL633B', title: 't', price: 99, wasPrice: 183, bullets: [], description: null, promotions: [], buying: stated } },
    ]);
    const [o] = await reading;
    expect(o).toMatchObject({ kind: 'read', page: { buying: stated } });
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

  it('Nov 25: the barcode the page states travels as a 12-digit UPC-A; one that is not a valid barcode is dropped', async () => {
    const { readers, worker } = setup();
    const prices = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }, { brand: 'RYOBI', model: 'PCL235B' }]);
    await worker(() => search([{ model: 'PCL206B', itemId: '315155390' }, { model: 'PCL235B', itemId: '222222222' }]));
    await worker(() => reading({ upc: '0885911758215' }));
    await worker(() => search([{ model: 'PCL235B', itemId: '222222222' }]));
    await worker(() => reading({ model: 'PCL235B', matchedModel: 'PCL235B', itemId: '222222222', link: 'https://www.homedepot.com/p/222222222', upc: '12345' }));
    const out = await prices;
    expect(out[0]).toEqual({ ...reading(), upc: '885911758215' });
    expect(out[1]).not.toHaveProperty('upc');
  });

  // Nov 25: a picture from the helper is untrusted data: kept only as https on images.thdstatic.com, length-limited.
  const PIC = 'https://images.thdstatic.com/productImages/1efa1410-45b1-42af-8fd5-80fa9ae69c8b/svn/ryobi-power-drills-64_145.jpg';
  const BAD = ['http://images.thdstatic.com/x_145.jpg', 'https://evil.example/x.jpg', 'javascript:alert(1)', `https://images.thdstatic.com/${'a'.repeat(400)}.jpg`, 42];

  it('Nov 25: a page’s, an item page’s, a list entry’s and a part price’s picture travel only from Home Depot’s image host', async () => {
    const { readers, worker } = setup();
    const pages = readers.readPages(['111111111', '222222222']);
    await worker(() => [
      { itemId: '111111111', kind: 'read', content: { bullets: [], description: null, image: PIC } },
      { itemId: '222222222', kind: 'read', content: { bullets: [], description: null, image: BAD[1] } },
    ]);
    const [good, bad] = await pages;
    expect(good).toMatchObject({ content: { image: PIC } });
    expect((bad as { content: object }).content).not.toHaveProperty('image');

    for (const image of [PIC, ...BAD]) {
      const promo = readers.readPromoPages(['344305163']);
      await worker(() => [{ itemId: '344305163', kind: 'read', page: { itemId: '344305163', brand: 'RYOBI', model: 'P', title: 't', price: 99, wasPrice: null, bullets: [], description: null, promotions: [], image } }]);
      const [o] = await promo;
      if (image === PIC) expect(o).toMatchObject({ page: { image: PIC } });
      else expect((o as { page: object }).page).not.toHaveProperty('image');

      const list = readers.readBundleListing('/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5');
      await worker(() => ({ products: [{ itemId: '339857091', brand: 'RYOBI', model: '', title: 'Set', url: 'https://www.homedepot.com/p/339857091', image }] }));
      const { products } = await list;
      if (image === PIC) expect(products[0]!.image).toBe(PIC);
      else expect(products[0]).not.toHaveProperty('image');
    }

    const prices = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }]);
    await worker(() => search([{ model: 'PCL206B', itemId: '315155390' }]));
    await worker(() => reading({ image: PIC }));
    expect((await prices)[0]).toEqual({ ...reading(), image: PIC });
    const refused = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }]);
    await worker(() => search([{ model: 'PCL206B', itemId: '315155390' }]));
    await worker(() => reading({ image: BAD[0] }));
    expect((await refused)[0]).toEqual(reading());
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
    // Fix round 2: the final address (a Bundle list path only), the list's total and an empty state's sample come through.
    const sample = { kinds: { '#': 30, ROOT_QUERY: 1 }, entries: [{ kind: '#', key: '1917265066', text: '{"a":1}' }] };
    const redirected = readers.readBundleListing('/b/N-5yc1vZbwo64Zm5d');
    await worker(() => ({ products: [], note: 'n', finalPath: '/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64', total: 101, sample }));
    expect(await redirected).toEqual({ products: [], note: 'n', finalPath: '/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64', total: 101, sample });
    const off = readers.readBundleListing(path);
    await worker(() => ({ products: [product], finalPath: '/account/settings', total: -1, sample: { kinds: {}, entries: [{ kind: 'x', key: 'y', text: 'z'.repeat(1501) }] } }));
    expect(await off).toEqual({ products: [product] });
    // Fix round 3: a set (no model number) and its items come through; a malformed item list makes the answer no answer.
    const set = { ...product, itemId: '344978523', model: '', set: { items: [{ itemId: '317987598', quantity: 1 }, { itemId: '314892344', quantity: 2 }], dollarOff: 41, percentageOff: 24 } };
    const withSet = readers.readBundleListing(path);
    await worker(() => ({ products: [set] }));
    expect(await withSet).toEqual({ products: [set] });
    const badSet = readers.readBundleListing(path);
    await worker(() => ({ products: [{ ...set, set: { ...set.set, items: [{ itemId: '../x', quantity: 1 }] } }] }));
    await expect(badSet).rejects.toThrow('could not be read');
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
