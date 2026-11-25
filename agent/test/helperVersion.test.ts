// Nov 23: the owner's paired helper was an older build; a `bogoListing` job came back "This browser does not know that
// kind of job." and read as a Home Depot failure. The helper now names its build in heartbeats, the agent compares it with
// the build of the zip it ships, an unknown kind is an outdated helper (the job fails at once, not retried), and one
// `reload` job is queued for it. No network.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentState, WorkerJob } from '../../core/src/api/contract';
import { createAgent, type Agent } from '../app';
import { manifestBuild, shippedHelperVersion, zipEntryText } from '../setup';
import { Store } from '../store';
import { HELPER_OUTDATED, WorkerJobs } from '../workerJobs';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;
const SHIPPED = '0.1.0+e4a2bea';

let server: Server;
let agent: Agent;
let base: string;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-helper-')), port, timers: false, shippedHelperVersion: SHIPPED });
  server.on('request', agent.handle);
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' } });
const ext = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN, 'Content-Type': 'application/json' } });
const helperState = async () => ((await (await ui('/api/state')).json()) as AgentState).helper;
const reloads = () => agent.store.get('jobs').filter((j) => j.kind === 'reload' && j.status === 'queued');

async function pair(): Promise<string> {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { Origin: EXT_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { requestId, claimSecret } = (await (await post('/api/pair/request', { extensionId: EXT })).json()) as { requestId: string; claimSecret: string };
  await post('/api/pair/claim', { requestId, claimSecret });
  await ui('/api/pair/approve', { method: 'POST', body: JSON.stringify({ requestId }) });
  return ((await (await post('/api/pair/claim', { requestId, claimSecret })).json()) as { token: string }).token;
}

describe('the helper build', () => {
  // Nov 25: a reload loads the same old files, so for a build that differs from the shipped one the agent queues none unless it
  // has put the new files in the helper's folder first (test/helperUpdate.test.ts). Here no folder is known: the one button is
  // "Install the helper again" (helper.update).
  it('a heartbeat with no build (a helper made before Nov 23) is outdated, and no reload is queued for old files', async () => {
    const token = await pair();
    await ext(token, '/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({}) });
    expect(await helperState()).toMatchObject({ outdated: true, update: { state: 'install' } });
    expect(reloads()).toHaveLength(0);
    // Today's helper then names the shipped build: no longer outdated.
    await ext(token, '/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ version: SHIPPED }) });
    expect(await helperState()).not.toHaveProperty('outdated');
  });

  it('a heartbeat names the build; another build than the shipped one is outdated, and no reload is queued for old files', async () => {
    const token = await pair();
    expect(await helperState()).not.toHaveProperty('outdated');
    await ext(token, '/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ version: '0.1.0+3c92cc7' }) });
    expect(await helperState()).toMatchObject({ outdated: true, version: '0.1.0+3c92cc7', update: { state: 'install' } });
    expect(reloads()).toHaveLength(0);
    // The same build again queues nothing more.
    await ext(token, '/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ version: '0.1.0+3c92cc7' }) });
    expect(reloads()).toHaveLength(0);
    // A version that is not plain text is ignored.
    await ext(token, '/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ version: '<script>' }) });
    expect((await helperState()).version).toBe('0.1.0+3c92cc7');
    // Reloaded into the shipped build: no longer outdated.
    await ext(token, '/api/worker/heartbeat', { method: 'POST', body: JSON.stringify({ version: SHIPPED }) });
    const h = await helperState();
    expect(h.version).toBe(SHIPPED);
    expect(h).not.toHaveProperty('outdated');
    expect(h).not.toHaveProperty('update');
  });

  it('a job the helper does not know fails at once as an outdated helper, not Home Depot, and a reload is queued once', async () => {
    const token = await pair();
    const listing = agent.jobs.enqueue('bogoListing', { path: '/b/x' });
    const next = (await (await ext(token, `/api/worker/next?wait=1&v=${SHIPPED}`)).json()) as { job: { id: string } };
    expect(next.job.id).toBe(listing.id);
    // An older build answers as it did on Nov 23, with no `outdated` field.
    const done = await ext(token, '/api/worker/result', { method: 'POST', body: JSON.stringify({ id: listing.id, ok: false, error: 'This browser does not know that kind of job.' }) });
    expect(await done.json()).toEqual({ status: 'failed' });
    expect(agent.jobs.get(listing.id)).toMatchObject({ status: 'failed', attempts: 1, error: HELPER_OUTDATED });
    expect(await helperState()).toMatchObject({ outdated: true });
    expect(reloads()).toHaveLength(1);

    // The old build does not know `reload` either: that fails the same way, and nothing more is queued for it.
    const reload = (await (await ext(token, `/api/worker/next?wait=1&v=${SHIPPED}`)).json()) as { job: WorkerJob };
    expect(reload.job.kind).toBe('reload');
    await ext(token, '/api/worker/result', { method: 'POST', body: JSON.stringify({ id: reload.job.id, ok: false, error: 'This browser does not know that kind of job.', outdated: true }) });
    expect(reloads()).toHaveLength(0);

    // The owner's Reload helper button queues one more, and only one while it waits.
    expect(await (await ui('/api/helper/reload', { method: 'POST', body: '{}' })).json()).toEqual({ queued: true });
    await ui('/api/helper/reload', { method: 'POST', body: '{}' });
    expect(reloads()).toHaveLength(1);
    // The extension cannot ask for it itself.
    expect((await ext(token, '/api/helper/reload', { method: 'POST', body: '{}' })).status).toBe(403);
  });

  it('a poll names the build like a heartbeat: another build is outdated, the shipped one clears it, none is unversioned', async () => {
    const token = await pair();
    const poll = (q: string) => ext(token, `/api/worker/next?wait=0${q}`);
    expect((await poll('&v=0.1.0%2B3c92cc7')).status).toBe(204);
    expect(await helperState()).toMatchObject({ outdated: true, version: '0.1.0+3c92cc7' });
    expect(agent.store.get('jobs').filter((j) => j.kind === 'reload')).toHaveLength(0);
    await poll(`&v=${encodeURIComponent(SHIPPED)}`);
    const h = await helperState();
    expect(h.version).toBe(SHIPPED);
    expect(h).not.toHaveProperty('outdated');
  });

  it('a poll with no v from a helper with no known build marks it unversioned', async () => {
    const token = await pair();
    await ext(token, '/api/worker/next?wait=0');
    expect(await helperState()).toMatchObject({ outdated: true, version: 'unversioned' });
  });

  it('a Home Depot refusal is still a failure that is handed out once more, never an outdated helper', () => {
    const store = Store.open(mkdtempSync(join(tmpdir(), 'sf-jobs-')));
    let told = 0;
    const jobs = new WorkerJobs(store, { onOutdated: () => void told++ });
    const job = jobs.enqueue('page', { itemIds: ['320243741'] });
    jobs.take(['page']);
    expect(jobs.complete({ id: job.id, ok: false, error: 'The Home Depot tab did not load.' })).toBe('queued');
    expect(told).toBe(0);
    jobs.take(['page']);
    expect(jobs.complete({ id: job.id, ok: false, error: 'x', outdated: true })).toBe('failed');
    expect(told).toBe(1);
    store.close();
  });
});

/** A zip as `wxt zip` writes one: local headers, a central directory and its end record, deflated or stored. */
function zipOf(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

describe('the build of the zip the app ships', () => {
  it("reads the manifest's version_name from the zip, deflated or stored, at its root or in one folder", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-zip-'));
    const manifest = JSON.stringify({ manifest_version: 3, version: '0.1.0', version_name: SHIPPED });
    const deflated = join(dir, 'split-finder-0.1.0-chrome.zip');
    writeFileSync(deflated, zipOf({ 'background.js': 'x', 'manifest.json': manifest }));
    expect(shippedHelperVersion(deflated)).toBe(SHIPPED);
    const stored = join(dir, 'stored.zip');
    writeFileSync(stored, zipOf({ 'chrome-mv3/manifest.json': manifest, 'chrome-mv3/fonts/manifest.json': '{}' }, false));
    expect(zipEntryText(stored, 'manifest.json')).toBe(manifest);
    // A build with no version_name is its version; no zip, not a zip, or no manifest: unknown.
    expect(manifestBuild(JSON.stringify({ version: '0.1.0' }))).toBe('0.1.0');
    expect(shippedHelperVersion(null)).toBeNull();
    writeFileSync(join(dir, 'junk.zip'), 'not a zip');
    expect(shippedHelperVersion(join(dir, 'junk.zip'))).toBeNull();
    expect(shippedHelperVersion(join(dir, 'missing.zip'))).toBeNull();
  });
});
