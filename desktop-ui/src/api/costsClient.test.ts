// The two calls the Costs screen makes, against a fake fetch: no agent, no network. The route shapes are the contract
// with the agent side (GET /api/costs, PATCH /api/settings { costs }).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCostsView, costSettingsFor } from './mockCosts';
import { createHttpClient } from './http';
import { createMockClient } from './mock';
import { patchOf } from '../lib/costs';

const NOW = new Date(2026, 10, 14, 10);
const view = buildCostsView('calm', costSettingsFor('calm', NOW), NOW);

afterEach(() => vi.unstubAllGlobals());

function fakeFetch(answers: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${init.method} ${path}`;
    if (!(key in answers)) return new Response(JSON.stringify({ error: { message: `not faked: ${key}` } }), { status: 500 });
    return new Response(JSON.stringify(answers[key]), { status: 200 });
  });
  return calls;
}

describe('the costs calls', () => {
  it('reads GET /api/costs as the agent answers it', async () => {
    const calls = fakeFetch({ 'GET /api/costs': view });
    const got = await createHttpClient().costs();
    expect(got.total.sentence).toBe(view.total.sentence);
    expect(calls).toEqual([{ method: 'GET', path: '/api/costs', body: undefined }]);
  });

  it('saves only what changed under `costs` in PATCH /api/settings, then asks for the view again', async () => {
    const calls = fakeFetch({ 'PATCH /api/settings': { settings: {} }, 'GET /api/costs': view });
    const patch = patchOf({ kind: 'limit', service: 'serpapi' }, 120);
    const got = await createHttpClient().patchCosts(patch);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /api/settings', 'GET /api/costs']);
    expect(calls[0]!.body).toEqual({ costs: { services: { serpapi: { monthlyLimit: 120 } } } });
    expect(got.month).toBe(view.month);
  });

  it('sends a null to clear a limit, not nothing', async () => {
    const calls = fakeFetch({ 'PATCH /api/settings': { settings: {} }, 'GET /api/costs': view });
    await createHttpClient().patchCosts(patchOf({ kind: 'total' }, null));
    expect(calls[0]!.body).toEqual({ costs: { totalMonthlyUsd: null } });
  });

  it('shows the agent’s own sentence when it refuses a value', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'invalid', message: 'The AI limit cannot be below 0.' } }), { status: 400 }));
    await expect(createHttpClient().patchCosts(patchOf({ kind: 'limit', service: 'ai' }, -1))).rejects.toMatchObject({ message: 'The AI limit cannot be below 0.' });
  });
});

describe('the mock agent answers in the same shape', () => {
  it('keeps a saved limit and moves the states with it', async () => {
    const mock = createMockClient();
    const before = await mock.costs();
    expect(before.services[0]!.state).toBe('ok');
    const after = await mock.patchCosts(patchOf({ kind: 'limit', service: 'serpapi' }, 5));
    expect(after.settings.services.serpapi.monthlyLimit).toBe(5);
    expect(after.services[0]!.state).toBe('over');
    expect((await mock.costs()).settings.services.serpapi.monthlyLimit).toBe(5);
  });
});
