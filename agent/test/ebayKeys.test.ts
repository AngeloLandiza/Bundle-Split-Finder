import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EbayClient } from '../../core/src/ebay/client';
import { checkEbayKeys } from '../../extension/lib/ebayEnv';
import { createAgent, type Agent } from '../app';

// The keys the Preferences pane sends (PUT /api/keys/ebay {appId, certId}, each trimmed) must reach eBay exactly as the
// extension's working client sent them: same URL, same Basic header, same body, same Content-Type.

const APP = 'AppName-Bundle-PRD-1234567890-abcdef12';
const CERT = 'PRD-1234567890ab-cdef-4567-89ab-0123';
const noStore = { get: async () => null, set: async () => {}, clear: async () => {} };

interface Seen { url: string; method?: string; headers: Record<string, string>; body: string }
const grab = (seen: Seen[], reply: () => Response): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
    return reply();
  }) as typeof fetch;
const token = () => new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 });

let server: Server;
let agent: Agent;
let base: string;

async function start() {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-ebay-')), port, timers: false, fetchFn: grab([], token) });
  server.on('request', agent.handle);
}
afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const saveFromPane = async (body: unknown) =>
  (await fetch(`${base}/api/keys/ebay`, { method: 'PUT', headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status;

describe('the eBay token request from saved keys', () => {
  it('equals the one the extension sends, even when the paste carried spaces and a newline', async () => {
    await start();
    expect(await saveFromPane({ appId: `  ${APP}\n`, certId: `${CERT} \n` })).toBe(200);
    const keys = agent.store.get('keys');
    expect(keys.ebay).toEqual({ appId: APP, certId: CERT });

    // The agent's path: the stored keys into the client the scan builds.
    const viaAgent: Seen[] = [];
    await new EbayClient({ appId: keys.ebay!.appId, certId: keys.ebay!.certId, fetchFn: grab(viaAgent, token) }).search('x').catch(() => {});
    // The extension's path.
    const viaExt: Seen[] = [];
    await checkEbayKeys({ appId: APP, certId: CERT, fetchFn: grab(viaExt, token), store: noStore, now: () => 0 });

    const a = viaAgent[0]!;
    expect(a).toEqual(viaExt[0]);
    expect(a.url).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    expect(a.method).toBe('POST');
    expect(a.headers.Authorization).toBe('Basic ' + Buffer.from(`${APP}:${CERT}`).toString('base64'));
    expect(a.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(a.body).toBe('grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope');
  });
});

describe('eBay refusing the keys', () => {
  it("is reported with eBay's own error and status, and no key", async () => {
    const reply = () => new Response(JSON.stringify({ error: 'invalid_client', error_description: `client authentication failed for ${APP}` }), { status: 401 });
    const err = (await new EbayClient({ appId: APP, certId: CERT, fetchFn: grab([], reply) }).search('x').catch((x: unknown) => x)) as { detail: string };
    expect(err.detail).toBe('eBay answered invalid_client: client authentication failed for [key] (HTTP 401).');
  });

  it('keeps no part of a key that falls across the length limit, nor the Basic credential (security review, Nov 23)', async () => {
    const basic = Buffer.from(`${APP}:${CERT}`).toString('base64');
    const pad = 'x'.repeat(190);
    for (const description of [`${pad} ${CERT}`, `${pad} ${APP}`, `bad header Basic ${basic}`]) {
      const reply = () => new Response(JSON.stringify({ error: 'invalid_client', error_description: description }), { status: 401 });
      const err = (await new EbayClient({ appId: APP, certId: CERT, fetchFn: grab([], reply) }).search('x').catch((x: unknown) => x)) as { detail: string };
      for (const secret of [APP, CERT, basic]) expect(err.detail).not.toContain(secret.slice(0, 8));
      expect(err.detail).toMatch(/^eBay answered invalid_client: .*\(HTTP 401\)\.$/);
    }
  });
});
