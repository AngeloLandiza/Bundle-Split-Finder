import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, KeyCheck } from '../../core/src/api/contract';
import { createAgent, type Agent } from '../app';
import { checkForOwner, checkKey, keySecrets, openAiTargets, recheckStaleKeys, scrubKeyText, type KeyCheckDeps } from '../keyChecks';
import type { StoredKeys } from '../store';

// Every key is checked with its own service as it is saved, and again from the stored value. Fake fetch per service; no network.

const SERP = 'serp_0123456789abcdef0123456789abcdef';
const KEEPA = 'keepa0123456789abcdefghijklmnopqrstuvwxyz0123456789';
const ANTHROPIC = 'sk-ant-api03-ZZZZ-1234567890abcdefghijklmnop';
const OPENAI = 'sk-deepseek-0123456789abcdefghijkl';
const APP = 'AppName-Bundle-PRD-1234567890-abcdef12';
const CERT = 'PRD-1234567890ab-cdef-4567-89ab-0123';
const BOT = '123456789:AAHsecretsecretsecretsecretsecret_1234';
const BASIC = btoa(`${APP}:${CERT}`);

const ALL: StoredKeys = {
  serpapi: SERP,
  keepa: KEEPA,
  anthropic: ANTHROPIC,
  openai: OPENAI,
  ebay: { appId: APP, certId: CERT },
  telegram: { botToken: BOT, chatId: '4242' },
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
/** A fetch that answers by host and records every call. */
function fake(handlers: Record<string, Handler>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase(), headers: { ...(init?.headers as Record<string, string> | undefined) }, body: init?.body === undefined ? undefined : String(init.body) });
    const h = handlers[url.host];
    if (!h) throw new Error(`no handler for ${url.host}`);
    return h(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}
const deps = (fetchFn: typeof fetch, extra: Partial<KeyCheckDeps> = {}): KeyCheckDeps => ({
  fetchFn,
  ai: { judge: { provider: 'openai-compatible', preset: 'deepseek', model: 'deepseek-flash', apiKeyRef: 'openai' } },
  timeoutMs: 400,
  ...extra,
});
const offline = (async () => {
  throw new Error(`socket hang up while fetching with ${SERP} ${KEEPA} ${BOT}`);
}) as unknown as typeof fetch;

const failed = (c: KeyCheck) => (c.ok ? null : c);

describe('serpapi account (free)', () => {
  const account = { plan_name: 'Free Plan', account_status: 'Active', searches_per_month: 250, total_searches_left: 118, this_month_usage: 132, this_hour_searches: 0, account_rate_limit_per_hour: 50 };
  it('works: says the searches left', async () => {
    const f = fake({ 'serpapi.com': () => json(200, account) });
    expect(await checkKey('serpapi', ALL, deps(f.fetchFn))).toEqual({ ok: true, detail: '118 of 250 searches left' });
    expect(f.calls).toHaveLength(1);
    expect(new URL(f.calls[0]!.url).pathname).toBe('/account.json');
  });
  it('rejected: 401', async () => {
    const f = fake({ 'serpapi.com': () => json(401, { error: 'Invalid API key.' }) });
    const c = failed(await checkKey('serpapi', ALL, deps(f.fetchFn)))!;
    expect(c.kind).toBe('rejected');
    expect(c.problem).toContain('SerpApi did not accept this key (HTTP 401)');
  });
  it('network error is not a rejected key', async () => {
    const c = failed(await checkKey('serpapi', ALL, deps(offline)))!;
    expect(c).toMatchObject({ kind: 'network', problem: 'Could not reach SerpApi to check it just now' });
  });
  it('5xx is the service', async () => {
    const f = fake({ 'serpapi.com': () => json(503, {}) });
    expect(failed(await checkKey('serpapi', ALL, deps(f.fetchFn)))).toMatchObject({ kind: 'service' });
  });
  it('429 is a limit', async () => {
    const f = fake({ 'serpapi.com': () => json(429, {}) });
    expect(failed(await checkKey('serpapi', ALL, deps(f.fetchFn)))).toMatchObject({ kind: 'limit' });
  });
});

