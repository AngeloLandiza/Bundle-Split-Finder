// Nov 23, "honest progress": the owner's scan 5 sat on "Step 8 of 8, finishing up, less than a minute left" for about ten
// minutes while the AI worked the Review cards. Here the same scan: the runner's steps as it ended them (fixtures/
// e2e-2026-11-23/after-scan5: eBay 80 calls, the listing check 60), its real review questions, and a fake Anthropic that
// answers nothing. At each model call the line must name the long work and count it; "Finishing up" waits behind it; and a
// time left is not shown from a guess. No network, no key.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PipelineView } from '../../core/src/scan/pipeline';
import type { PipelineStep } from '../../core/src/scan/pipeline';
import type { ScanJob } from '../../core/src/scan/types';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';

const T0 = Date.UTC(2026, 10, 23, 15);
let agent: Agent;
afterEach(async () => {
  await agent?.work.idle();
  agent?.close();
});

const done = (id: PipelineStep['id'], units: number, extra: Partial<PipelineStep> = {}): PipelineStep => ({ id, state: 'done', unitsDone: units, unitsTotal: units, ...extra });
/** The runner's steps as scan 5 ended them. */
const RUNNER: PipelineStep[] = [
  done('hdPages', 22, { source: 'chrome', found: 191, unitsMeasured: 0 }),
  done('bundlePages', 25, { activeMs: 20_976, unitsMeasured: 25 }),
  done('kitPages', 0),
  done('amazon', 29, { activeMs: 62_394, unitsMeasured: 28 }),
  { id: 'partPrices', state: 'skipped', unitsDone: 0, unitsTotal: null, skippedReason: 'Home Depot refused' },
  done('ebay', 80, { activeMs: 45_093, unitsMeasured: 80 }),
  done('judge', 60, { model: 'claude-haiku-5-5', activeMs: 160_237, unitsMeasured: 60, costSoFar: 0.0321 }),
  done('finish', 1),
];

describe('the scan line after the runner has ended', () => {
  it('names the Review cards with a count while the AI works them, keeps "Finishing up" for the tail, and shows no time from a guess', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-honest-'));
    mkdirSync(join(dir, 'scan'), { recursive: true });
    for (const kind of ['bundles', 'catalog', 'matches', 'prices', 'listings', 'partPrices', 'reviews']) {
      copyFileSync(join('fixtures/e2e-2026-11-23/after-scan5/scan', `${kind}.json`), join(dir, 'scan', `${kind}.json`));
    }
    // The line is measured while the AI works a match question: PBP2003's is the store's only one, and Home Depot's own
    // "(2-Pack)" title would settle it at the agent's start (Nov 24, rule D), so that title is left out here.
    const prices = join(dir, 'scan', 'partPrices.json');
    writeFileSync(prices, readFileSync(prices, 'utf8').replace('ONE+ 18V Lithium 2.0 Ah Battery (2-Pack)', 'ONE+ 18V Lithium 2.0 Ah Battery'));
    const seen: { view: PipelineView; status: string }[] = [];
    let t = T0;
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.includes('/account.json')) return new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE), { status: 200 });
      if (url.includes('api.anthropic.com')) {
        const view = agent.work.state().pipeline;
        if (view) seen.push({ view, status: agent.work.state().busy ?? '' });
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }), { status: 400 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const fakeScan = (async (deps: { store: { putScan: (j: ScanJob) => Promise<void> }; now?: () => number }) => {
      const at = deps.now?.() ?? T0;
      const job = {
        id: String(at), startedAt: at, finishedAt: at, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', queue: [], deferred: [], searchesUsed: 0, keepaTokensUsed: 0,
        counts: { pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0 },
        pipeline: RUNNER.map((s) => ({ ...s })),
      } as ScanJob;
      await deps.store.putScan(job);
      return job;
    }) as never;
    agent = createAgent({ dataDir: dir, port: 0, timers: false, fetchFn, now: () => (t += 1000), work: { runScan: fakeScan } });
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-key-123', anthropic: 'anthropic-secret-key-1' }));
    agent.store.update('settings', (s) => ({ ...s, ai: { ...s.ai, monthlyCapUsd: 25 } }));

    agent.work.scanNow();
    await agent.work.idle();

    // The AI was called for the match questions, and at each call the line said what it was doing.
    expect(seen.length).toBeGreaterThan(0);
    for (const { view } of seen) {
      expect(view.current.label).toBe('Review cards');
      expect(view.current.count).toMatch(/^\d+ of \d+$/);
      const steps = Object.fromEntries(view.steps.map((s) => [s.label, s]));
      expect(steps['eBay prices']).toMatchObject({ state: 'done', figure: '80 calls' });
      expect(steps['Listing check']).toMatchObject({ state: 'done' });
      expect(steps['Review cards']).toMatchObject({ state: 'now' });
      expect(steps['Finishing up']).toMatchObject({ state: 'next' });
      expect(view.stepsTotal).toBe(10);
      // No card has been timed in a scan before: no time is shown, rather than "less than a minute left".
      expect(view.estimateText).toBe('');
      expect(view.ariaValueText).not.toMatch(/less than a minute/);
    }
    // Each call is later than the one before: the count moves.
    const counts = seen.map((s) => Number(s.view.current.count.split(' ')[0]));
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);

    // The record of the run keeps the same steps, all over.
    const run = agent.store.get('activity').runs.at(-1)!;
    const labels = run.steps!.map((s) => s.label);
    expect(labels).toEqual([
      'Home Depot bundle lists', 'Bundle pages', 'Kit pages', 'Amazon lookups', 'Home Depot part prices', 'eBay prices', 'Listing check', 'Review cards', 'Listing confirmation', 'Finishing up',
    ]);
    expect(run.steps!.find((s) => s.label === 'Review cards')?.state).toBe('done');
    expect(run.steps!.find((s) => s.label === 'Finishing up')?.state).toBe('done');
    expect(agent.work.state().pipeline).toBeNull();
  });
});
