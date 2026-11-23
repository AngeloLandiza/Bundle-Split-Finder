import { describe, expect, it } from 'vitest';
import { createAgentApi } from './agentApi';
import {
  AGENT_ORIGIN,
  NOTICE_DENIED,
  NOTICE_DISCONNECTED,
  NOTICE_EXPIRED,
  NOTICE_REVOKED,
  NOTICE_UNREACHABLE,
  createLinkStore,
  spokenCode,
  type KeyValue,
} from './agentLink';
import { createPairing } from './agentPairing';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function memoryKv(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** An agent that answers requests from a script, and records every call it was sent. */
function world(script: Record<string, (call: Call, n: number) => Response | Promise<Response>>, gate: Promise<void> = Promise.resolve()) {
  const kv = memoryKv();
  const store = createLinkStore(kv);
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  let clock = Date.parse('2026-11-22T10:00:00Z');
  const sleeps: number[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = url.replace(AGENT_ORIGIN, '');
    const n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    const handler = script[path];
    if (!handler) throw new TypeError('connection refused');
    return handler(call, n);
  }) as typeof fetch;
  let paired = 0;
  const pairing = createPairing({
    fetchFn,
    store,
    extensionId: EXT,
    now: () => clock,
    sleep: async (ms) => {
      await gate;
      sleeps.push(ms);
      clock += ms;
    },
    onPaired: () => void paired++,
  });
  return { kv, store, calls, pairing, sleeps, fetchFn, paired: () => paired, advance: (ms: number) => void (clock += ms), now: () => clock };
}

const REQUEST = { requestId: 'pair-1', code: '482913', claimSecret: 'secret-1', expiresAt: '2026-11-22T10:10:00.000Z' };

describe('pairing', () => {
  it('asks for a code as this extension, shows it, polls until approved, and keeps the token', async () => {
    const w = world({
      '/api/pair/request': () => json(200, REQUEST),
      '/api/pair/claim': (_c, n) => json(200, n < 3 ? { status: 'pending' } : { status: 'approved', token: 'tok-abc', extensionId: EXT }),
    });
    const link = await w.pairing.start();
    expect(link).toEqual({ status: 'pairing', code: '482913', expiresAt: Date.parse(REQUEST.expiresAt) });
    expect(w.calls[0]).toMatchObject({ url: `${AGENT_ORIGIN}/api/pair/request`, method: 'POST', body: { extensionId: EXT } });
    // The request carries no token: this browser has none yet.
    expect(w.calls[0]!.headers.Authorization).toBeUndefined();
    await w.pairing.idle();
    const claims = w.calls.filter((c) => c.url.endsWith('/api/pair/claim'));
    expect(claims).toHaveLength(3);
    expect(claims[0]!.body).toEqual({ requestId: 'pair-1', claimSecret: 'secret-1' });
    expect(w.sleeps).toEqual([1500, 2000, 3000]);
    expect(await w.store.readLink()).toMatchObject({ status: 'paired', lastJobAt: null });
    expect(await w.store.getToken()).toBe('tok-abc');
    // The secret of the request is gone once it was used.
    expect(await w.store.getPending()).toBeNull();
    expect(w.paired()).toBe(1);
  });

  it('says the code the way the app does: two groups of three', () => {
    expect(spokenCode('482913')).toBe('482 913');
  });

  it('a refusal in the app ends it with a sentence and no token', async () => {
    const w = world({ '/api/pair/request': () => json(200, REQUEST), '/api/pair/claim': () => json(200, { status: 'denied' }) });
    await w.pairing.start();
    await w.pairing.idle();
    expect(await w.store.readLink()).toEqual({ status: 'unpaired', notice: NOTICE_DENIED });
    expect(await w.store.getToken()).toBeNull();
    expect(w.paired()).toBe(0);
  });

  it('a code nobody answered runs out: the wait stops by itself', async () => {
    const w = world({ '/api/pair/request': () => json(200, REQUEST), '/api/pair/claim': () => json(200, { status: 'pending' }) });
    await w.pairing.start();
    await w.pairing.idle();
    expect(await w.store.readLink()).toEqual({ status: 'unpaired', notice: NOTICE_EXPIRED });
    // Backed off to every 10 s, never faster after that.
    expect(Math.max(...w.sleeps)).toBe(10_000);
    expect(w.sleeps.slice(0, 7)).toEqual([1500, 2000, 3000, 4000, 5000, 7000, 10_000]);
  });

  it('the app forgot the request (404): the code ran out', async () => {
    const w = world({
      '/api/pair/request': () => json(200, REQUEST),
      '/api/pair/claim': () => json(404, { error: { code: 'not_found', message: 'This pairing request has expired. Ask again from the extension.' } }),
    });
    await w.pairing.start();
    await w.pairing.idle();
    expect(await w.store.readLink()).toEqual({ status: 'unpaired', notice: NOTICE_EXPIRED });
  });

  it('the app is not running: one sentence, nothing stored', async () => {
    const w = world({});
    const link = await w.pairing.start();
    expect(link).toEqual({ status: 'unpaired', notice: NOTICE_UNREACHABLE });
    expect(w.kv.data.has('agentPairing')).toBe(false);
  });

  it("the app's own refusal to start (too many waiting) is shown as it said it", async () => {
    const w = world({ '/api/pair/request': () => json(409, { error: { code: 'conflict', message: 'Too many pairing requests are waiting. Answer them in the app first.' } }) });
    expect(await w.pairing.start()).toEqual({ status: 'unpaired', notice: 'Too many pairing requests are waiting. Answer them in the app first.' });
  });

  it('keeps waiting through a moment when the app is not reachable', async () => {
    const w = world({
      '/api/pair/request': () => json(200, REQUEST),
      '/api/pair/claim': (_c, n) => {
        if (n === 1) throw new TypeError('down');
        return json(200, { status: 'approved', token: 'tok', extensionId: EXT });
      },
    });
    await w.pairing.start();
    await w.pairing.idle();
    expect(await w.store.readLink()).toMatchObject({ status: 'paired' });
  });

  it('starting again while a code is waiting shows the same code and asks nothing new', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({ '/api/pair/request': () => json(200, REQUEST), '/api/pair/claim': () => json(200, { status: 'pending' }) }, gate);
    await w.pairing.start();
    const again = await w.pairing.start();
    expect(again).toMatchObject({ status: 'pairing', code: '482913' });
    expect(w.calls.filter((c) => c.url.endsWith('/api/pair/request'))).toHaveLength(1);
    await w.pairing.disconnect();
    release();
    await w.pairing.idle();
  });

  it('Cancel while waiting forgets the request and the wait ends without another claim', async () => {
    let claims = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({ '/api/pair/request': () => json(200, REQUEST), '/api/pair/claim': () => (claims++, json(200, { status: 'pending' })) }, gate);
    await w.pairing.start();
    await w.pairing.disconnect();
    release();
    await w.pairing.idle();
    expect(claims).toBe(0);
    expect(await w.store.readLink()).toEqual({ status: 'unpaired', notice: null });
    expect(w.kv.data.has('agentPairing')).toBe(false);
  });

  it('Disconnect clears the token and says so', async () => {
    const w = world({});
    await w.store.pair('tok', 1);
    await w.pairing.disconnect();
    expect(await w.store.getToken()).toBeNull();
    expect(await w.store.readLink()).toEqual({ status: 'unpaired', notice: NOTICE_DISCONNECTED });
  });

  it('resume picks a waiting code up after the worker slept, and ends one that ran out meanwhile', async () => {
    const w = world({ '/api/pair/request': () => json(200, REQUEST), '/api/pair/claim': () => json(200, { status: 'approved', token: 'tok', extensionId: EXT }) });
    await w.store.setPending({ requestId: 'pair-1', claimSecret: 's', code: '111222', expiresAt: w.now() + 60_000 });
    await w.pairing.resume();
    await w.pairing.idle();
    expect(await w.store.readLink()).toMatchObject({ status: 'paired' });

    const late = world({});
    await late.store.setPending({ requestId: 'pair-1', claimSecret: 's', code: '111222', expiresAt: late.now() - 1 });
    await late.pairing.resume();
    expect(await late.store.readLink()).toEqual({ status: 'unpaired', notice: NOTICE_EXPIRED });
  });
});

