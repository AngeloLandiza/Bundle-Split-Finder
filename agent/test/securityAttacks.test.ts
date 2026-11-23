// Security review, Nov 23 (docs/security-review-2026-11-23.md): attack-shaped requests against the agent's HTTP
// surface. Each test is what a hostile web page, a stranger on this computer or a hostile page text would try; each
// must be refused and leave nothing changed. No network beyond the loopback listener the test opens.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PAIR_REQUEST_TTL_MS } from '../auth';
import { createAgent, type Agent } from '../app';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;
const SECRET = 'the owner keys file';

let server: Server;
let agent: Agent;
let port: number;
let base: string;
let clock: number;
let uiDir: string;
const savedUiDir = process.env.SPLIT_FINDER_UI_DIR;

beforeEach(async () => {
  // A built UI folder with a secret file beside it, where a traversal would land.
  const root = mkdtempSync(join(tmpdir(), 'sf-attack-'));
  uiDir = join(root, 'ui');
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Split Finder</title>');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, 'secret.txt'), SECRET);
  process.env.SPLIT_FINDER_UI_DIR = uiDir;

  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  clock = Date.UTC(2026, 10, 23, 12);
  agent = createAgent({ dataDir: join(root, 'data'), port, timers: false, shippedHelperVersion: null, now: () => clock });
  server.on('request', agent.handle);
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedUiDir === undefined) delete process.env.SPLIT_FINDER_UI_DIR;
  else process.env.SPLIT_FINDER_UI_DIR = savedUiDir;
});

/**
 * One request exactly as given (the path is not normalised by a URL parser), resolved with the status and up to 64 KB of
 * the body; a stream (the event stream) is cut after its first chunk.
 */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      const done = () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers });
      res.on('data', (c: Buffer) => {
        text += c.toString('utf8');
        if (res.headers['content-type']?.startsWith('text/event-stream') || text.length > 65_536) {
          res.destroy();
          done();
        }
      });
      res.on('end', done);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const uiToken = () => agent.auth.uiToken;
const asUi = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${uiToken()}`, 'Content-Type': 'application/json', ...extra });

async function pairExtension(): Promise<string> {
  const req = await raw('POST', '/api/pair/request', { Origin: EXT_ORIGIN, 'Content-Type': 'application/json' }, JSON.stringify({ extensionId: EXT }));
  const { requestId, claimSecret } = JSON.parse(req.body) as { requestId: string; claimSecret: string };
  await raw('POST', '/api/pair/approve', asUi(), JSON.stringify({ requestId }));
  const claimed = await raw('POST', '/api/pair/claim', { Origin: EXT_ORIGIN, 'Content-Type': 'application/json' }, JSON.stringify({ requestId, claimSecret }));
  return (JSON.parse(claimed.body) as { token: string }).token;
}

describe('a web page calling the agent (CSRF, DNS rebinding)', () => {
  it('refuses the app token from a foreign Origin on every method, the event stream included, and changes nothing', async () => {
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${port + 1}`, EXT_ORIGIN]) {
      expect((await raw('POST', '/api/agent/pause', asUi({ Origin: origin }))).status).toBe(403);
      expect((await raw('PATCH', '/api/settings', asUi({ Origin: origin }), JSON.stringify({ autopilot: true }))).status).toBe(403);
      expect((await raw('PUT', '/api/keys/serpapi', asUi({ Origin: origin }), JSON.stringify({ key: 'attacker-key' }))).status).toBe(403);
      expect((await raw('GET', '/api/state', asUi({ Origin: origin }))).status).toBe(403);
      expect((await raw('GET', '/api/events', asUi({ Origin: origin }))).status).toBe(403);
      expect((await raw('GET', '/api/deals/export.csv', asUi({ Origin: origin }))).status).toBe(403);
    }
    expect(agent.store.get('agent').paused).toBe(false);
    expect(agent.store.get('keys').serpapi).toBeUndefined();
  });

  it('gives no token-less caller anything but the hello proof and the pairing calls, and answers no foreign preflight', async () => {
    for (const [method, path] of [['GET', '/api/state'], ['GET', '/api/events'], ['POST', '/api/scan'], ['POST', '/api/worker/jobs'], ['POST', '/api/agent/quit']] as const) {
      expect((await raw(method, path, { Origin: 'https://evil.example' })).status).toBe(401);
    }
    const preflight = await raw('OPTIONS', '/api/settings', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PATCH' });
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a rebound host name on the API, the token-less routes and the app page alike', async () => {
    for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, '127.0.0.1', `[::1]:${port}`]) {
      expect((await raw('GET', '/api/state', asUi({ Host: host }))).status).toBe(403);
      expect((await raw('GET', `/api/hello?nonce=${'a'.repeat(32)}`, { Host: host })).status).toBe(403);
      expect((await raw('POST', '/api/pair/request', { Host: host, Origin: EXT_ORIGIN }, JSON.stringify({ extensionId: EXT }))).status).toBe(403);
      expect((await raw('GET', '/ui/', { Host: host })).status).toBe(403);
    }
    expect(agent.auth.pendingRequests()).toEqual([]);
  });

  it('does not take the token from the address or a cookie, only from the Authorization header', async () => {
    expect((await raw('GET', `/api/state?token=${uiToken()}`)).status).toBe(401);
    expect((await raw('GET', '/api/state', { Cookie: `token=${uiToken()}` })).status).toBe(401);
    expect((await raw('GET', '/api/state', { Authorization: `Bearer ${uiToken()}x` })).status).toBe(401);
    expect((await raw('GET', '/api/state', { Authorization: uiToken() })).status).toBe(401);
  });
});

