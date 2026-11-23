// Suggested prices (Nov 23) through the agent: the drip's average pulls for inactive listings (agent/suggestPrices.ts), the
// deal detail's suggestion and "if accepted" line, and the one-click confirm (POST …/price {kind: 'suggested'}). Keepa's
// figures are the recorded stats pull (fixtures/keepa/product-…-stats.json); the pull is a fake. No network, no tokens.

import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import type { DealDetail } from '../../core/src/api/contract';
import { TokenBudget } from '../../core/src/keepa/budget';
import { parseProductResponse } from '../../core/src/keepa/parse';
import { partTrendFromProduct, readPartTrend, writePartTrend } from '../../core/src/keepa/trends';
import { buildReport } from '../../core/src/scan/report';
import { bundleKey, DEFAULT_SCAN_SETTINGS, partKey, type BundleRecord, type MatchRecord } from '../../core/src/scan/types';
import type { CacheEntry, SearchResult } from '../../core/src/serpapi/client';
import { createAgent, type Agent } from '../app';
import { averagePullsWanted, pullAverages } from '../suggestPrices';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const products = parseProductResponse(JSON.parse(readFileSync(join(FIX, 'keepa', 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json'), 'utf8')) as Record<string, unknown>).products;
const DCF921B = products.find((p) => p.asin === 'B09M3TL9BB')!;
const T0 = Date.UTC(2026, 10, 23, 12);

class MapCache {
  readonly m = new Map<string, CacheEntry>();
  async get(k: string) { return this.m.get(k); }
  async set(k: string, v: CacheEntry) { this.m.set(k, v); }
}

describe('averagePullsWanted, on the owner\'s third real scan', () => {
  it('each inactive listing of a bundle missing a price once, smallest break-even first; none once its average is stored', async () => {
    const rows = (await buildReport(await loadScanFolder(join(FIX, 'e2e-2026-11-23', 'after-scan3')), DEFAULT_SCAN_SETTINGS)).bundles;
    const wanted = averagePullsWanted(rows, () => undefined);
    // PCL206 and A10FB1G (PCL1200K2-A10FB1G, the smallest break-even), then P321, DCK225D2 and PCL1600K2.
    expect(wanted.map((w) => w.model)).toEqual(['PCL206', 'A10FB1G', 'P321', 'DCK225D2', 'PCL1600K2']);
    expect(new Set(wanted.map((w) => w.asin)).size).toBe(5);
    // A trend pulled before averages were kept (no field) is wanted; one that says Keepa has none (null) is not asked again.
    expect(averagePullsWanted(rows, () => ({}))).toHaveLength(5);
    expect(averagePullsWanted(rows, () => ({ newAvg90: null, newAvg30: null }))).toHaveLength(0);
  });

  it('pullAverages pulls each once above the reserve and stops at the budget', async () => {
    const cache = new MapCache();
    const pulled: string[] = [];
    const pull = async (asin: string): Promise<SearchResult> => {
      pulled.push(asin);
      await writePartTrend(cache, partTrendFromProduct({ ...DCF921B, asin }, T0));
      return { data: {}, source: 'network', at: T0, billAs: 'keepa', keepaTokens: 1 };
    };
    // A per-run cap of 1 token: the second pull is refused by the budget, not made.
    const budget = new TokenBudget({ reserve: 0, maxPerRun: 1 });
    const keepaBudget = { blockReason: (n = 1) => budget.blockReason(pulled.length + n) };
    const wanted = [{ asin: 'B0A', model: 'A' }, { asin: 'B0B', model: 'B' }];
    const out = await pullAverages({ cache, keepaBudget, pull, shouldStop: () => false }, wanted);
    expect(out).toEqual({ pulled: 1, tokens: 1 });
    expect((await readPartTrend(cache, 'B0A'))?.newAvg90).toBe(146.37);
  });
});

describe('the deal detail and the one-click confirm', () => {
  let server: Server;
  let agent: Agent;
  let base: string;
  const KEY = bundleKey('1');
  const bundle: BundleRecord = {
    key: KEY, retailer: 'homedepot', itemId: '1', title: 'DEWALT kit', brand: 'DEWALT', model: 'DCK1-DCF921B', upc: null, price: 150, regularPrice: null, percentOff: null,
    link: null, seenAt: T0, split: { components: ['DCK1', 'DCF921B'], status: 'resolved', notes: [] },
  };
  const match = (model: string, asin: string): MatchRecord => ({
    key: partKey('DEWALT', model), brand: 'DEWALT', model, status: 'matched', asin, grade: 'exact', alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null,
  });

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-suggest-')), port, timers: false });
    server.on('request', agent.handle);
    const s = agent.work.scanStore;
    await s.putBundle(bundle);
    // DCK1 for sale at $100; DCF921B's listing B09M3TL9BB not for sale (its price last seen before its last check).
    await s.putMatch(match('DCK1', 'B0DCK1'));
    await s.putPrice({ asin: 'B0DCK1', price: 100, reviews: null, seenAt: T0, checkedAt: T0 });
    await s.putMatch(match('DCF921B', 'B09M3TL9BB'));
    await s.putPrice({ asin: 'B09M3TL9BB', price: 154.99, reviews: null, seenAt: T0 - 1, checkedAt: T0 });
    await writePartTrend(agent.work.cache, partTrendFromProduct(DCF921B, T0));
    await agent.work.refresh();
  });

  afterEach(async () => {
    agent.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const ui = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const detail = async (): Promise<DealDetail> => (await (await ui(`/api/deals/${encodeURIComponent(KEY)}`)).json()) as DealDetail;
  const post = (body: unknown) => ui(`/api/deals/${encodeURIComponent(KEY)}/parts/DCF921B/price`, { method: 'POST', body: JSON.stringify(body) });

  it('shows the suggestion on the unpriced part and the "if accepted" line, and counts it only once he confirms', async () => {
    const d = await detail();
    expect(d.estimate).toBeNull();
    const part = d.incompleteEstimate!.parts.find((p) => p.model === 'DCF921B')!;
    expect(part.priceSuggestion).toMatchObject({ kind: 'amazon_average', price: 146.37, label: 'Amazon listing not for sale now; its 90-day average was $146.37 (Keepa)' });
    expect(d.incompleteEstimate!.ifAccepted?.suggested).toBe(1);
    expect((await agent.work.scanStore.listConfirmedPrices())).toHaveLength(0);

    expect((await post({ kind: 'suggested', suggestion: { kind: 'amazon_average', price: 140 } })).status).toBe(409);
    const res = await post({ kind: 'suggested', suggestion: { kind: 'amazon_average', price: 146.37 } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { confirmed: { price: number; link: string } }).confirmed).toMatchObject({ price: 146.37, link: 'https://www.amazon.com/dp/B09M3TL9BB' });
    const after = await detail();
    expect(after.estimate?.profit).toBe(d.incompleteEstimate!.ifAccepted!.profit);
    expect((await agent.work.scanStore.listConfirmedPrices())[0]?.source?.kind).toBe('amazon_average');
  });

  it('the setting exists and is off', async () => {
    const s = (await (await ui('/api/settings')).json()) as { settings: { prices?: { autoAcceptSuggestions: boolean } } };
    expect(s.settings.prices).toEqual({ autoAcceptSuggestions: false });
  });
});
