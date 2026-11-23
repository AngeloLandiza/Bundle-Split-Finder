// What scripts/windows-smoke.ps1 assumes about the agent, checked here against the real agent code, so the
// script cannot drift silently. The script itself only runs on Windows (.github/workflows/windows-smoke.yml).
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type Agent } from '../agent/app';
import { KEY_NAMES } from '../core/src/api/contract';

const script = readFileSync(new URL('../scripts/windows-smoke.ps1', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/windows-smoke.yml', import.meta.url), 'utf8');

/** The script's own proof: HMAC-SHA256 keyed by the token over "split-finder-hello:<nonce>", lowercase hex. */
const smokeProof = (token: string, nonce: string) => createHmac('sha256', token).update(`split-finder-hello:${nonce}`).digest('hex');

let server: Server;
let agent: Agent;
let base: string;
let port: number;
let quits = 0;
let dataDir = '';

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  quits = 0;
  dataDir = mkdtempSync(join(tmpdir(), 'sf-smoke-'));
  agent = createAgent({
    dataDir, port, timers: false, shippedHelperVersion: null, onQuit: () => void quits++,
  });
  server.on('request', agent.handle);
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const bearer = () => ({ Authorization: `Bearer ${agent.auth.uiToken}` });

describe('windows smoke: what the script assumes', () => {
  it('answers the hello challenge with the HMAC the script computes', async () => {
    const nonce = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE'; // 43 url-safe characters, as the script makes
    const r = await get(`/api/hello?nonce=${nonce}`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { proof: string }).proof).toBe(smokeProof(agent.auth.uiToken, nonce));
  });

  it('a fresh store reports an idle agent, an unpaired helper and every key false', async () => {
    const r = await get('/api/state', bearer());
    expect(r.status).toBe(200);
    const s = (await r.json()) as { agent: { status: string }; helper: { paired: boolean }; keys: Record<string, boolean> };
    expect(s.agent.status).toBe('idle');
    expect(s.helper.paired).toBe(false);
    expect(Object.keys(s.keys).sort()).toEqual([...KEY_NAMES].sort());
    expect(Object.values(s.keys).every((v) => v === false)).toBe(true);
  });

  it('refuses no token with 401, a foreign Origin with 403, and accepts the app\'s own Origin', async () => {
    expect((await get('/api/state')).status).toBe(401);
    expect((await get('/api/state', { ...bearer(), Origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/api/state', { ...bearer(), Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  it('quit answers 200 to the app token and calls the stop hook', async () => {
    const r = await fetch(`${base}/api/agent/quit`, { method: 'POST', headers: { ...bearer(), 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(quits).toBe(1);
  });

  it('writes the token file the script reads, at least 32 characters', () => {
    const t = readFileSync(join(dataDir, 'agent-token'), 'utf8').trim();
    expect(t).toBe(agent.auth.uiToken);
    expect(t.length).toBeGreaterThanOrEqual(32);
  });
});

describe('windows smoke: the script and the workflow name the same things as the code', () => {
  it('the script checks the same key names, routes and port', () => {
    for (const k of KEY_NAMES) expect(script).toContain(`'${k}'`);
    for (const route of ['/api/hello?nonce=', '/api/state', '/api/agent/quit']) expect(script).toContain(route);
    expect(script).toContain('split-finder-hello:');
    expect(script).toMatch(/\$Port = 8790|\[int\]\$Port = 8790/);
    expect(script).toContain("'agent-token'");
    expect(script).toContain("'store'");
    expect(script).toContain('agent-dashboard');
    expect(script).toContain('com.bundlesplitfinder.desktop');
  });

  it('the data folder name in the script is the app identifier', () => {
    const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { identifier: string };
    expect(script).toContain(conf.identifier);
  });

  it('the script checks exactly the three secret files, by SID, and nothing wide on the store folder', () => {
    const store = readFileSync(new URL('../agent/store.ts', import.meta.url), 'utf8');
    // the agent narrows the files it writes 0o600: the store's keys and pairing, and the token (auth.ts)
    expect(/OWNER_ONLY[^=]*= new Set\(\['keys', 'pairing'\]\)/.test(store)).toBe(true);
    const auth = readFileSync(new URL('../agent/auth.ts', import.meta.url), 'utf8');
    expect(auth).toContain("writeFileAtomic(path, `${token}\\n`, 0o600)");
    for (const f of ["'agent-token'", "'store\\keys.json'", "'store\\pairing.json'"]) expect(script).toContain(f);
    expect(script).toContain('Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    for (const sid of ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11']) expect(script).toContain(sid);
    expect(script).toContain("'\\(I\\)'");
  });

  it('the workflow builds natively, runs the script, and the Node version is the sidecar\'s', () => {
    const bundle = readFileSync(new URL('./bundle-agent.ts', import.meta.url), 'utf8');
    const version = /NODE_VERSION = 'v([0-9.]+)'/.exec(bundle)?.[1];
    expect(version).toBeTruthy();
    expect(workflow).toContain(`node-version: '${version}'`);
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('x86_64-pc-windows-msvc');
    expect(workflow).not.toContain('cargo-xwin');
    expect(workflow).toContain('scripts/windows-smoke.ps1');
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toMatch(/tags:\s*\['v\*'\]/);
  });
});
