// @vitest-environment jsdom
// The progress row on the jobs a replayed scan really saved, step by step: recorded SerpApi responses, the real
// pipeline into a memory store. Nothing reaches the network.
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { replayRecorded } from '../../../scripts/replay';
import { SERPAPI_ACCOUNT_FREE } from '../../../core/test/fixtures';
import { DEFAULT_SCAN_SETTINGS, type ScanJob, type ScanSettings } from '@core/scan/types';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { runScan } from '@core/scan/runner';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, SerpApiClient } from '@core/serpapi/client';
import { ProgressRow, progressOf, progressText } from './ProgressRow';

afterEach(cleanup);

const T0 = Date.UTC(2026, 10, 9, 12);
// One brand page, one Home Depot page, then the bundles' pages are read and parts are looked up.
const SETTINGS: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, brands: ['DEWALT'], queries: [{ q: 'dewalt 20v combo kit' }], catalogPagesPerScan: 1 };

/** Every job the runner saved, in order, as it was when saved. */
class RecordingStore extends MemoryScanStore {
  saved: ScanJob[] = [];
  override async putScan(job: ScanJob) {
    this.saved.push(structuredClone(job));
    return super.putScan(job);
  }
}

let saved: ScanJob[];
beforeAll(async () => {
  const store = new RecordingStore();
  const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings: SETTINGS, now: () => T0 });
  saved = store.saved.filter((j) => j.status === 'running');
});

describe('progress row on a replayed scan', () => {
  it('counts a brand page as a page fetched, so the total of the first phase holds', () => {
    const pages = saved.map(progressOf).filter((p) => p.phase === 'pages');
    expect(pages.length).toBeGreaterThan(1);
    // The first saved job is the plan: a brand page and a Home Depot page, nothing fetched.
    expect(pages[0]).toMatchObject({ current: 1, total: 2 });
    expect(new Set(pages.map((p) => (p.phase === 'pages' ? p.total : 0)))).toEqual(new Set([2]));
  });

  it('never goes backwards, names its phase, and moves through pages, reading and parts in that order', () => {
    const rows = saved.map(progressOf);
    const order = ['pages', 'reading', 'parts'];
    const phases = rows.map((r) => r.phase);
    expect(phases).toEqual([...phases].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(new Set(phases)).toEqual(new Set(order));
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      expect(b.searches).toBeGreaterThanOrEqual(a.searches);
      if (a.phase === 'pages' && b.phase === 'pages') {
        expect(b.current).toBeGreaterThanOrEqual(a.current);
        expect(b.total).toBeGreaterThanOrEqual(a.total);
      }
      if (a.phase === 'reading' && b.phase === 'reading') expect(b.read).toBeGreaterThanOrEqual(a.read);
      if (a.phase === 'parts' && b.phase === 'parts') {
        expect(b.done).toBeGreaterThanOrEqual(a.done);
        expect(b.total).toBeGreaterThanOrEqual(a.total);
      }
    }
  });

  it('says each phase in words', () => {
    const texts = saved.map(progressText);
    expect(texts[0]).toMatch(/^Scanning · page 1 of 2 · 0 searches used$/);
    expect(texts.some((t) => /^Reading bundle pages · \d+ read · \d+ searches? used$/.test(t))).toBe(true);
    expect(texts.some((t) => /^Looking up parts · \d+ of \d+ · \d+ searches? used$/.test(t))).toBe(true);
  });

  it('the last parts row has done equal to the total', () => {
    const parts = saved.map(progressOf).filter((p) => p.phase === 'parts');
    const last = parts.at(-1)!;
    if (last.phase === 'parts') expect(last.done).toBeLessThanOrEqual(last.total);
  });
});

describe('the row shows the live plan', () => {
  const base: Partial<ScanJob> = { id: 'j', searchesUsed: 1, phase: 'listing', counts: { pagesFetched: 0, catalogPages: 0 } as ScanJob['counts'] };
  const page = (n: number) => ({ kind: 'listing', q: 'a', page: n, filterTokens: null, bundlesOnly: false }) as ScanJob['queue'][number];
  const job = (over: Partial<ScanJob>) => ({ ...base, queue: [], deferred: [], ...over }) as ScanJob;

  it('a planned page that is dropped lowers the total by one, and the current page stays', () => {
    const view = render(createElement(ProgressRow, { job: job({ queue: [page(2), page(3)], counts: { pagesFetched: 1 } as ScanJob['counts'] }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Scanning · page 2 of 3 · 1 search used');
    view.rerender(createElement(ProgressRow, { job: job({ queue: [page(2)], counts: { pagesFetched: 1 } as ScanJob['counts'] }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Scanning · page 2 of 2 · 1 search used');
  });

  it('parts: done and the queued lookups', () => {
    const lookups = [{ kind: 'lookup', brand: 'DEWALT', model: 'A' }, { kind: 'lookup', brand: 'DEWALT', model: 'B' }] as ScanJob['queue'];
    const view = render(createElement(ProgressRow, { job: job({ phase: 'parts', queue: lookups }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Looking up parts · 0 of 2 · 1 search used');
    view.rerender(createElement(ProgressRow, { job: job({ phase: 'parts', queue: lookups.slice(1), counts: { lookupsDone: 1 } as ScanJob['counts'] }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Looking up parts · 1 of 2 · 1 search used');
  });

  it('reading shows the pages read, with no total', () => {
    render(createElement(ProgressRow, { job: job({ counts: { pagesRead: 4 } as ScanJob['counts'] }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Reading bundle pages · 4 read · 1 search used');
  });
});