describe('a traversal path to the app page', () => {
  it('serves the app and its files, and never a file outside its folder', async () => {
    const page = await raw('GET', '/ui/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await raw('GET', '/ui/assets/app.js')).body).toBe('console.log(1)');
    for (const path of [
      '/ui/../secret.txt',
      '/ui/..%2fsecret.txt',
      '/ui/%2e%2e/secret.txt',
      '/ui/%2e%2e%2fsecret.txt',
      '/ui/..\\secret.txt',
      '/ui/..%5csecret.txt',
      '/ui/assets/../../secret.txt',
      '/ui/%252e%252e/secret.txt',
      '/ui/.%00./secret.txt',
      '/ui//../secret.txt',
      `/ui/${encodeURIComponent(join(uiDir, '..', 'secret.txt'))}`,
      '/uisecret.txt/../../secret.txt',
    ]) {
      const res = await raw('GET', path);
      expect(res.body, path).not.toContain(SECRET);
    }
  });

  it('answers nothing but GET outside /api', async () => {
    expect((await raw('POST', '/ui/', { 'Content-Type': 'application/json' }, '{}')).status).toBe(405);
    expect((await raw('PUT', '/ui/x.js', {}, 'x')).status).toBe(405);
  });
});

describe('malformed or oversized worker job input from the app', () => {
  const job = (kind: string, input: unknown) => raw('POST', '/api/worker/jobs', asUi(), JSON.stringify({ kind, input }));

  it('refuses an input the helper would refuse, so no such job is ever queued', async () => {
    const refused: [string, unknown][] = [
      ['page', { itemIds: [{}] }],
      ['page', { itemIds: ['../../account'] }],
      ['page', { itemIds: ['314?x=1'] }],
      ['page', { itemIds: ['1'.repeat(13)] }],
      ['page', { itemIds: Array.from({ length: 51 }, (_, i) => String(300000000 + i)) }],
      ['page', { itemIds: [] }],
      ['promoPage', { itemIds: ['https://evil.example/p/314'] }],
      ['kitPage', { itemId: '314/../../x', model: 'DCK240C2' }],
      ['kitPage', { itemId: -1, model: 'DCK240C2' }],
      ['partPrice', { itemId: '314', model: 'x'.repeat(65) }],
      ['researchPage', { itemId: 'javascript:alert(1)' }],
      ['search', { query: 'x'.repeat(201) }],
      ['search', { query: 'drill', page: 2 }],
      ['bogoListing', { path: 'https://evil.example/' }],
      ['bogoListing', { path: '/p/../../account/settings' }],
      ['bogoListing', { path: '/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-ryobi?NCNI-5&redirect=https://evil.example' }],
      ['shell', {}],
      ['page', 'itemIds=314'],
    ];
    for (const [kind, input] of refused) {
      const res = await job(kind, input);
      expect(res.status, `${kind} ${JSON.stringify(input).slice(0, 60)}`).toBe(400);
    }
    expect(agent.jobs.waitingCount()).toBe(0);
  });

  it('still queues what the helper reads', async () => {
    expect((await job('page', { itemIds: ['314', 320222321] })).status).toBe(200);
    expect((await job('search', { query: 'RYOBI PCL1600K2', page: 1 })).status).toBe(200);
    expect((await job('bogoListing', { path: '/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5&Nao=24' })).status).toBe(200);
    expect((await job('reload', {})).status).toBe(200);
    expect(agent.jobs.waitingCount()).toBe(4);
  });

  it('refuses a body over the limit and queues nothing', async () => {
    const big = JSON.stringify({ kind: 'search', input: { query: 'drill' }, pad: 'x'.repeat(1024 * 1024 + 10) });
    const res = await raw('POST', '/api/worker/jobs', asUi({ 'Content-Length': String(Buffer.byteLength(big)) }), big).catch(() => ({ status: 'reset' as const }));
    expect(res.status === 413 || res.status === 'reset').toBe(true);
    expect(agent.jobs.waitingCount()).toBe(0);
  });

  it('lets only the app queue jobs: the paired extension cannot', async () => {
    const token = await pairExtension();
    const res = await raw('POST', '/api/worker/jobs', { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN, 'Content-Type': 'application/json' }, JSON.stringify({ kind: 'search', input: { query: 'drill' } }));
    expect(res.status).toBe(403);
    expect(agent.jobs.waitingCount()).toBe(0);
  });
});

describe('pairing by brute force', () => {
  const ask = (origin: string, extensionId = EXT) =>
    raw('POST', '/api/pair/request', { Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ extensionId }));
  const claim = (requestId: string, claimSecret: string, origin = EXT_ORIGIN) =>
    raw('POST', '/api/pair/claim', { Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ requestId, claimSecret }));

  it('never takes the six-digit code as a credential, and no number of guesses claims a token', async () => {
    const { requestId, code, claimSecret } = JSON.parse((await ask(EXT_ORIGIN)).body) as { requestId: string; code: string; claimSecret: string };
    expect(code).toMatch(/^\d{6}$/);
    expect(claimSecret.length).toBeGreaterThanOrEqual(43);
    await raw('POST', '/api/pair/approve', asUi(), JSON.stringify({ requestId }));
    // The code itself, then a run of guesses: each is refused, and none spends the approval.
    expect((await claim(requestId, code)).status).toBe(403);
    for (let i = 0; i < 200; i++) expect((await claim(requestId, String(i).padStart(6, '0'))).status).toBe(403);
    // A guess at the request id does not find it.
    expect((await claim(`pair-${'0'.repeat(16)}`, claimSecret)).status).toBe(404);
    // From another origin, even with the secret: refused.
    expect((await claim(requestId, claimSecret, 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba')).status).toBe(403);
    expect(agent.auth.pairedExtensions()).toEqual([]);
    // The extension that asked still gets its token, once.
    const ok = JSON.parse((await claim(requestId, claimSecret)).body) as { status: string; token?: string };
    expect(ok.status).toBe('approved');
    expect((await claim(requestId, claimSecret)).status).toBe(404);
  });

  it('only the app approves, a web page cannot ask, and a request lives ten minutes', async () => {
    expect((await ask('https://evil.example')).status).toBe(403);
    expect((await raw('POST', '/api/pair/request', { 'Content-Type': 'application/json' }, JSON.stringify({ extensionId: EXT }))).status).toBe(403);
    const { requestId, claimSecret } = JSON.parse((await ask(EXT_ORIGIN)).body) as { requestId: string; claimSecret: string };
    // The extension cannot approve itself, with or without a token.
    expect((await raw('POST', '/api/pair/approve', { Origin: EXT_ORIGIN, 'Content-Type': 'application/json' }, JSON.stringify({ requestId }))).status).toBe(401);
    clock += PAIR_REQUEST_TTL_MS + 1;
    expect((await raw('POST', '/api/pair/approve', asUi(), JSON.stringify({ requestId }))).status).toBe(404);
    expect((await claim(requestId, claimSecret)).status).toBe(404);
    expect(agent.auth.pairedExtensions()).toEqual([]);
  });

  it('keeps at most five requests waiting, one per extension', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => l.repeat(32));
    const statuses = [];
    for (const id of ids) statuses.push((await ask(`chrome-extension://${id}`, id)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 409]);
    // Asking again from the same extension replaces its own request; it never adds a second.
    expect((await ask('chrome-extension://' + 'a'.repeat(32), 'a'.repeat(32))).status).toBe(200);
    expect(agent.auth.pendingRequests()).toHaveLength(5);
  });
});

