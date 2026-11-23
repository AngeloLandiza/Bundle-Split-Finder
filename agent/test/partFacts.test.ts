// Answer once (Nov 23) through the agent: Review's "…and remember this for A986501" (POST /api/review/:id/answer with
// `remember`), "Not sold separately" on a part row (POST /api/facts) and "Change" (DELETE /api/facts/:key), on the owner's
// scan-3 store (fixtures/e2e-2026-11-23/after-scan3). No network.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import type { AnswerResponse, DealDetail, FactResponse, ReviewResponse } from '../../core/src/api/contract';
import { reviewSignature } from '../../core/src/scan/answers';
import { splitOne, withdrawUnreadSplitQuestions } from '../../core/src/scan/runner';
import { knownModels } from '../../core/src/scan/split';
import { bundleKey } from '../../core/src/scan/types';
import { createAgent, type Agent } from '../app';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3');
const A986501 = 'split:homedepot:320243671';
/** The real PCL1600K2-A986501 record under a second item id: the stand-in for another bundle that holds A986501. */
const SECOND = bundleKey('920243671');

let server: Server;
let agent: Agent;
let base: string;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-facts-')), port, timers: false, now: () => Date.UTC(2026, 10, 23, 20) });
  server.on('request', agent.handle);
  const from = await loadScanFolder(DIR);
  const s = agent.work.scanStore;
  for (const r of await from.listBundles()) await s.putBundle(r);
  for (const r of await from.listCatalog()) await s.putCatalogEntry(r);
  for (const r of await from.listMatches()) await s.putMatch(r);
  for (const r of await from.listListings()) await s.putListing(r);
  for (const r of await from.listReview()) await s.putReview(r);
  for (const r of await from.listPartPrices()) await s.putPartPrice(r);
  for (const m of await from.listMatches()) if (m.asin) { const p = await from.getPrice(m.asin); if (p) await s.putPrice(p); }
  const now = Date.UTC(2026, 10, 23, 19);
  await withdrawUnreadSplitQuestions(s, now);
  const real = (await s.getBundle(bundleKey('320243671')))!;
  const twin = { ...structuredClone(real), itemId: '920243671', key: SECOND, split: null };
  await s.putBundle(twin);
  await splitOne(s, twin, await knownModels(s), now, true);
  await agent.work.refresh();
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const review = async (): Promise<ReviewResponse> => (await (await ui('/api/review')).json()) as ReviewResponse;

describe('answer once, through the agent', () => {
  it('one answer with "remember this for A986501" settles the other question about A986501, and the deal says where it came from', async () => {
    const open = (await review()).questions.filter((q) => q.unsettledParts?.includes('A986501')).map((q) => q.id).sort();
    expect(open).toEqual([A986501, `split:${SECOND}`]);
    const item = (await agent.work.scanStore.getReview(A986501))!;
    const res = await ui(`/api/review/${encodeURIComponent(A986501)}/answer`, { method: 'POST', body: JSON.stringify({ answer: { choice: 0 }, seen: reviewSignature(item), remember: ['A986501'] }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnswerResponse;
    expect(body.remembered).toEqual({ models: ['A986501'], settled: [`split:${SECOND}`], skipped: [] });
    expect((await review()).questions.map((q) => q.id)).not.toContain(`split:${SECOND}`);
    const d = (await (await ui(`/api/deals/${encodeURIComponent(SECOND)}`)).json()) as DealDetail;
    expect(d.splitEvidence?.find((e) => e.kind === 'owner_fact')?.text).toBe('A986501 is a part of the bundles that name it: your answer on Nov 23 (PCL1600K2-A986501).');

    // "Change": the fact is forgotten and the bundle it settled is asked about again.
    const change = await ui(`/api/facts/${encodeURIComponent('RYOBI:A986501')}`, { method: 'DELETE' });
    expect(((await change.json()) as FactResponse).reopened).toEqual([SECOND]);
    expect((await review()).questions.map((q) => q.id)).toContain(`split:${SECOND}`);
  });

  it('a remember list that is not model numbers is refused before anything is applied', async () => {
    const item = (await agent.work.scanStore.getReview(A986501))!;
    const res = await ui(`/api/review/${encodeURIComponent(A986501)}/answer`, { method: 'POST', body: JSON.stringify({ answer: { choice: 0 }, seen: reviewSignature(item), remember: 'A986501' }) });
    expect(res.status).toBe(400);
    expect((await agent.work.scanStore.getReview(A986501))!.answer).toBeNull();
  });

  it('"Not sold separately" on A10FB1G takes it out of what PCL1200K2-A10FB1G is missing, in every bundle that holds it', async () => {
    const res = await ui('/api/facts', { method: 'POST', body: JSON.stringify({ brand: 'RYOBI', model: 'A10FB1G', notSoldSeparately: true }) });
    expect(res.status).toBe(200);
    const row = agent.store.get('deals').bundles.find((b) => b.model === 'PCL1200K2-A10FB1G')!;
    expect(row.incomplete!.unpriced.map((u) => u.model)).toEqual(['PCL206']);
    expect(row.parts.find((p) => p.model === 'A10FB1G')!.fact).toMatchObject({ text: 'In the box, not sold separately', notCounted: true });
    expect((await ui('/api/facts', { method: 'POST', body: JSON.stringify({ brand: 'RYOBI', model: 'A10FB1G' }) })).status).toBe(400);
  });
});