describe('keepa token status (free)', () => {
  it('works: tokens left and the refill', async () => {
    const f = fake({ 'api.keepa.com': () => json(200, { tokensLeft: 60, refillRate: 1, refillIn: 30000, tokensConsumed: 0 }) });
    expect(await checkKey('keepa', ALL, deps(f.fetchFn))).toEqual({ ok: true, detail: '60 tokens, 1 a minute' });
    expect(new URL(f.calls[0]!.url).pathname).toBe('/token');
  });
  it('rejected: 401; 429 limit; 5xx service; network', async () => {
    expect(failed(await checkKey('keepa', ALL, deps(fake({ 'api.keepa.com': () => json(401, {}) }).fetchFn)))).toMatchObject({ kind: 'rejected' });
    expect(failed(await checkKey('keepa', ALL, deps(fake({ 'api.keepa.com': () => json(429, {}) }).fetchFn)))).toMatchObject({ kind: 'limit' });
    expect(failed(await checkKey('keepa', ALL, deps(fake({ 'api.keepa.com': () => json(502, {}) }).fetchFn)))).toMatchObject({ kind: 'service' });
    expect(failed(await checkKey('keepa', ALL, deps(offline)))).toMatchObject({ kind: 'network' });
  });
  it('a network error text that carries the address (and the key) never reaches the sentence', async () => {
    const c = failed(await checkKey('keepa', ALL, deps(offline)))!;
    expect(c.problem).not.toContain(KEEPA);
  });
});

describe('ebay client-credentials token (free)', () => {
  it('works', async () => {
    const f = fake({ 'api.ebay.com': () => json(200, { access_token: 'tok', expires_in: 7200 }) });
    expect(await checkKey('ebay', ALL, deps(f.fetchFn))).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.method).toBe('POST');
    expect(new URL(f.calls[0]!.url).pathname).toBe('/identity/v1/oauth2/token');
    expect(f.calls[0]!.headers.Authorization).toBe(`Basic ${BASIC}`);
  });
  it('rejected: eBay\'s own words and what to do', async () => {
    const f = fake({ 'api.ebay.com': () => json(401, { error: 'invalid_client', error_description: 'client authentication failed' }) });
    const c = failed(await checkKey('ebay', ALL, deps(f.fetchFn)))!;
    expect(c.kind).toBe('rejected');
    expect(c.problem).toBe(
      'eBay answered invalid_client: client authentication failed (HTTP 401). Copy the App ID (Client ID) and Cert ID (Client Secret) from the Production keyset at developer.ebay.com › Application Keys.',
    );
  });
  it('429, 5xx and no answer are not a rejection', async () => {
    expect(failed(await checkKey('ebay', ALL, deps(fake({ 'api.ebay.com': () => json(429, {}) }).fetchFn)))).toMatchObject({ kind: 'limit' });
    expect(failed(await checkKey('ebay', ALL, deps(fake({ 'api.ebay.com': () => json(503, {}) }).fetchFn)))).toMatchObject({ kind: 'service', problem: 'eBay had a server problem (HTTP 503), so it could not be checked just now' });
    expect(failed(await checkKey('ebay', ALL, deps(offline)))).toMatchObject({ kind: 'network', problem: 'Could not reach eBay to check it just now' });
  });
  it('a body that echoes both keys and the Basic credential comes back with none of them', async () => {
    const echo = `bad ${APP} and ${CERT} and Basic ${BASIC} and ${encodeURIComponent(CERT)}`;
    const f = fake({ 'api.ebay.com': () => json(401, { error: 'invalid_client', error_description: echo }) });
    const c = failed(await checkKey('ebay', ALL, deps(f.fetchFn)))!;
    for (const secret of [APP, CERT, BASIC]) expect(c.problem).not.toContain(secret);
    expect(c.problem).toContain('[key]');
  });
});

