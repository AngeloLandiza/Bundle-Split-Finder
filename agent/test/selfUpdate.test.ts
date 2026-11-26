// Nov 25, self-update: the agent's half. The shell (src-tauri/src/updater.rs) reports looks and offers a verified update;
// the agent answers whether to install now and keeps what the owner sees. These tests play the shell over HTTP. No network.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityResponse, AgentState, NotifyEvent } from '../../core/src/api/contract';
import { createAgent, type Agent } from '../app';

let server: Server;
let agent: Agent;
let base: string;
let dataDir: string;
let notified: NotifyEvent[];
let fetched: string[];
let clock = Date.parse('2026-11-26T12:00:00Z');

const fake = (async (url: string) => {
  fetched.push(String(url));
  throw new Error(`unexpected request to ${String(url)}`);
}) as unknown as typeof fetch;

async function start(o: { appVersion?: string | null; availability?: string | null } = {}) {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({
    dataDir, port, timers: false, fetchFn: fake, shippedHelperVersion: null, now: () => clock,
    appVersion: o.appVersion === undefined ? '0.2.0' : o.appVersion,
    updaterAvailability: o.availability === undefined ? 'on' : o.availability,
  });
  server.on('request', agent.handle);
  vi.spyOn(agent.events, 'publish').mockImplementation(((name: string, data: unknown) => {
    if (name === 'notify') notified.push(data as NotifyEvent);
  }) as never);
}

async function stop() {
  vi.restoreAllMocks();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'sf-selfupdate-'));
  notified = [];
  fetched = [];
  clock = Date.parse('2026-11-26T12:00:00Z');
  await start();
});

