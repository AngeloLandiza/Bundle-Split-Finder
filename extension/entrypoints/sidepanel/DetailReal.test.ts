// @vitest-environment jsdom
// Detail on reports that a replayed scan really produced: recorded SerpApi responses, the real pipeline into
// a memory store, then buildReport. Nothing reaches the network.
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { replayRecorded } from '../../../scripts/replay';
import { HD_DEWALT_AMBIGUOUS, SERPAPI_ACCOUNT_FREE } from '../../../core/test/fixtures';
import { applyReviewAnswer, reviewSignature } from '@core/scan/answers';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@core/scan/types';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { buildReport } from '@core/scan/report';
import { runScan } from '@core/scan/runner';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, SerpApiClient } from '@core/serpapi/client';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AppState, PanelReport } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { Detail } from './Detail';

afterEach(cleanup);

const T0 = Date.UTC(2026, 10, 9, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

async function replayed(maxPerRun: number): Promise<PanelReport> {
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings: RATCHET, now: () => T0 });
  return { ...(await buildReport(store, RATCHET)), packaging: {} };
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

let full: PanelReport;
let limited: PanelReport;
beforeAll(async () => {
  full = await replayed(10);
  limited = await replayed(2);
});

const api: WorkerApi = {
  send: (async (r: { type: string }) => (r.type === 'quote' ? { ok: true, data: { searches: 1, refusal: null } } : { ok: true, data: null })) as WorkerApi['send'],
  onStateChanged: () => () => {},
  download: vi.fn(),
};
const state: AppState = { hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null };

const open = (report: PanelReport, key: string) => render(createElement(Detail, { api, report, state, bundleKey: key, onBack: vi.fn() }));

describe('Detail on a replayed scan', () => {
  it("shows the founder's bundle: its estimate, both parts with their saved listing titles, and a Verify for each title match", async () => {
    const row = full.bundles.find((b) => b.model === 'PBLRC2501SB')!;
    open(full, row.key);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(row.title);
    expect(screen.getByText('+$79.55')).toBeInTheDocument();
    expect(screen.getByText('ROI 42%')).toBeInTheDocument();
    expect(screen.getByText('Bundle costs').nextElementSibling).toHaveTextContent('$189.00');
    expect(screen.getByText('After fees').nextElementSibling).toHaveTextContent('$268.55');
    const blocks = screen.getAllByRole('listitem');
    expect(blocks).toHaveLength(2);
    for (const [i, p] of row.parts.entries()) {
      const block = within(blocks[i]!);
      expect(p.title).toEqual(expect.any(String));
      expect(block.getByText(p.title!)).toHaveAttribute('title', p.title!);
      expect(block.getByRole('link', { name: p.asin! })).toHaveAttribute('href', `https://www.amazon.com/dp/${p.asin}`);
      expect(block.getByText('Title match')).toBeInTheDocument();
      expect(await block.findByRole('button', { name: 'Verify · 1 search' })).toBeEnabled();
    }
    expect(screen.getByRole('button', { name: 'Copy both ASINs' })).toBeEnabled();
  });

  it('offers Look up for a bundle whose split the owner chose after the scan: its parts have no match yet', async () => {
    const report = await ownerChose();
    const row = report.bundles.find((b) => b.key === 'homedepot:ambiguous')!;
    expect(row.parts.map((p) => p.status)).toEqual(['unmatched', 'unmatched']);
    open(report, row.key);
    expect(screen.getByText('No estimate yet: 2 parts still need an Amazon lookup.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Look up 1 search' })).toBeEnabled();
    expect(screen.getAllByText('Not looked up yet')).toHaveLength(2);
  });

  it('shows no estimate, the count of waiting parts and Look up for a bundle whose parts were not looked up', async () => {
    const row = limited.bundles.find((b) => b.parts.some((p) => p.status === 'waiting'))!;
    const waiting = row.parts.filter((p) => p.status === 'waiting').length;
    open(limited, row.key);
    expect(row.estimate).toBeNull();
    expect(screen.getByText(`No estimate yet: ${waiting} ${waiting === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup.`)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Look up/ })).toBeEnabled();
    expect(screen.getAllByText('Not looked up yet').length).toBe(waiting);
  });

  it('shows the split question of a bundle in Needs your answer, under its no-estimate sentence', () => {
    const q = full.review.find((r) => r.kind === 'split' && full.bundles.some((b) => b.key === r.subject))!;
    const row = full.bundles.find((b) => b.key === q.subject)!;
    open(full, row.key);
    expect(screen.getByText('Which parts come in this bundle?', { selector: 'legend' })).toBeInTheDocument();
    expect(screen.getByText('No estimate: what this bundle contains is not known yet.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Enter the parts' })).toBeInTheDocument();
  });
});
