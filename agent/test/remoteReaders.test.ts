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

  it('a helper that does not answer in time fails the read (the runner notes it), and the job is not handed out later', async () => {
    const { readers, q } = setup(50);
    await expect(readers.readPages(['111111111'])).rejects.toThrow('Chrome did not answer in time');
    expect(q.waitingCount()).toBe(0);
    expect(await q.next(0)).toBeNull();
  });

  it('a result that is not a list of readings is a failed read, never data', async () => {
    const { readers, worker } = setup();
    const reading = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }]);
    await worker(() => ({ price: 19 }));
    await expect(reading).rejects.toThrow('could not be read');
  });

  it('reads part prices in the order asked', async () => {
    const { readers, worker } = setup();
    const reading = readers.readPartPrices([{ brand: 'RYOBI', model: 'PCL206B' }]);
    const row = { brand: 'RYOBI', model: 'PCL206B', status: 'found', itemId: '315155390', matchedModel: 'PCL206B', price: 59, title: 'Saw', link: 'https://www.homedepot.com/p/315155390' };
    const job = await worker(() => [row]);
    expect(job).toMatchObject({ kind: 'partPrices', input: { parts: [{ brand: 'RYOBI', model: 'PCL206B' }] } });
    expect(await reading).toEqual([row]);
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
