// @vitest-environment jsdom
// The Deals list on a report that a replayed scan really produced: recorded SerpApi responses, the real
// pipeline into a memory store, then buildReport. Nothing reaches the network.
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { replayRecorded } from '../../../scripts/replay';
import { HD_DEWALT_AMBIGUOUS, SERPAPI_ACCOUNT_FREE } from '../../../core/test/fixtures';
import { applyReviewAnswer, reviewSignature } from '@core/scan/answers';
import { DEFAULT_SCAN_SETTINGS, type ScanJob, type ScanSettings } from '@core/scan/types';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { buildReport } from '@core/scan/report';
import { runScan } from '@core/scan/runner';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, SerpApiClient } from '@core/serpapi/client';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AppState, PanelReport } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { DealsTab } from './DealsTab';
import { lookupsWaiting, matchState, sections } from './dealsModel';

afterEach(cleanup);

const T0 = Date.UTC(2026, 10, 9, 12);
const CATALOG: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, brands: ['DEWALT'], queries: [{ q: 'dewalt 20v combo kit' }], catalogPagesPerScan: 1 };
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

async function replayed(settings: ScanSettings, maxPerRun: number): Promise<{ report: PanelReport; job: ScanJob }> {
  const store = new MemoryScanStore();
  const replay = replayRecorded();
  const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replay.fetchFn, now: () => T0 });
  const job = await runScan({ client, budget, store, settings, now: () => T0 });
  const report = await buildReport(store, settings);
  return { report: { ...report, packaging: {} }, job };
}

/**
 * The real bundle whose '1B' fits DCF891B and DCF921B (core/test/fixtures.ts): a scan that may spend nothing
 * asks which, and the owner answers DCF921B. Its parts have no match record until something looks them up.
 */
async function ownerChose(): Promise<PanelReport> {
  const store = new MemoryScanStore();
  const [model, title] = HD_DEWALT_AMBIGUOUS;
  await store.putBundle({
    key: 'homedepot:ambiguous', retailer: 'homedepot', itemId: 'ambiguous', title, brand: 'DEWALT', model,
    upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0, split: null,
  });
  for (const m of ['DCF891B', 'DCF921B']) {
    await store.putCatalogEntry({ key: `DEWALT:${m}`, brand: 'DEWALT', model: m, title: `${m} (seeded for this test)`, kinds: ['impact wrench'], isKit: false, upc: null, seenAt: T0 });
  }
  const settings: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, brands: ['DEWALT'], queries: [], catalogPagesPerScan: 0 };
  const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 0 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings, now: () => T0 });
  const question = (await store.getReview('split:homedepot:ambiguous'))!;
  await applyReviewAnswer(store, question.id, { choice: 1, seen: reviewSignature(question) }, T0);
  return { ...(await buildReport(store, settings)), packaging: {} };
}

let dewalt: Awaited<ReturnType<typeof replayed>>;
let ratchet: Awaited<ReturnType<typeof replayed>>;
beforeAll(async () => {
  dewalt = await replayed(CATALOG, 10);
  // One search only: the listing page is read, the Amazon lookups are left waiting.
  ratchet = await replayed(RATCHET, 1);
});

const api: WorkerApi = {
  send: (async (r: { type: string }) => (r.type === 'quote' ? { ok: true, data: { searches: 1, refusal: null } } : { ok: true, data: null })) as WorkerApi['send'],
  onStateChanged: () => () => {},
  download: vi.fn(),
};
const appState = (job: ScanJob): AppState => ({
  hasKey: true,
  account: null,
  accountCheckedAt: 1,
  problem: null,
  settings: { ...DEFAULT_SETTINGS, searchesPerScan: 1 },
  scanRunning: false,
  lastJob: { ...job, finishedAt: Date.now() - 60_000 },
  nextRunAt: null,
});

describe('Deals on a replayed scan', () => {
  it('puts the DEWALT kit in Confirmed as a loss, and the three unread bundles under Contents not known', () => {
    const groups = sections(dewalt.report.bundles, 'profit');
    expect(groups.map((g) => `${g.label} · ${g.rows.length}`)).toEqual(['CONFIRMED · 1', 'CONTENTS NOT KNOWN · 3']);
    const kit = groups[0]!.rows[0]!;
    expect(kit.key).toBe('homedepot:343992133');
    expect(matchState(kit)).toBe('2 parts to verify');
    expect(kit.estimate?.profit).toBe(-12.8);
  });

  it('renders that report, a real loss with the real minus, and a tag only where a question is open', () => {
    render(createElement(DealsTab, { api, report: dewalt.report, state: appState(dewalt.job), sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() }));
    expect(screen.getByText('−$12.80')).toBeInTheDocument();
    expect(screen.getByText('ROI −3%')).toBeInTheDocument();
    expect(screen.getAllByText('Needs your answer').length).toBe(dewalt.report.review.filter((r) => r.kind === 'split').length);
  });

  it('offers Look up for a bundle whose split the owner chose after the scan: its parts have no match yet', async () => {
    const report = await ownerChose();
    const row = report.bundles.find((b) => b.key === 'homedepot:ambiguous')!;
    expect(row.parts.map((p) => [p.model, p.status])).toEqual([['DCKTS650D1P1', 'unmatched'], ['DCF921B', 'unmatched']]);
    const send = vi.fn(async (r: { type: string }) => (r.type === 'quote' ? { ok: true, data: { searches: 2, refusal: null } } : { ok: true, data: null }));
    const quoting: WorkerApi = { ...api, send: send as unknown as WorkerApi['send'] };
    render(createElement(DealsTab, { api: quoting, report, state: appState(ratchet.job), sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() }));
    expect(await screen.findByRole('button', { name: 'Look up 2 searches' })).toBeEnabled();
    expect(send).toHaveBeenCalledWith({ type: 'quote', action: { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'DCKTS650D1P1' }, { brand: 'DEWALT', model: 'DCF921B' }] } });
  });

  it('counts the lookups a limited scan left waiting, and offers Look up for those bundles', async () => {
    expect(ratchet.job.status).toBe('stopped');
    const waiting = lookupsWaiting(ratchet.job);
    expect(waiting).toBeGreaterThan(0);
    const rows = ratchet.report.bundles.filter((b) => b.parts.some((p) => p.status === 'waiting'));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(matchState(r)).toMatch(/unknown$/);
    render(createElement(DealsTab, { api, report: ratchet.report, state: appState(ratchet.job), sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() }));
    expect((await screen.findAllByRole('button', { name: /^Look up/ })).length).toBe(rows.length);
    expect(screen.getByText(/^It used the 1 search allowed per scan\./)).toBeInTheDocument();
  });
});
