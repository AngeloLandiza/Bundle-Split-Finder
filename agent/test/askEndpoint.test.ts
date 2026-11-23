// Step 16: POST /api/review/:id/ask is never a silent no-op (AskResponse). The split question comes from the recorded
// "ryobi 18v combo kit" page scanned over the replay (as ownerAnswers.test.ts does). No key is stored, so nothing is asked.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AskResponse } from '../../core/src/api/contract';
import { suggestionKey, type StoredSuggestion } from '../../core/src/assist/stored';
import { reviewSignature } from '../../core/src/scan/answers';
import { runScan } from '../../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '../../core/src/scan/types';
import { parseAccount, SearchBudget } from '../../core/src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../../core/src/serpapi/client';
import * as fx from '../../core/test/fixtures';
import { replayRecorded } from '../../scripts/replay';
import { createAgent, type Agent } from '../app';

const P553 = 'split:homedepot:320243741';
const RYOBI: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
const T0 = Date.UTC(2026, 10, 23, 12);

let server: Server;
let agent: Agent;
let base: string;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-ask-')), port, timers: false, now: () => T0 });
  server.on('request', agent.handle);
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 1 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store: agent.work.scanStore, settings: RYOBI, now: () => T0 });
  await agent.work.refresh();
});

afterEach(async () => {
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ask = (id: string, body: unknown = {}) =>
  fetch(`${base}/api/review/${encodeURIComponent(id)}/ask`, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' } });

describe('POST /api/review/:id/ask', () => {
  it('says why when nothing can be asked, instead of queuing nothing', async () => {
    const res = await ask(P553);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskResponse;
    expect(body.queued).toBe(false);
    expect(body.reason).toMatch(/key/i);
    expect(body.canForce).toBeUndefined();
  });

  it('with a "could not tell" answer and Chrome closed, says Chrome is closed (a split question reads Home Depot through it)', async () => {
    const item = (await agent.work.scanStore.getReview(P553))!;
    const record: StoredSuggestion = {
      key: suggestionKey(P553, 1), questionId: P553, seen: reviewSignature(item), askedAt: 1, costUsd: 0.07,
      suggestion: { questionId: P553, seen: reviewSignature(item), provider: 'claude', model: 'claude-opus-5-5', promptVersion: 'p', status: 'cannot_tell', reason: 'r', quotes: [] },
    };
    agent.store.update('suggestions', (all) => [...all, record]);
    agent.store.update('keys', (k) => ({ ...k, anthropic: 'sk-test-not-a-real-key' }));
    const body = (await (await ask(P553, { force: true })).json()) as AskResponse;
    expect(body).toEqual({ queued: false, reason: 'Chrome is closed: the app reads Home Depot through it. Open Chrome with the Split Finder helper, then ask again.' });
  });

  it('refuses a force that is not true or false, and a question that is not open', async () => {
    expect((await ask(P553, { force: 'yes' })).status).toBe(400);
    expect((await ask('split:homedepot:1')).status).toBe(404);
  });
});
