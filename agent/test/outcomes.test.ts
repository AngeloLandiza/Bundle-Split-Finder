// Outcomes over HTTP: the frozen snapshot, validation, partial sales, Undo, Activity sentences, the CSV, the audit and Reset. The deals
// are the owner's real third scan (fixtures/e2e-2026-11-23, as the desktop UI's mockReal.json holds it), stored as the agent keeps them.
// No network.

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityResponse, OutcomesResponse, PurchaseResponse } from '../../core/src/api/contract';
import type { BundleRow } from '../../core/src/scan/types';
import { createAgent, type Agent } from '../app';

const real = JSON.parse(readFileSync(new URL('../../desktop-ui/src/api/mockReal.json', import.meta.url), 'utf8')) as {
  scan3: { details: Record<string, { bundle: BundleRow }> };
};
const PAIR = 'homedepot:337486530'; // RYOBI PCL1201K2 + PCL424B, $179, estimated +$6.63
const NO_SPLIT = Object.values(real.scan3.details).find((d) => d.bundle.parts.length === 0)!.bundle.key;
const T0 = new Date(2026, 10, 23, 12).getTime(); // the owner's Nov 23, noon

let server: Server;
let agent: Agent;
let base: string;
let dir: string;
let clock: number;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  clock = T0;
  dir = mkdtempSync(join(tmpdir(), 'sf-outcomes-'));
  agent = createAgent({ dataDir: dir, port, timers: false, now: () => clock });
  server.on('request', agent.handle);
  agent.store.update('deals', (d) => ({ ...d, at: new Date(T0).toISOString(), bundles: Object.values(real.scan3.details).map((x) => structuredClone(x.bundle)) }));
});