describe('what a paired extension may not do', () => {
  it('cannot act as the app, read a key, or answer for another extension origin', async () => {
    const token = await pairExtension();
    const asExt = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN, 'Content-Type': 'application/json', ...extra });
    await raw('PUT', '/api/keys/serpapi', asUi(), JSON.stringify({ key: 'owner-serpapi-key-123' }));
    for (const [method, path, body] of [
      ['PUT', '/api/keys/serpapi', '{"key":"x"}'], ['PATCH', '/api/settings', '{"autopilot":true}'], ['POST', '/api/scan', ''],
      ['POST', '/api/pair/approve', '{"requestId":"x"}'], ['POST', '/api/agent/quit', ''], ['POST', '/api/helper/reload', ''],
      ['POST', '/api/review/x/ask', '{}'], ['POST', '/api/lookups/run', '{}'], ['POST', '/api/scan/read-pages', ''],
    ] as const) {
      expect((await raw(method, path, asExt(), body)).status, path).toBe(403);
    }
    // Its token with the app's origin, or with no matching origin: refused.
    expect((await raw('GET', '/api/state', asExt({ Origin: `http://127.0.0.1:${port}` }))).status).toBe(403);
    // What it may read never holds a key.
    for (const path of ['/api/state', '/api/settings', '/api/deals', '/api/review', '/api/activity']) {
      const res = await raw('GET', path, asExt());
      expect(res.status, path).toBe(200);
      expect(res.body).not.toContain('owner-serpapi-key-123');
    }
    const stream = await raw('GET', '/api/events', asExt());
    expect(stream.status).toBe(200);
    expect(stream.body).not.toContain('owner-serpapi-key-123');
  });

  it('cannot name a helper build that is not a plain version', async () => {
    const token = await pairExtension();
    const asExt = { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN, 'Content-Type': 'application/json' };
    await raw('POST', '/api/worker/heartbeat', asExt, JSON.stringify({ version: '<img src=x onerror=alert(1)>' }));
    await raw('GET', `/api/worker/next?wait=0&v=${encodeURIComponent('"><script>alert(1)</script>')}`, asExt);
    const state = JSON.parse((await raw('GET', '/api/state', asUi())).body) as { helper?: { helperVersion?: unknown } } & Record<string, unknown>;
    expect(JSON.stringify(state)).not.toContain('<script>');
    expect(JSON.stringify(state)).not.toContain('onerror');
  });
});
