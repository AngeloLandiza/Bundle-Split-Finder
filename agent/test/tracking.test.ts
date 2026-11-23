// The watchlist, signals and BOGO over HTTP, from stored data only (no scan, no network).

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BogoResponse, DealDetail, DealsResponse, WatchlistResponse, WatchResponse } from '../../core/src/api/contract';
import { trackReport } from '../../core/src/tracking/state';
import { ASIN, bundle, option, part, recordedTrend } from '../../core/test/tracking-world';
import { createAgent, type Agent } from '../app';

const KEY = 'DEWALT:DCK200D1P1W921B';
const NOW = new Date(2026, 10, 23, 10).getTime();
let server: Server;
let agent: Agent;
let base: string;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-track-')), port, timers: false, now: () => NOW });
  server.on('request', agent.handle);
  const good = bundle([option('whole', 299, [part('DCF921B', ASIN.DCF921B, 249), part('DCB606', ASIN.DCB606, 199)])]);
  const plain = { ...good, key: 'DEWALT:PLAIN', model: 'PLAIN', percentOff: null };
  const report = { bundles: [good, plain], review: [] };
  agent.store.update('deals', (d) => ({ ...d, at: new Date(NOW).toISOString(), bundles: report.bundles }));
  agent.store.update('tracking', (t) => ({ ...t, ...trackReport(t, report, recordedTrend, agent.store.get('settings').alerts, NOW) }));
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' } });
const id = encodeURIComponent(KEY);

describe('tracking over HTTP', () => {
  it('GET /api/watchlist: the confirmed, discounted bundle with its signals and the thresholds they were judged by', async () => {
    const w = (await (await ui('/api/watchlist')).json()) as WatchlistResponse;
    expect(w.rows.map((r) => r.row.id)).toEqual([KEY]);
    expect(w.rows[0]!.watch).toEqual({ watched: true, by: 'auto', since: new Date(NOW).toISOString() });
    expect(w.rows[0]!.row).toMatchObject({ watched: true, buyNow: true, bogo: null });
    expect(w.rows[0]!.signals?.buyNow?.reason).toMatch(/^First seen with an estimate: est\. profit \$81\.80/);
    expect(w.thresholds).toEqual({ minProfit: 20, minRoiPercent: 20, minMonthlySold: 50, floorProfit: 20 });
    const deals = (await (await ui('/api/deals')).json()) as DealsResponse;
    expect(deals.rows.find((r) => r.id === 'DEWALT:PLAIN')).toMatchObject({ watched: false, buyNow: false });
  });

  it('POST /api/deals/:id/watch: the owner unwatches and watches; an unknown deal is 404', async () => {
    const off = (await (await ui(`/api/deals/${id}/watch`, { method: 'POST', body: JSON.stringify({ watch: false }) })).json()) as WatchResponse;
    expect(off.watch).toMatchObject({ watched: false, by: 'owner' });
    expect(((await (await ui('/api/watchlist')).json()) as WatchlistResponse).rows).toEqual([]);
    expect((await ui(`/api/deals/${encodeURIComponent('DEWALT:NOPE')}/watch`, { method: 'POST', body: JSON.stringify({ watch: true }) })).status).toBe(404);
    expect((await ui(`/api/deals/${id}/watch`, { method: 'POST', body: JSON.stringify({ watch: 'yes' }) })).status).toBe(400);
  });

  it('GET /api/deals/:id: signals, the stored history for a chart, and the FBA-fee estimate from Keepa', async () => {
    const d = (await (await ui(`/api/deals/${id}`)).json()) as DealDetail;
    expect(d.signals?.buyNow?.kind).toBe('buyNow');
    expect(d.history).toEqual([
      { at: new Date(NOW).toISOString(), section: 'confirmed', price: 299, amazonNew: 448, profit: 81.8, roiPercent: 27.36, monthlySold: 600, salesRank: null, offers: 61 },
    ]);
    // derived is filled when deals are published; none was here, so the view says none rather than guessing.
    expect(d.fbaEstimate).toBeNull();
    expect(d.bogo).toBeNull();
  });

  it('POST /api/deals/:id/bogo: "choose your free tool" until he chooses; a choice off the eligible list is refused', async () => {
    const eligible = [{ model: 'DCF921B' }, { model: 'DCB606' }];
    const first = (await (await ui(`/api/deals/${id}/bogo`, { method: 'POST', body: JSON.stringify({ eligible }) })).json()) as BogoResponse;
    expect(first.bogo).toMatchObject({ status: 'choose', label: 'BOGO: choose your free tool', note: '+ free tool not counted yet' });
    const refused = await ui(`/api/deals/${id}/bogo`, { method: 'POST', body: JSON.stringify({ chosen: [{ model: 'DCS354B' }] }) });
    expect(refused.status).toBe(409);
    const chosen = (await (await ui(`/api/deals/${id}/bogo`, { method: 'POST', body: JSON.stringify({ chosen: [{ model: 'DCF921B' }] }) })).json()) as BogoResponse;
    // The agent's scan store has no match for the free tool: it is not counted, and says why.
    expect(chosen.bogo).toMatchObject({ status: 'chosen', label: 'BOGO: DCF921B free', note: '+ DCF921B not counted yet (not looked up on Amazon yet)' });
    const d = (await (await ui(`/api/deals/${id}`)).json()) as DealDetail;
    expect(d.row.bogo).toBe('chosen');
    expect(d.bogo?.estimate?.profit).toBe(81.8);
    expect(((await (await ui(`/api/deals/${id}/bogo`, { method: 'DELETE' })).json()) as BogoResponse).bogo).toBeNull();
  });

  it('PATCH /api/settings takes the velocity minimum, the floor and the marginDown digest', async () => {
    const res = await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ alerts: { minMonthlySold: 100, floorProfit: 5, marginDownDigest: true } }) });
    expect(res.status).toBe(200);
    expect(agent.store.get('settings').alerts).toMatchObject({ minMonthlySold: 100, floorProfit: 5, marginDownDigest: true });
    expect((await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ alerts: { minMonthlySold: 2.5 } }) })).status).toBe(400);
  });
});
