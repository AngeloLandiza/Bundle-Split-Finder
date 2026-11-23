// BOGO found by the agent, end to end in the agent with a fake paired Chrome: before the scan it reads each brand's
// Featured BOGO listing and the items' pages (worker jobs), stores the pairs, puts each pair in the scan store as a bundle
// with its page, and the deals carry the pair's tag and its group. The Chrome answers are the Nov 23 recording
// (fixtures/homedepot-pages/bogo-2026-11-23.json) rebuilt in the recorded Apollo shape. No network; the scan itself is a
// fake that spends nothing.

import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityResponse, DealDetail, DealsResponse, WorkerJob } from '../../core/src/api/contract';
import { parsePromoPage } from '../../core/src/hdPage';
import type { runScan } from '../../core/src/scan/runner';
import type { ScanJob } from '../../core/src/scan/types';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';

interface RecordedItem { itemId: string; model: string; brand: string; title: string; price: number; original: number | null; conditionalPromotions: unknown[] | null }
const recording = JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/bogo-2026-11-23.json', import.meta.url), 'utf8')) as { lists: Record<'ryobi' | 'dewalt', { items: RecordedItem[] }> };
const PRICING_KEY = (JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pricing-2026-11-17.json', import.meta.url), 'utf8')) as Record<string, { key: string }>)['328814689']!.key;
const all = new Map([...recording.lists.ryobi.items, ...recording.lists.dewalt.items].map((i) => [i.itemId, i]));
const pageOf = (it: RecordedItem) =>
  parsePromoPage(
    `window.__APOLLO_STATE__=${JSON.stringify({
      [`base-catalog-${it.itemId}`]: {
        identifiers: { brandName: it.brand, modelNumber: it.model, productLabel: it.title },
        details: { descriptiveAttributes: [{ name: 'Includes', value: `Includes the ${it.model}` }] },
        [PRICING_KEY]: { value: it.price, original: it.original, conditionalPromotions: it.conditionalPromotions },
      },
    })}`,
    it.itemId,
  )!;

const T0 = new Date(2026, 10, 23, 9).getTime();
let server: Server;
let agent: Agent;
let base: string;
let worked: WorkerJob[];
let live: boolean;

/** The paired Chrome: answers BOGO jobs from the recording, anything else as unreadable. */
async function chrome(): Promise<void> {
  while (live) {
    const job = await agent.jobs.next(50);
    if (!job) continue;
    worked.push(job);
    let result: unknown = [];
    if (job.kind === 'bogoListing') {
      const path = (job.input as { path: string }).path;
      const items = recording.lists[path.includes('ryobi') ? 'ryobi' : 'dewalt'].items;
      // The recording holds the first page; a later offset brings the same twelve again (the listing ends).
      result = { products: items.map((i) => ({ itemId: i.itemId, brand: i.brand, model: i.model, title: i.title, url: `https://www.homedepot.com/p/x/${i.itemId}` })) };
    } else if (job.kind === 'promoPage') {
      result = (job.input as { itemIds: string[] }).itemIds.map((id) => ({ itemId: id, kind: 'read', page: pageOf(all.get(id)!) }));
    }
    agent.jobs.complete({ id: job.id, ok: true, result });
  }
}

const fakeScan = (async (deps: Parameters<typeof runScan>[0]) => {
  const at = deps.now?.() ?? T0;
  const job = {
    id: String(at), startedAt: at, finishedAt: at, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', queue: [], deferred: [], searchesUsed: 0, keepaTokensUsed: 0,
    counts: { pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0, partPricesRead: 0 },
  } as ScanJob;
  await deps.store.putScan(job);
  return job;
}) as unknown as typeof runScan;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.includes('/account.json')) return new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE), { status: 200 });
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-bogo-')), port, timers: false, fetchFn, now: () => T0, work: { runScan: fakeScan } });
  server.on('request', agent.handle);
  worked = [];
  live = true;
});

afterEach(async () => {
  live = false;
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' } });
const json = async <T>(path: string, init?: RequestInit) => (await (await ui(path, init)).json()) as T;

async function scan(): Promise<void> {
  await ui('/api/scan', { method: 'POST' });
  await agent.work.idle();
}

describe('BOGO found by the agent', () => {
  it('reads both listings and the item pages in Chrome, and the pairs become tagged deals grouped by starter', async () => {
    const polling = chrome();
    await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: 'serp-secret-key-123' }) });
    await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ settings: { brands: ['DEWALT', 'RYOBI'] }, ai: { monthlyCapUsd: 0 } }) });
    await new Promise((r) => setTimeout(r, 20));
    await scan();

    // Per brand: the first listing page, the next (no new item: the end), then the twelve item pages in one job.
    expect(worked.map((j) => j.kind)).toEqual(['bogoListing', 'bogoListing', 'promoPage', 'bogoListing', 'bogoListing', 'promoPage']);
    const pairs = agent.store.get('tracking').bogoPairs;
    expect(Object.keys(pairs)).toHaveLength(13);
    expect(pairs['homedepot:337440459']).toMatchObject({ model: 'DCK200D1P1W921B', starterModel: 'DCK200D1P1', freeModel: '921B', price: 299, endsAt: '2027-01-31' });

    // The pair is a bundle the scan holds, with the page the pass read (so the scan does not read it again).
    const rec = await agent.work.scanStore.getBundle('homedepot:324903619');
    expect(rec).toMatchObject({ model: 'PCL1201K2-PCL515B', price: 179, regularPrice: 268, percentOff: 33 });
    expect(rec?.page?.bullets).toEqual(['Includes the PCL1201K2-PCL515B']);

    const deals = await json<DealsResponse>('/api/deals');
    const row = deals.rows.find((r) => r.id === 'homedepot:324903619')!;
    expect(row.bogoPair).toMatchObject({ starterModel: 'PCL1201K2', freeModel: 'PCL515B', promotionId: '945815' });
    // No estimate yet (the fake scan split nothing): the group says so rather than naming a best.
    expect(row.bogoChoices).toEqual({ label: 'BOGO: 11 free-tool choices — none has an estimate yet', count: 11, bestId: null, best: false });

    const detail = await json<DealDetail>(`/api/deals/${encodeURIComponent(row.id)}`);
    expect(detail.bogoGroup?.choices.map((c) => c.freeModel)).toHaveLength(11);
    expect(detail.sources).toContainEqual({ label: 'Home Depot: the BOGO starter PCL1201K2', url: 'https://www.homedepot.com/p/317987584', source: 'homedepot' });

    // The owner's entry is only a fallback: a pair already holds its free tool.
    const refused = await ui(`/api/deals/${encodeURIComponent(row.id)}/bogo`, { method: 'POST', body: JSON.stringify({ chosen: [{ model: 'PCL515B' }] }) });
    expect(refused.status).toBe(409);
    const activity = await json<ActivityResponse>('/api/activity');
    expect(activity.runs[0]!.summary).not.toMatch(/BOGO/);

    // A second scan the same day reads the listings again but no item page.
    worked = [];
    await scan();
    expect(worked.map((j) => j.kind)).toEqual(['bogoListing', 'bogoListing', 'bogoListing', 'bogoListing']);
    expect(Object.keys(agent.store.get('tracking').bogoPairs)).toHaveLength(13);
    live = false;
    await polling;
  });
});
