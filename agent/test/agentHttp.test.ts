import { mkdtempSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type Agent } from '../app';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;

let server: Server;
let agent: Agent;
let base: string;
let port: number;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-http-')), port, timers: false });
  server.on('request', agent.handle);
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ui(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function pairExtension(): Promise<string> {
  const req = await fetch(`${base}/api/pair/request`, {
    method: 'POST',
    headers: { Origin: EXT_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ extensionId: EXT }),
  });
  expect(req.status).toBe(200);
  const { requestId, claimSecret } = (await req.json()) as { requestId: string; claimSecret: string };
  const claim = () =>
    fetch(`${base}/api/pair/claim`, {
      method: 'POST',
      headers: { Origin: EXT_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, claimSecret }),
    }).then((r) => r.json() as Promise<{ status: string; token?: string }>);
  expect((await claim()).status).toBe('pending');
  const pending = (await (await ui('/api/pair/requests')).json()) as { requestId: string }[];
  expect(pending.map((p) => p.requestId)).toEqual([requestId]);
  expect((await ui('/api/pair/approve', { method: 'POST', body: JSON.stringify({ requestId }) })).status).toBe(200);
  const claimed = await claim();
  expect(claimed.status).toBe('approved');
  return claimed.token!;
}

function ext(token: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('agent HTTP', () => {
  it('needs a token, the right Host and an allowed Origin, and answers errors in the contract shape', async () => {
    const none = await fetch(`${base}/api/state`);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    expect((await ui('/api/state', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await ui('/api/state', { headers: { Origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    const rebound = await rawGet('/api/state', { Host: `evil.example:${port}`, Authorization: `Bearer ${agent.auth.uiToken}` });
    expect(rebound.status).toBe(403);
    expect((await ui('/api/nothing')).status).toBe(404);
    expect((await ui('/api/state', { method: 'DELETE' })).status).toBe(405);
  });

  it('takes keys in and never gives one back', async () => {
    const put = await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: 'secret-serp-123' }) });
    expect(await put.json()).toMatchObject({ serpapi: true, keepa: false });
    await ui('/api/keys/ebay', { method: 'PUT', body: JSON.stringify({ appId: 'secret-app', certId: 'secret-cert' }) });
    for (const path of ['/api/settings', '/api/state', '/api/helper/settings', '/api/activity', '/api/deals', '/api/review']) {
      const text = await (await ui(path)).text();
      expect(text).not.toContain('secret-');
    }
    const settings = (await (await ui('/api/settings')).json()) as { keys: Record<string, boolean> };
    expect(settings.keys).toMatchObject({ serpapi: true, ebay: true, anthropic: false });
    const removed = await ui('/api/keys/serpapi', { method: 'DELETE' });
    expect(await removed.json()).toMatchObject({ serpapi: false });
    expect((await ui('/api/keys/nope', { method: 'PUT', body: '{"key":"x"}' })).status).toBe(404);
  });

  it('refuses a body over the limit and bad JSON', async () => {
    const big = await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }) });
    expect(big.status).toBe(413);
    const bad = await ui('/api/settings', { method: 'PATCH', body: '{nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('bad_request');
  });

  it('saves a settings patch and checks its types', async () => {
    const ok = await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ autopilot: false, settings: { searchesPerScan: 9 } }) });
    expect(await ok.json()).toMatchObject({ settings: { autopilot: false, settings: { searchesPerScan: 9 } } });
    expect((await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ autopilot: 'yes' }) })).status).toBe(400);
  });

  it('pairs an extension, which then works jobs but cannot do what only the app may', async () => {
    const token = await pairExtension();
    expect((await ext(token, '/api/keys/serpapi', { method: 'PUT', body: '{"key":"x"}' })).status).toBe(403);
    expect((await ext(token, '/api/pair/approve', { method: 'POST', body: '{"requestId":"x"}' })).status).toBe(403);
    // Its token from another origin is refused.
    expect((await ext(token, '/api/state', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);

    expect((await ext(token, '/api/worker/next?wait=0')).status).toBe(204);
    const job = (await (await ui('/api/worker/jobs', { method: 'POST', body: JSON.stringify({ kind: 'kitPage', input: { itemId: '314', model: 'DCK240C2' } }) })).json()) as { id: string };
    const next = (await (await ext(token, '/api/worker/next?wait=1')).json()) as { job: { id: string; kind: string; attempt: number } };
    expect(next.job).toMatchObject({ id: job.id, kind: 'kitPage', attempt: 1 });
    const done = await ext(token, '/api/worker/result', { method: 'POST', body: JSON.stringify({ id: job.id, ok: true, result: { items: [] } }) });
    expect(await done.json()).toEqual({ status: 'done' });

    const state = (await (await ui('/api/state')).json()) as { helper: { paired: boolean; connected: boolean } };
    expect(state.helper).toMatchObject({ paired: true, connected: true });

    expect((await ui(`/api/pair/extensions/${EXT}`, { method: 'DELETE' })).status).toBe(200);
    expect((await ext(token, '/api/state')).status).toBe(401);
  });

  it('answers a CORS preflight only for pairing extensions, paired ones and the app', async () => {
    const pre = await fetch(`${base}/api/pair/request`, { method: 'OPTIONS', headers: { Origin: EXT_ORIGIN } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(EXT_ORIGIN);
    expect((await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { Origin: EXT_ORIGIN } })).status).toBe(403);
    expect((await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('pauses and resumes, and the state says so', async () => {
    expect(await (await ui('/api/agent/pause', { method: 'POST', body: '{}' })).json()).toEqual({ paused: true });
    expect(((await (await ui('/api/state')).json()) as { agent: { status: string } }).agent.status).toBe('paused');
    await ui('/api/agent/resume', { method: 'POST', body: '{}' });
    expect(((await (await ui('/api/state')).json()) as { agent: { status: string } }).agent.status).toBe('idle');
  });

  it('streams state first, then notify events, to a caller with no Origin (the shell)', async () => {
    const chunks: string[] = [];
    const got = new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { Authorization: `Bearer ${agent.auth.uiToken}` } }, (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks.push(c);
          const all = chunks.join('');
          if (all.includes('event: state') && !all.includes('event: notify')) {
            agent.notify({ kind: 'review', title: 'Split Finder', body: '2 questions need you', count: 2 });
          }
          if (all.includes('event: notify')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (e) => (chunks.join('').includes('event: notify') ? resolve() : reject(e)));
      req.end();
    });
    await got;
    const all = chunks.join('');
    expect(all).toMatch(/event: state\ndata: \{"agent":\{"status":"idle"/);
    expect(all).toContain('"counts":{"review":0');
    expect(all).toMatch(/event: notify\ndata: .*"kind":"review".*"count":2/);
  });
});
