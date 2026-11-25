// Nov 25: a scan step that read no page said "skipped: page limit reached" whenever hdPagesLeft() was 0, which is also the case
// while Home Depot's pause is in force. On the owner's scan the kit-page and part-price steps said it after Home Depot had just
// refused a page. The step now says the true reason, in the step's line and in the summary. Real runner, replayed responses,
// no network.

import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { HdPace, noPagesWhy, paceStateOf } from '../src/scan/hdPace';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { pipelineView, skippedPagesSentence, type PipelineStep } from '../src/scan/pipeline';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type PageOutcome, type PartPriceReading, type ReadPages, type ScanJob, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

const T0 = Date.UTC(2026, 10, 19, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

const notFound = (parts: { brand: string; model: string }[]): PartPriceReading[] =>
  parts.map((p) => ({ brand: p.brand, model: p.model, status: 'not_found', itemId: null, matchedModel: null, price: null, title: null, link: null }) as PartPriceReading);
const unreadable: ReadPages = async (ids) => ids.map((itemId): PageOutcome => ({ itemId, kind: 'unreadable' }));
const byId = (job: ScanJob, id: string): PipelineStep => job.pipeline!.find((s) => s.id === id)!;

/** A scan whose Home Depot pace is the real HdPace, in the state `state` says, with every reader there. */
async function scanWith(pace: HdPace) {
  let t = T0;
  const now = () => (t += 250);
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now });
  return runScan({
    client, budget, store: new MemoryScanStore(), settings: RATCHET, now, readPages: unreadable, readPartPrices: async (parts) => notFound(parts), waitForPages: true,
    hdPagesLeft: () => pace.left('scan'), hdBlock: () => pace.blocked('scan'),
  });
}

const paceAt = (state: object, now = T0): HdPace => new HdPace({ now: () => now, sleep: async () => {}, load: () => paceStateOf(state), save: () => {} });

describe('why a page step read nothing', () => {
  it("Home Depot's pause in force: the step says it paused, and until when, not that a page limit was reached", async () => {
    const until = T0 + 3_600_000;
    const pace = paceAt({ pausedUntil: until });
    expect(pace.left('scan')).toBe(0);
    const job = await scanWith(pace);
    const skipped = job.pipeline!.filter((s) => s.skippedWhy);
    expect(skipped.length).toBeGreaterThan(0);
    const at = new Date(until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    for (const s of skipped) {
      expect(s.skippedReason).toBe('Home Depot paused');
      expect(s.skippedWhy).toBe(`Home Depot paused reading until ${at}`);
    }
    expect(job.pipeline!.some((s) => `${s.skippedReason} ${s.skippedWhy}`.includes('page limit'))).toBe(false);
    // The step's line in the progress view reads the whole reason.
    const figures = pipelineView(job, {}, T0).steps.filter((s) => s.state === 'skipped' && s.figure.startsWith('Home Depot')).map((s) => s.figure);
    expect(figures.length).toBeGreaterThan(0);
    for (const f of figures) expect(f).toMatch(/^Home Depot paused reading until \d{1,2}:\d{2} [AP]M$/);
    // And the summary names them once.
    expect(skippedPagesSentence(job.pipeline)).toMatch(/were skipped: Home Depot paused reading until /);
  });

  it("this scan's own pages used up (no pause): the step says the scan's page limit and its number", async () => {
    // The pace's cap for a scan is its own: 0 pages here, so no page is left and nothing is paused.
    const capped = new HdPace({ now: () => T0, sleep: async () => {}, load: () => paceStateOf({}), save: () => {}, limits: { pagesPerScan: 0 } });
    expect(capped.left('scan')).toBe(0);
    expect(capped.blocked('scan')).toEqual({ reason: 'cap', cap: 0 });
    const job = await scanWith(capped);
    const skipped = job.pipeline!.filter((s) => s.skippedWhy);
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(s.skippedReason).toBe('scan page limit reached');
      expect(s.skippedWhy).toBe("this scan's page limit of 0 was reached");
    }
    expect(skippedPagesSentence(job.pipeline)).toMatch(/were skipped: this scan's page limit of 0 was reached\.$/);
  });

  it('the words: a pause names its end; a cap names its number; no block names the scan setting', () => {
    expect(noPagesWhy({ reason: 'paused', until: T0 }, 40, clock)).toEqual({ short: 'Home Depot paused', sentence: 'Home Depot paused reading until 12:00' });
    expect(noPagesWhy({ reason: 'cap', cap: 40 }, 25, clock).sentence).toBe("this scan's page limit of 40 was reached");
    expect(noPagesWhy(null, 25, clock).sentence).toBe("this scan's page limit of 25 was reached");
    expect(skippedPagesSentence(undefined)).toBeNull();
  });
});