describe('a stored link is read as untrusted', () => {
  it('"paired" without a token is unpaired, and junk is unpaired', async () => {
    const kv = memoryKv();
    const store = createLinkStore(kv);
    await kv.set('agentLink', { status: 'paired', since: 1, lastJobAt: 2 });
    expect(await store.readLink()).toEqual({ status: 'unpaired', notice: null });
    await kv.set('agentLink', 'banana');
    expect(await store.readLink()).toEqual({ status: 'unpaired', notice: null });
    await kv.set('agentToken', 'tok');
    await kv.set('agentLink', { status: 'paired', since: 1, lastJobAt: 2 });
    expect(await store.readLink()).toEqual({ status: 'paired', since: 1, lastJobAt: 2 });
  });
});

describe('calls to the app', () => {
  it('send the token, and a 401 drops it and says the app no longer knows this browser', async () => {
    const w = world({ '/api/deals': () => json(401, { error: { code: 'unauthorized', message: 'Pair first.' } }) });
    await w.store.pair('tok-secret', 5);
    const api = createAgentApi({ fetchFn: w.fetchFn, store: w.store });
    const reply = await api.get('/api/deals');
    expect(w.calls[0]!.headers.Authorization).toBe('Bearer tok-secret');
    expect(reply).toMatchObject({ ok: false, kind: 'unpaired', status: 401, message: NOTICE_REVOKED });
    expect(await w.store.getToken()).toBeNull();
    expect(await w.store.readLink()).toEqual({ status: 'unpaired', notice: NOTICE_REVOKED });
    // No token any more: the next call does not even go out.
    expect(await api.get('/api/deals')).toMatchObject({ ok: false, kind: 'unpaired' });
    expect(w.calls).toHaveLength(1);
  });

  it('say "not reachable" when the app is closed, relay the app\'s own sentence for other refusals, and read a 204', async () => {
    const w = world({
      '/api/review/q1/answer': () => json(404, { error: { code: 'not_found', message: 'No open question with this id.' } }),
      '/api/worker/next?wait=25': () => new Response(null, { status: 204 }),
    });
    await w.store.pair('tok', 5);
    const api = createAgentApi({ fetchFn: w.fetchFn, store: w.store });
    expect(await api.get('/api/deals')).toMatchObject({ ok: false, kind: 'unreachable', message: NOTICE_UNREACHABLE });
    expect(await api.post('/api/review/q1/answer', { answer: { none: true } })).toMatchObject({ ok: false, kind: 'refused', status: 404, message: 'No open question with this id.' });
    expect(w.calls[1]!.body).toEqual({ answer: { none: true } });
    expect(await api.get('/api/worker/next?wait=25')).toEqual({ ok: true, status: 204, data: undefined });
    // The token stays through all of that.
    expect(await w.store.getToken()).toBe('tok');
  });
});