describe('anthropic: GET /v1/models (free)', () => {
  it('works, with no body and no generation request', async () => {
    const f = fake({ 'api.anthropic.com': () => json(200, { data: [], has_more: false }) });
    expect(await checkKey('anthropic', ALL, deps(f.fetchFn))).toEqual({ ok: true });
    const call = f.calls[0]!;
    expect(call).toMatchObject({ method: 'GET', body: undefined });
    expect(new URL(call.url).pathname).toBe('/v1/models');
    expect(call.headers['x-api-key']).toBe(ANTHROPIC);
  });
  it('rejected with the provider\'s error type', async () => {
    const f = fake({ 'api.anthropic.com': () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    const c = failed(await checkKey('anthropic', ALL, deps(f.fetchFn)))!;
    expect(c.kind).toBe('rejected');
    expect(c.problem).toContain('Claude answered authentication_error: invalid x-api-key (HTTP 401)');
  });
  it('429, 529 and no answer', async () => {
    expect(failed(await checkKey('anthropic', ALL, deps(fake({ 'api.anthropic.com': () => json(429, { error: { type: 'rate_limit_error', message: 'slow' } }) }).fetchFn)))).toMatchObject({ kind: 'limit' });
    expect(failed(await checkKey('anthropic', ALL, deps(fake({ 'api.anthropic.com': () => json(529, { error: { type: 'overloaded_error', message: 'busy' } }) }).fetchFn)))).toMatchObject({ kind: 'service' });
    expect(failed(await checkKey('anthropic', ALL, deps(offline)))).toMatchObject({ kind: 'network' });
  });
  it('an error message that echoes the key is scrubbed', async () => {
    const f = fake({ 'api.anthropic.com': () => json(401, { error: { type: 'authentication_error', message: `invalid key ${ANTHROPIC}` } }) });
    const c = failed(await checkKey('anthropic', ALL, deps(f.fetchFn)))!;
    expect(c.problem).not.toContain(ANTHROPIC);
    expect(c.problem).not.toContain('sk-ant-api03');
  });
});

describe('openai-compatible: GET {address}/models (free)', () => {
  it('goes to the address a pipeline names, with the bearer key', async () => {
    const f = fake({ 'api.deepseek.com': () => json(200, { object: 'list', data: [] }) });
    expect(await checkKey('openai', ALL, deps(f.fetchFn))).toEqual({ ok: true });
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.deepseek.com/models', body: undefined });
    expect(f.calls[0]!.headers.authorization).toBe(`Bearer ${OPENAI}`);
  });
  it('rejected with the service\'s words', async () => {
    const f = fake({ 'api.deepseek.com': () => json(401, { error: { message: 'Authentication Fails', type: 'authentication_error' } }) });
    const c = failed(await checkKey('openai', ALL, deps(f.fetchFn)))!;
    expect(c).toMatchObject({ kind: 'rejected' });
    expect(c.problem).toContain('DeepSeek answered authentication_error: Authentication Fails (HTTP 401)');
  });
  it('429, 5xx and no answer', async () => {
    expect(failed(await checkKey('openai', ALL, deps(fake({ 'api.deepseek.com': () => json(429, {}) }).fetchFn)))).toMatchObject({ kind: 'limit' });
    expect(failed(await checkKey('openai', ALL, deps(fake({ 'api.deepseek.com': () => json(500, {}) }).fetchFn)))).toMatchObject({ kind: 'service' });
    expect(failed(await checkKey('openai', ALL, deps(offline)))).toMatchObject({ kind: 'network' });
  });
  it('with no pipeline naming the key there is nothing to check it against, and nothing is sent', async () => {
    const f = fake({});
    const c = failed(await checkKey('openai', ALL, deps(f.fetchFn, { ai: {} })))!;
    expect(c.kind).toBe('unchecked');
    expect(f.calls).toHaveLength(0);
  });
  it('a service with no model list is unchecked, not rejected', async () => {
    const f = fake({ 'llm.example.com': () => json(404, {}) });
    const c = failed(await checkKey('openai', ALL, deps(f.fetchFn, { ai: { judge: { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'm', apiKeyRef: 'openai' } } })))!;
    expect(c.kind).toBe('unchecked');
  });
  it('never sends the key in the clear or to an address with credentials', () => {
    const t = openAiTargets({
      judge: { provider: 'openai-compatible', baseUrl: 'http://evil.example.com/v1', model: 'm', apiKeyRef: 'openai' },
      assist: { provider: 'openai-compatible', baseUrl: 'https://user:pw@evil.example.com', model: 'm', apiKeyRef: 'openai' },
      research: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', apiKeyRef: 'openai' },
      brief: { provider: 'anthropic', model: 'm', apiKeyRef: 'anthropic' },
    });
    expect(t.map((x) => x.base)).toEqual(['http://127.0.0.1:11434/v1']);
  });
});

describe('telegram getMe, then getChat (free; no message)', () => {
  const me = { ok: true, result: { id: 1, is_bot: true, username: 'split_finder_bot' } };
  it('works', async () => {
    const f = fake({ 'api.telegram.org': (u) => (u.pathname.endsWith('/getMe') ? json(200, me) : json(200, { ok: true, result: { id: 4242 } })) });
    expect(await checkKey('telegram', ALL, deps(f.fetchFn))).toEqual({ ok: true, detail: 'bot @split_finder_bot, chat found' });
    expect(f.calls.map((c) => new URL(c.url).pathname.split('/').pop())).toEqual(['getMe', 'getChat']);
    expect(f.calls.every((c) => c.method === 'GET' && c.body === undefined)).toBe(true);
  });
  it('rejected token: 401', async () => {
    const f = fake({ 'api.telegram.org': () => json(401, { ok: false, error_code: 401, description: 'Unauthorized' }) });
    const c = failed(await checkKey('telegram', ALL, deps(f.fetchFn)))!;
    expect(c.kind).toBe('rejected');
    expect(c.problem).toContain('Telegram did not accept the bot token');
  });
  it('a chat id the bot cannot find is rejected, in the right words', async () => {
    const f = fake({ 'api.telegram.org': (u) => (u.pathname.endsWith('/getMe') ? json(200, me) : json(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })) });
    const c = failed(await checkKey('telegram', ALL, deps(f.fetchFn)))!;
    expect(c.kind).toBe('rejected');
    expect(c.problem).toContain('cannot find that chat id');
  });
  it('429, 5xx and no answer', async () => {
    expect(failed(await checkKey('telegram', ALL, deps(fake({ 'api.telegram.org': () => json(429, { ok: false }) }).fetchFn)))).toMatchObject({ kind: 'limit' });
    expect(failed(await checkKey('telegram', ALL, deps(fake({ 'api.telegram.org': () => json(502, { ok: false }) }).fetchFn)))).toMatchObject({ kind: 'service' });
    expect(failed(await checkKey('telegram', ALL, deps(offline)))).toMatchObject({ kind: 'network' });
  });
  it('a description that echoes the token is scrubbed, and so is the network error that carries the address', async () => {
    const f = fake({ 'api.telegram.org': () => json(401, { ok: false, description: `Unauthorized ${BOT}` }) });
    const c = failed(await checkKey('telegram', ALL, deps(f.fetchFn)))!;
    expect(c.problem).not.toContain('AAHsecret');
    expect(c.problem).not.toContain(BOT);
    expect(failed(await checkKey('telegram', ALL, deps(offline)))!.problem).not.toContain('AAHsecret');
  });
});

describe('the time limit', () => {
  it('a service that never answers is "could not reach", within the limit', async () => {
    const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const t0 = Date.now();
    const c = failed(await checkKey('ebay', ALL, deps(never, { timeoutMs: 120 })))!;
    expect(c.kind).toBe('network');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('the scrubber', () => {
  it('takes every key, its URL-encoded form and the Basic credential out before it cuts', () => {
    const keys: StoredKeys = { ebay: { appId: APP, certId: CERT }, telegram: { botToken: BOT, chatId: '1' }, serpapi: 'serp+key/with&odd=chars' };
    const text = `x ${APP} ${CERT} Basic ${BASIC} ${BASIC.replace(/=+$/, '')} ${BOT} ${BOT.split(':')[1]} ${encodeURIComponent('serp+key/with&odd=chars')}`;
    const out = scrubKeyText(text, keys, 5000);
    for (const s of keySecrets(keys)) expect(out).not.toContain(s);
    expect(out).not.toContain('AAHsecret');
  });
  it('keeps no part of a key that falls across the length limit', () => {
    const keys: StoredKeys = { ebay: { appId: APP, certId: CERT } };
    // The Cert ID begins a few characters before the cut. Cut first, it would survive as "PRD-1234567890ab-cdef-4567".
    const lead = 'a'.repeat(280);
    const out = scrubKeyText(`${lead} ${CERT} more`, keys, 300);
    expect(out).not.toContain('PRD-1234');
    expect(out.length).toBeLessThanOrEqual(300);
  });
  it('removes control characters and ignores a value too short to be a key', () => {
    expect(scrubKeyText('a\u0000b\nc', { serpapi: 'abc' })).toBe('a b c');
  });
});

describe('what the owner reads', () => {
  it('an outage after a save says the key is saved and is checked again at the next scan', () => {
    const c = checkForOwner({ ok: false, kind: 'network', problem: 'Could not reach eBay to check it just now' }, 'save');
    expect(c).toMatchObject({ problem: 'Saved. Could not reach eBay to check it just now — it is checked again at the next scan.' });
  });
  it('a rejection reads the same after a save and a re-check', () => {
    const r: KeyCheck = { ok: false, kind: 'rejected', problem: 'eBay answered invalid_client' };
    expect(checkForOwner(r, 'save')).toEqual(r);
    expect(checkForOwner(r, 'recheck')).toEqual(r);
  });
});

// ---------------------------------------------------------------- through the agent

let server: Server;
let agent: Agent;
let base: string;
let clock = Date.parse('2026-11-23T12:00:00Z');

async function start(fetchFn: typeof fetch, opts: { keyCheckTimeoutMs?: number } = {}): Promise<void> {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-keycheck-')), port, timers: false, fetchFn, now: () => clock, shippedHelperVersion: null, ...opts });
  server.on('request', agent.handle);
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (!agent) return;
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });
const put = async (name: string, body: unknown) => (await ui(`/api/keys/${name}`, { method: 'PUT', body: JSON.stringify(body) })).json() as Promise<{ saved: true; check: KeyCheck }>;
const stateOf = async () => (await (await ui('/api/state')).json()) as AgentState;

describe('PUT /api/keys/:name saves, then checks', () => {
  const ebayOk = () => json(200, { access_token: 't', expires_in: 7200 });
  const ebayBad = () => json(401, { error: 'invalid_client', error_description: 'client authentication failed' });
  let ebay: () => Response;

  it('a wrong pair is known at once; the right pair clears it and says when it was checked', async () => {
    ebay = ebayBad;
    await start(fake({ 'api.ebay.com': () => ebay() }).fetchFn);
    const bad = await put('ebay', { appId: APP, certId: CERT });
    expect(bad.saved).toBe(true);
    expect(bad.check).toMatchObject({ ok: false, kind: 'rejected' });
    let s = await stateOf();
    expect(s.keys.ebay).toBe(true);
    expect(s.keyProblems?.ebay).toContain('invalid_client: client authentication failed (HTTP 401)');
    expect(s.keyChecks?.ebay).toMatchObject({ ok: false });

    ebay = ebayOk;
    const good = await put('ebay', { appId: APP, certId: CERT });
    expect(good.check).toEqual({ ok: true });
    s = await stateOf();
    expect(s.keyProblems?.ebay).toBeUndefined();
    expect(s.keyChecks?.ebay).toEqual({ ok: true, at: new Date(clock).toISOString() });
  });

  it('serpapi: the answer carries the searches left, and the state keeps them', async () => {
    await start(fake({ 'serpapi.com': () => json(200, { plan_name: 'Free', account_status: 'Active', searches_per_month: 250, total_searches_left: 118, this_month_usage: 132, this_hour_searches: 0, account_rate_limit_per_hour: 50 }) }).fetchFn);
    const r = await put('serpapi', { key: SERP });
    expect(r.check).toEqual({ ok: true, detail: '118 of 250 searches left' });
    expect((await stateOf()).keyChecks?.serpapi).toMatchObject({ ok: true, detail: '118 of 250 searches left' });
  });

  it('an outage leaves the problem unset and says what happened', async () => {
    await start(offline);
    const r = await put('ebay', { appId: APP, certId: CERT });
    expect(r).toMatchObject({ saved: true, check: { ok: false, kind: 'network', problem: 'Saved. Could not reach eBay to check it just now — it is checked again at the next scan.' } });
    const s = await stateOf();
    expect(s.keys.ebay).toBe(true);
    expect(s.keyProblems?.ebay).toBeUndefined();
    expect(s.keyChecks?.ebay).toBeUndefined();
  });

  it('a saved key that never gets an answer is answered within the limit', async () => {
    await start((() => new Promise<Response>(() => {})) as unknown as typeof fetch, { keyCheckTimeoutMs: 150 });
    const t0 = Date.now();
    const r = await put('serpapi', { key: SERP });
    expect(r.check).toMatchObject({ kind: 'network' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('replacing a rejected key drops the old problem and verdict at once, even when the new one cannot be checked', async () => {
    ebay = ebayBad;
    let up = true;
    await start(fake({ 'api.ebay.com': () => (up ? ebay() : (() => { throw new Error('down'); })()) }).fetchFn);
    await put('ebay', { appId: APP, certId: CERT });
    up = false;
    await put('ebay', { appId: `${APP}2`, certId: CERT });
    const s = await stateOf();
    expect(s.keyProblems?.ebay).toBeUndefined();
    expect(s.keyChecks?.ebay).toBeUndefined();
  });

  it('a delete forgets the verdict', async () => {
    await start(fake({ 'api.ebay.com': ebayOk }).fetchFn);
    await put('ebay', { appId: APP, certId: CERT });
    expect((await stateOf()).keyChecks?.ebay?.ok).toBe(true);
    await ui('/api/keys/ebay', { method: 'DELETE' });
    expect((await stateOf()).keyChecks).toBeUndefined();
  });
});

describe('POST /api/keys/:name/check', () => {
  it('re-checks the stored value, and a key that is not saved is 404', async () => {
    let answer: Response = json(401, { error: 'invalid_client', error_description: 'client authentication failed' });
    const f = fake({ 'api.ebay.com': () => answer.clone() });
    await start(f.fetchFn);
    expect((await ui('/api/keys/ebay/check', { method: 'POST', body: '{}' })).status).toBe(404);
    await put('ebay', { appId: APP, certId: CERT });
    expect((await stateOf()).keyProblems?.ebay).toBeTruthy();
    // The owner fixed it on eBay's side: the stored value is checked again with no new typing.
    answer = json(200, { access_token: 't', expires_in: 7200 });
    clock += 120_000;
    const r = (await (await ui('/api/keys/ebay/check', { method: 'POST', body: '{}' })).json()) as { check: KeyCheck };
    expect(r.check).toEqual({ ok: true });
    const s = await stateOf();
    expect(s.keyProblems?.ebay).toBeUndefined();
    expect(s.keyChecks?.ebay?.at).toBe(new Date(clock).toISOString());
    // The stored value is what was sent: the second request carries the same Basic credential as the first.
    expect(f.calls.every((c) => c.headers.Authorization === `Basic ${BASIC}`)).toBe(true);
  });

  it('an outage on a re-check says to try again and does not erase a known rejection', async () => {
    let up = true;
    await start(fake({ 'api.ebay.com': () => { if (!up) throw new Error('down'); return json(401, { error: 'invalid_client', error_description: 'x' }); } }).fetchFn);
    await put('ebay', { appId: APP, certId: CERT });
    up = false;
    const r = (await (await ui('/api/keys/ebay/check', { method: 'POST', body: '{}' })).json()) as { check: KeyCheck };
    expect(r.check).toMatchObject({ ok: false, kind: 'network', problem: 'Could not reach eBay to check it just now. Try again in a moment.' });
    expect((await stateOf()).keyProblems?.ebay).toContain('invalid_client');
  });

  it('is for the app only', async () => {
    await start(offline);
    const res = await fetch(`${base}/api/keys/ebay/check`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('the quiet daily check', () => {
  it('checks saved keys with no verdict in 24 hours, and no others; every request it makes is a free one', async () => {
    const f = fake({
      'serpapi.com': () => json(200, { plan_name: 'Free', account_status: 'Active', searches_per_month: 250, total_searches_left: 100, this_month_usage: 150, this_hour_searches: 0, account_rate_limit_per_hour: 50 }),
      'api.keepa.com': () => json(200, { tokensLeft: 60, refillRate: 1, refillIn: 1, tokensConsumed: 0 }),
      'api.anthropic.com': () => json(200, { data: [] }),
      'api.ebay.com': () => json(200, { access_token: 't', expires_in: 7200 }),
      'api.telegram.org': (u) => json(200, { ok: true, result: { username: 'b' } }),
    });
    await start(f.fetchFn);
    for (const [n, v] of [['serpapi', { key: SERP }], ['keepa', { key: KEEPA }], ['anthropic', { key: ANTHROPIC }], ['ebay', { appId: APP, certId: CERT }], ['telegram', { botToken: BOT, chatId: '4242' }]] as const) await put(n, v);
    const after = f.calls.length;
    const host = { store: agent.store, fetchFn: f.fetchFn, now: () => clock };

    // Just checked: nothing is due.
    expect(await recheckStaleKeys(host)).toEqual([]);
    expect(f.calls.length).toBe(after);

    // 25 hours later, each saved key is due; the key that is not saved (openai) is not.
    clock += 25 * 3_600_000;
    expect(await recheckStaleKeys(host)).toEqual(['serpapi', 'keepa', 'anthropic', 'ebay', 'telegram']);
    const quiet = f.calls.slice(after);
    // Nothing paid: no search, no model call, no message, no POST but eBay's token request.
    for (const c of quiet) {
      const u = new URL(c.url);
      if (c.method === 'POST') expect(`${u.host}${u.pathname}`).toBe('api.ebay.com/identity/v1/oauth2/token');
      expect(`${u.host}${u.pathname}`).not.toMatch(/search\.json|\/v1\/messages|chat\/completions|sendMessage/);
    }
    expect((await stateOf()).keyChecks?.serpapi?.at).toBe(new Date(clock).toISOString());
  });

  it('a key that stopped working shows up without a scan; an outage records nothing and is tried again', async () => {
    let ebayUp: 'ok' | 'bad' | 'down' = 'ok';
    const f = fake({
      'api.ebay.com': () => {
        if (ebayUp === 'down') throw new Error('down');
        return ebayUp === 'ok' ? json(200, { access_token: 't', expires_in: 7200 }) : json(401, { error: 'invalid_client', error_description: 'client authentication failed' });
      },
    });
    await start(f.fetchFn);
    await put('ebay', { appId: APP, certId: CERT });
    const host = { store: agent.store, fetchFn: f.fetchFn, now: () => clock };
    clock += 25 * 3_600_000;
    ebayUp = 'down';
    await recheckStaleKeys(host);
    expect((await stateOf()).keyProblems?.ebay).toBeUndefined();
    expect(await recheckStaleKeys(host)).toEqual(['ebay']); // still due
    ebayUp = 'bad';
    await recheckStaleKeys(host);
    expect((await stateOf()).keyProblems?.ebay).toContain('invalid_client');
  });
});

describe('a key never comes back out', () => {
  it('not in any answer, state, event, or log line; not when the service echoes it', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    const echo = (b: unknown, status = 401) => () => json(status, b);
    await start(
      fake({
        'serpapi.com': echo({ error: `Invalid API key ${SERP}` }),
        'api.keepa.com': echo({ error: { type: 'x', message: `key ${KEEPA}` } }),
        'api.anthropic.com': echo({ error: { type: 'authentication_error', message: `bad ${ANTHROPIC}` } }),
        'api.deepseek.com': echo({ error: { message: `bad ${OPENAI}`, type: 'authentication_error' } }),
        'api.ebay.com': echo({ error: 'invalid_client', error_description: `${APP}:${CERT} Basic ${BASIC}` }),
        'api.telegram.org': echo({ ok: false, description: `Unauthorized ${BOT}` }),
      }).fetchFn,
    );
    await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ ai: { judge: { provider: 'openai-compatible', preset: 'deepseek', model: 'deepseek-flash' } } }) });
    const seen: string[] = [];
    for (const [n, v] of [['serpapi', { key: SERP }], ['keepa', { key: KEEPA }], ['anthropic', { key: ANTHROPIC }], ['openai', { key: OPENAI }], ['ebay', { appId: APP, certId: CERT }], ['telegram', { botToken: BOT, chatId: '4242' }]] as const) {
      seen.push(JSON.stringify(await put(n, v)));
      seen.push(await (await ui(`/api/keys/${n}/check`, { method: 'POST', body: '{}' })).text());
    }
    seen.push(await (await ui('/api/state')).text(), await (await ui('/api/settings')).text());
    seen.push(JSON.stringify(agent.store.get('runtime')));
    const blob = [...seen, ...logs].join('\n');
    for (const secret of [SERP, KEEPA, ANTHROPIC, OPENAI, APP, CERT, BASIC, BOT, 'AAHsecret', encodeURIComponent(CERT)]) expect(blob).not.toContain(secret);
    // Each service was reached, so the sentences above came from real rejections.
    expect((await stateOf()).keyProblems).toMatchObject({ serpapi: expect.any(String), keepa: expect.any(String), anthropic: expect.any(String), ebay: expect.any(String), telegram: expect.any(String) });
  });

  it('keyProblem scrubs whatever it is given (security review M10)', async () => {
    await start(offline);
    await put('keepa', { key: KEEPA });
    (agent.work as unknown as { keyProblem(n: string, s: string | null): void }).keyProblem('keepa', `Keepa said no to ${KEEPA}`);
    const s = await stateOf();
    expect(s.keyProblems?.keepa).toBe('Keepa said no to [key]');
  });
});