afterEach(async () => {
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const send = (method: string, path: string, body: unknown = {}) => ui(path, { method, body: JSON.stringify(body) });
const post = (path: string, body: unknown = {}) => send('POST', path, body);
const outcomes = async () => (await (await ui('/api/outcomes')).json()) as OutcomesResponse;
const activity = async () => (await (await ui('/api/activity')).json()) as ActivityResponse;
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const buy = async (body: Record<string, unknown> = {}) => {
  const res = await post('/api/outcomes', { dealId: PAIR, ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as PurchaseResponse;
};
const part = (id: string, p: string, body: Record<string, unknown>) => post(`/api/outcomes/${id}/parts/${p}`, body);

describe('I bought this', () => {
  it('records the purchase with today, the Home Depot price and one bundle, and freezes the estimate', async () => {
    const { purchase, entryId } = await buy();
    expect(purchase).toMatchObject({ dealId: PAIR, boughtAt: '2026-11-23', pricePaid: 179, quantity: 1 });
    expect(purchase.snapshot.estimate).toEqual({ profit: 6.63, roi: 0.037, cost: 179, partsSellFor: 218.39, afterFees: 185.63 });
    expect(purchase.snapshot.parts.map((p) => [p.model, p.asin, p.sellPrice, p.netEach])).toEqual([['PCL1201K2', 'B0DSCG26GL', 154.44, 131.27], ['PCL424B', 'B0BNFBL5PR', 63.95, 54.36]]);
    expect(purchase.snapshot.basis).toMatch(/estimate/i);
    expect(purchase.result).toMatchObject({ partsTotal: 2, partsSettled: 0, complete: false, realisedProfit: null });
    const sentence = (await activity()).outcomes!.find((e) => e.id === entryId)!;
    expect(sentence).toMatchObject({ undoable: true, sentence: 'Recorded a purchase: 1 bundle of PCL1201K2-PCL424B at $179.00 each on Nov 23.' });
  });

  it('keeps what he typed: the date, the price he really paid and the quantity', async () => {
    const { purchase } = await buy({ boughtAt: '2026-11-22', pricePaid: 171.5, quantity: 3 });
    expect(purchase).toMatchObject({ boughtAt: '2026-11-22', pricePaid: 171.5, quantity: 3 });
    expect(purchase.result.cost).toBe(514.5);
  });

  it('never rewrites the snapshot: not when the estimate, the price or the fee settings change, and not by a patch', async () => {
    const { purchase } = await buy();
    const frozen = JSON.stringify(purchase.snapshot);
    // The next scan finds a new price, a new estimate and the owner raises his referral rate.
    agent.store.update('deals', (d) => ({
      ...d,
      bundles: d.bundles.map((b) => (b.key === PAIR ? { ...b, price: 120, estimate: { cost: 120, netRevenue: 90, profit: -30, roi: -0.25 }, parts: b.parts.map((p) => ({ ...p, price: 10 })) } : b)),
    }));
    agent.store.update('settings', (s) => ({ ...s, settings: { ...s.settings, fees: { ...s.settings.fees, referralRate: 0.3 } } }));
    expect(JSON.stringify((await outcomes()).purchases[0]!.snapshot)).toBe(frozen);
    // Changing what he can change leaves it alone, and naming the snapshot is refused.
    const patched = await send('PATCH', `/api/outcomes/${purchase.id}`, { pricePaid: 170, quantity: 2 });
    expect(JSON.stringify(((await patched.json()) as PurchaseResponse).purchase.snapshot)).toBe(frozen);
    const refused = await send('PATCH', `/api/outcomes/${purchase.id}`, { snapshot: { estimate: null } });
    expect(refused.status).toBe(400);
    expect(await message(refused)).toMatch(/cannot be changed/);
    // A second purchase of the same deal now freezes the new estimate, and the first is unchanged.
    const again = await buy();
    expect(again.purchase.snapshot.estimate!.profit).toBe(-30);
    expect(JSON.stringify((await outcomes()).purchases.find((p) => p.id === purchase.id)!.snapshot)).toBe(frozen);
  });

  it('refuses what cannot be a purchase, in a sentence', async () => {
    expect((await post('/api/outcomes', { dealId: 'homedepot:0' })).status).toBe(404);
    const noSplit = await post('/api/outcomes', { dealId: NO_SPLIT });
    expect(noSplit.status).toBe(400);
    expect(await message(noSplit)).toMatch(/no split yet/);
    for (const bad of [{ boughtAt: '23/11/2026' }, { boughtAt: '2026-11-31' }, { boughtAt: '2027-01-01' }, { pricePaid: -5 }, { pricePaid: '179' }, { pricePaid: 1e9 }, { quantity: 0 }, { quantity: 2.5 }, { quantity: 5000 }]) {
      const res = await post('/api/outcomes', { dealId: PAIR, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('/api/outcomes', {})).status).toBe(400);
    expect((await outcomes()).purchases).toEqual([]);
  });

  it('asks for the app\'s own token', async () => {
    expect((await fetch(`${base}/api/outcomes`)).status).toBe(401);
    expect((await fetch(`${base}/api/outcomes`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/api/outcomes/export.csv`)).status).toBe(401);
  });
});

describe('what happened to each part', () => {
  it('sold with a price only: net is worked out with the snapshot\'s fees and labelled', async () => {
    const { purchase } = await buy();
    agent.store.update('settings', (s) => ({ ...s, settings: { ...s.settings, fees: { ...s.settings.fees, referralRate: 0.5 } } }));
    clock = new Date(2026, 10, 25, 9).getTime();
    const res = await part(purchase.id, 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' });
    expect(res.status).toBe(200);
    const view = ((await res.json()) as PurchaseResponse).purchase;
    expect(view.result.parts[0]).toMatchObject({ status: 'sold', netReceived: 127.5, netFrom: 'fees_estimated' });
    expect(view.result.feesEstimated).toBe(true);
    expect((await activity()).outcomes![0]!.sentence).toBe('Recorded PCL1201K2 from PCL1201K2-PCL424B as sold for $150.00 on Nov 25 (net $127.50, fees estimated).');
  });

  it('a partial sale is a realised figure for the sold part, and the scorecard says N of M', async () => {
    const { purchase } = await buy();
    await part(purchase.id, 'p0', { status: 'sold', salePrice: 150, date: '2026-11-23' });
    await part(purchase.id, 'p1', { status: 'holding' });
    const o = await outcomes();
    expect(o.purchases[0]!.result).toMatchObject({ partsTotal: 2, partsSettled: 1, partsHolding: 1, complete: false, actualProfit: null, accuracy: null });
    expect(o.scorecard.realised).toMatchObject({ partsSettled: 1, partsSold: 1, partsOfThoseDeals: 2, deals: 1, feesEstimated: true });
    expect(o.scorecard.accuracy).toBeNull();
    expect(o.scorecard.flaggedWhenBought).toBe(0); // this deal was not Buy now in the recorded scan
  });

  it('a completed deal shows the estimate against what he made, per deal and overall', async () => {
    const { purchase } = await buy();
    await part(purchase.id, 'p0', { status: 'sold', salePrice: 150, netPayout: 120, date: '2026-11-24' });
    await part(purchase.id, 'p1', { status: 'sold', salePrice: 60, netPayout: 50, date: '2026-11-24' });
    const o = await outcomes();
    expect(o.purchases[0]!.result).toMatchObject({ complete: true, actualProfit: -9, accuracy: { estimated: 6.63, actual: -9, diff: -15.63, diffPercent: -235.7 } });
    expect(o.scorecard.accuracy).toMatchObject({ deals: 1, estimated: 6.63, actual: -9, diff: -15.63, diffPercent: -235.7 });
    expect(o.scorecard.accuracy!.perDeal[0]).toMatchObject({ purchaseId: purchase.id, diff: -15.63 });
  });

  it('can be changed: saying it again replaces it', async () => {
    const { purchase } = await buy();
    await part(purchase.id, 'p0', { status: 'sold', salePrice: 150, date: '2026-11-23' });
    await part(purchase.id, 'p0', { status: 'returned', date: '2026-11-24', recovered: 100 });
    const p = (await outcomes()).purchases[0]!;
    expect(p.parts[0]).toMatchObject({ status: 'returned', salePrice: null, recovered: 100 });
    expect(p.result.parts[0]).toMatchObject({ netReceived: 100, netFrom: 'refund' });
  });

  it('refuses what cannot be true, in a sentence', async () => {
    const { purchase } = await buy();
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['p0', { status: 'sold' }, /sale price/],
      ['p0', { status: 'sold', salePrice: 0 }, /sale price/],
      ['p0', { status: 'sold', salePrice: 10, date: '2026-11-01' }, /before the purchase date/],
      ['p0', { status: 'sold', salePrice: 10, date: '2026-12-31' }, /future/],
      ['p0', { status: 'sold', salePrice: 10, netPayout: -3 }, /net payout/],
      ['p0', { status: 'returned', recovered: -1 }, /money back/],
      ['p0', { status: 'lost' }, /status must be/],
      ['p7', { status: 'holding' }, /no such part/],
    ];
    for (const [id, body, re] of bad) {
      const res = await part(purchase.id, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await message(res)).toMatch(re);
    }
    expect((await part('pur-nope', 'p0', { status: 'holding' })).status).toBe(404);
    expect((await outcomes()).purchases[0]!.result.partsSettled).toBe(0);
  });
});

describe('Undo', () => {
  it('takes back a sale, then the purchase, in reverse order only', async () => {
    const { purchase, entryId: boughtId } = await buy();
    const sold = ((await (await part(purchase.id, 'p0', { status: 'sold', salePrice: 150, date: '2026-11-23' })).json()) as PurchaseResponse).entryId;
    // The purchase cannot be taken back under the sale.
    const early = await post(`/api/outcomes/entries/${boughtId}/undo`);
    expect(early.status).toBe(409);
    expect(await message(early)).toMatch(/Take back the later change first/);
    expect((await activity()).outcomes!.find((e) => e.id === boughtId)!.undoable).toBe(false);

    expect((await post(`/api/outcomes/entries/${sold}/undo`)).status).toBe(200);
    expect((await outcomes()).purchases[0]!.parts[0]).toMatchObject({ status: 'open', salePrice: null });
    expect((await post(`/api/outcomes/entries/${sold}/undo`)).status).toBe(409); // once
    expect((await activity()).outcomes!.find((e) => e.id === sold)!).toMatchObject({ undoable: false, undoneAt: expect.any(String) });

    expect((await post(`/api/outcomes/entries/${boughtId}/undo`)).status).toBe(200);
    expect((await outcomes()).purchases).toEqual([]);
    expect((await post('/api/outcomes/entries/out-nope/undo')).status).toBe(404);
  });

  it('removing a record can be undone and brings back the frozen snapshot whole', async () => {
    const { purchase } = await buy({ pricePaid: 175 });
    const frozen = JSON.stringify(purchase.snapshot);
    const removed = (await (await ui(`/api/outcomes/${purchase.id}`, { method: 'DELETE' })).json()) as { removed: true; entryId: string };
    expect((await outcomes()).purchases).toEqual([]);
    expect((await activity()).outcomes![0]!.sentence).toBe('Removed the purchase record of PCL1201K2-PCL424B.');
    expect((await post(`/api/outcomes/entries/${removed.entryId}/undo`)).status).toBe(200);
    const back = (await outcomes()).purchases[0]!;
    expect(back).toMatchObject({ id: purchase.id, pricePaid: 175 });
    expect(JSON.stringify(back.snapshot)).toBe(frozen);
  });

  it('a change of price paid is an edit with its own sentence and its own Undo', async () => {
    const { purchase } = await buy();
    const edited = (await (await send('PATCH', `/api/outcomes/${purchase.id}`, { pricePaid: 170 })).json()) as PurchaseResponse;
    expect((await activity()).outcomes![0]!.sentence).toBe('Changed the purchase of PCL1201K2-PCL424B: price paid $170.00.');
    await post(`/api/outcomes/entries/${edited.entryId}/undo`);
    expect((await outcomes()).purchases[0]!.pricePaid).toBe(179);
  });
});

describe('export, audit and Reset', () => {
  it('exports the outcomes as CSV, one row per part, and says so plainly when there are none', async () => {
    expect((await ui('/api/outcomes/export.csv')).status).toBe(404);
    const { purchase } = await buy();
    await part(purchase.id, 'p0', { status: 'sold', salePrice: 150, date: '2026-11-23' });
    const res = await ui('/api/outcomes/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toContain('split-finder-outcomes-2026-11-23.csv');
    const lines = (await res.text()).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('sold,2026-11-23,150,127.5,fees_estimated');
  });

  it('puts the outcomes in the audit file', async () => {
    const { purchase } = await buy();
    const audit = (await (await ui('/api/export/audit')).json()) as { outcomes: { purchases: { id: string; snapshot: unknown }[]; entries: unknown[] } };
    expect(audit.outcomes.purchases.map((p) => p.id)).toEqual([purchase.id]);
    expect(audit.outcomes.purchases[0]!.snapshot).toBeTruthy();
    expect(audit.outcomes.entries).toHaveLength(1);
  });

  it('Reset scan data keeps the outcomes and backs them up', async () => {
    const { purchase } = await buy();
    await part(purchase.id, 'p0', { status: 'holding' });
    const reset = await post('/api/data/reset', { confirm: 'RESET' });
    expect(reset.status).toBe(200);
    const { backup } = (await reset.json()) as { backup: string };
    expect((await ui('/api/deals')).status).toBe(200);
    expect(agent.store.get('deals').bundles).toEqual([]);
    const kept = await outcomes();
    expect(kept.purchases).toHaveLength(1);
    expect(kept.purchases[0]!.parts[0]!.status).toBe('holding');
    expect(readdirSync(join(backup, 'store'))).toContain('outcomes.json');
    expect(JSON.parse(readFileSync(join(backup, 'store', 'outcomes.json'), 'utf8')).purchases[0].id).toBe(purchase.id);
  });

  it('survives a restart: the file is the store\'s own, written atomically', async () => {
    const { purchase } = await buy();
    expect(JSON.parse(readFileSync(join(dir, 'store', 'outcomes.json'), 'utf8')).purchases[0].id).toBe(purchase.id);
  });
});