afterEach(stop);

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => ui(path, { method: 'POST', body: JSON.stringify(body) });
const state = async () => (await (await ui('/api/state')).json()) as AgentState;
const activity = async () => (await (await ui('/api/activity')).json()) as ActivityResponse;
const offer = async (version = '0.2.1', notes = 'Fixes the scan button.\nReads prices faster.') => (await (await post('/api/update/pending', { version, notes })).json()) as { install: boolean; why?: string };
const patch = (body: unknown) => ui('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });

describe('what Settings shows', () => {
  it('a copy that updates itself: the version and no look yet', async () => {
    expect((await state()).updater).toEqual({ can: true, version: '0.2.0', checkedAt: null, outcome: null });
  });

  it('a copy built without the key, or a development run, says why it cannot', async () => {
    await stop();
    await start({ availability: 'no-key' });
    const u = (await state()).updater!;
    expect(u.can).toBe(false);
    expect(u.why).toContain('without the update key');
    expect(await offer()).toEqual({ install: false, why: 'This copy does not update itself.' });
  });

  it('a look that found nothing newer is "last checked", and nothing in Activity', async () => {
    expect((await post('/api/update/report', { outcome: 'current' })).status).toBe(200);
    expect((await state()).updater).toMatchObject({ checkedAt: '2026-11-26T12:00:00.000Z', outcome: 'current' });
    expect((await activity()).versions ?? []).toHaveLength(0);
  });

  it('a failed look is one Activity line, scrubbed of keys, not repeated while it is the same', async () => {
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-key-abcdef0123456789' }));
    await post('/api/update/report', { outcome: 'failed', why: 'error sending request <b>serp-key-abcdef0123456789</b>' });
    await post('/api/update/report', { outcome: 'failed', why: 'error sending request <b>serp-key-abcdef0123456789</b>' });
    const v = (await activity()).versions!;
    expect(v).toHaveLength(1);
    expect(v[0]!.sentence).toContain('Split Finder could not get its new version: error sending request');
    expect(v[0]!.sentence).toContain('looks again in 6 hours');
    expect(JSON.stringify(v)).not.toContain('serp-key-abcdef0123456789');
    expect(JSON.stringify(v)).not.toContain('<b>');
    expect((await state()).updater?.outcome).toBe('failed');
  });

  it('refuses a report or an offer that is not well formed, and anyone without the app token', async () => {
    expect((await post('/api/update/report', { outcome: 'installed' })).status).toBe(400);
    for (const version of ['v0.2.1', '0.2', '<b>', 3]) expect((await post('/api/update/pending', { version })).status).toBe(400);
    expect((await fetch(`${base}/api/update/pending`, { method: 'POST', body: JSON.stringify({ version: '0.2.1' }) })).status).toBe(401);
  });
});

describe('installing automatically (the default)', () => {
  it('says install now when nothing runs, writes it down, and after the restart on the new version says it calmly once', async () => {
    expect(await offer()).toEqual({ install: true });
    // No notice and no message before it has happened.
    expect((await state()).update).toBeUndefined();
    expect(notified).toHaveLength(0);

    await stop();
    await start({ appVersion: '0.2.1' });
    const s = await state();
    expect(s.update).toEqual({ kind: 'updated', version: '0.2.1', date: '2026-11-26', notes: ['Fixes the scan button.', 'Reads prices faster.'], link: null });
    expect(s.updater?.version).toBe('0.2.1');
    expect((await activity()).versions!.map((v) => v.sentence)).toEqual(['Split Finder was updated to 0.2.1.']);
    expect(notified).toHaveLength(0);

    expect((await post('/api/update/dismiss', { version: '0.2.1' })).status).toBe(200);
    expect((await state()).update).toBeUndefined();
    await stop();
    await start({ appVersion: '0.2.1' });
    expect((await state()).update).toBeUndefined();
  });

  it('an install that did not finish (still the old version at the next start) is one Activity line, and no notice', async () => {
    expect(await offer()).toEqual({ install: true });
    await stop();
    await start({ appVersion: '0.2.0' });
    expect((await state()).update).toBeUndefined();
    expect((await activity()).versions!.map((v) => v.sentence)).toEqual(['The update to 0.2.1 did not finish. Split Finder is still on 0.2.0 and looks again in 6 hours.']);
  });

  it('never installs a version that is not newer', async () => {
    for (const v of ['0.2.0', '0.1.9']) expect((await offer(v)).install).toBe(false);
  });

  it('waits in the quarter hour before a scheduled scan', async () => {
    vi.spyOn(agent.work, 'nextScanAt').mockReturnValue(new Date(clock + 10 * 60_000).toISOString());
    expect(await offer()).toEqual({ install: false, why: 'A scheduled scan starts soon; it installs after the scan.' });
    vi.spyOn(agent.work, 'nextScanAt').mockReturnValue(new Date(clock + 60 * 60_000).toISOString());
    expect(await offer()).toEqual({ install: true });
  });

  it('waits while a scan runs', async () => {
    vi.spyOn(agent.work, 'state').mockReturnValue({ busy: 'scan', stopping: false, pipeline: null, searchesUsed: 0 } as never);
    expect(await offer()).toEqual({ install: false, why: 'It installs when nothing is running; a scan is running.' });
  });

  it('with looking for new versions off, installs nothing', async () => {
    await patch({ updates: { tellMeAboutNewVersion: false } });
    expect((await offer()).install).toBe(false);
  });
});

describe('with automatic installs off', () => {
  beforeEach(async () => {
    expect((await patch({ updates: { installAutomatically: false } })).status).toBe(200);
  });

  it('says once that the version is ready (notice, Activity, one message), and installs after Install now', async () => {
    expect(await offer()).toEqual({ install: false, why: 'Waiting for you to press Install now.' });
    expect(await offer()).toEqual({ install: false, why: 'Waiting for you to press Install now.' });
    expect((await state()).update).toEqual({ kind: 'ready', version: '0.2.1', date: '2026-11-26', notes: ['Fixes the scan button.', 'Reads prices faster.'], link: null });
    expect((await state()).updater?.ready).toBe('0.2.1');
    expect(notified.map((n) => [n.kind, n.body])).toEqual([
      ['version', 'Split Finder 0.2.1 is ready. What changed: Fixes the scan button. Reads prices faster. Open Split Finder and press Install now when you like.'],
    ]);
    expect((await activity()).versions!.map((v) => v.sentence)).toEqual(['Version 0.2.1 is ready.']);

    expect((await post('/api/update/install-now', { version: '0.2.1' })).status).toBe(200);
    expect(await offer()).toEqual({ install: true });
  });

  it('Install now waits for a running scan, and the notice says why', async () => {
    await offer();
    await post('/api/update/install-now', { version: '0.2.1' });
    vi.spyOn(agent.work, 'state').mockReturnValue({ busy: 'scan', stopping: false, pipeline: null, searchesUsed: 0 } as never);
    expect((await offer()).install).toBe(false);
    expect((await state()).update).toMatchObject({ kind: 'ready', waiting: 'It installs when nothing is running; a scan is running.' });
  });

  it('Install now for a version the shell does not hold is refused; the notice goes when the shell stops offering', async () => {
    expect((await post('/api/update/install-now', { version: '0.2.1' })).status).toBe(409);
    await offer();
    clock += 3 * 60_000;
    expect((await state()).update).toBeUndefined();
    expect((await post('/api/update/install-now', { version: '0.2.1' })).status).toBe(409);
  });

  it('nothing here reaches the network', () => {
    expect(fetched).toEqual([]);
  });
});
