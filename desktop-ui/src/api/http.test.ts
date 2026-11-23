// The real client against the real agent, in this process, on 127.0.0.1 and a temp folder: the bearer token on every
// call, the event stream read with fetch, the agent's own answers through map.ts. Nothing leaves the machine and no
// search is spent (the agent runs without its timers).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent, type Agent } from '../../../agent/app';
import type { ReviewItem } from '@core/scan/types';
import type { ApiClient } from './client';
import { createHttpClient } from './http';
import { ApiError, type AgentEvent } from './types';

// A key saved is checked with its own service (agent/keyChecks.ts); no test reaches one.
const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const realFetch = globalThis.fetch;

let server: Server;
let agent: Agent;
let client: ApiClient;
let base: string;

function useToken(token: string): void {
  vi.stubGlobal('window', { __SPLIT_FINDER_TOKEN__: token });
}

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-ui-')), port, timers: false, fetchFn: offline });
  server.on('request', agent.handle);
  // The page calls /api/... on its own origin; here that origin is the test's agent.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init));
  useToken(agent.auth.uiToken);
  client = createHttpClient();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const splitQuestion = (): ReviewItem => ({
  id: 'split:K1', kind: 'split', subject: 'K1', brand: 'DEWALT', model: 'DCK200D1P1W921B', title: 'ATOMIC 20-Volt 2-Tool Combo Kit',
  reason: 'Two impact wrenches fit the title.', candidates: [], choices: [['DCF891B', 'DCD708B'], ['DCF921B', 'DCD708B']], openedAt: 1_700_000_000_000, answer: null, answeredAt: null,
});

describe('the real client on the real agent', () => {
  it('reads the state with the token, and is refused without it', async () => {
    const s = await client.state();
    expect(s.firstRun).toBe(true);
    expect(s.agent.status).toBe('idle');
    expect(s.budget.serpLeft).toBeNull();
    expect(s.keys.serpapi).toBe(false);
    useToken('not-the-token');
    await expect(createHttpClient().state()).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('reads a stored question as the screens take it, and says the agent\'s own sentence when an answer is refused', async () => {
    agent.store.update('review', (r) => ({ ...r, at: '2026-11-22T10:00:00.000Z', questions: [splitQuestion()] }));
    const { questions } = await client.review();
    expect(questions).toHaveLength(1);
    const q = questions[0]!;
    expect(q).toMatchObject({ id: 'split:K1', kind: 'split', prompt: 'What is inside the DEWALT DCK200D1P1W921B?', allowNone: true, allowTyped: true, suggestion: null });
    expect(q.choices.map((c) => c.id)).toEqual(['choice:0', 'choice:1']);
    expect(q.seen).toBe('[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]');
    // The scan's own store holds no such question, so the agent says so in its error shape; the sentence reaches the screen.
    const err = await client.answer(q.id, { choiceId: 'choice:1' }, { fromSuggestion: false, seen: q.seen }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/not found/i);
  });

  it('saves keys without ever reading one back, eBay as an App ID and a Cert ID', async () => {
    // The services cannot be reached from here: the key is kept, and the answer says it could not be checked (not that it is wrong).
    expect(await client.putKey('ebay', { appId: 'app-id-1', certId: 'cert-id-1' })).toMatchObject({ ok: false, kind: 'network' });
    expect(await client.putKey('serpapi', { key: 'secret-serp-key-0000' })).toMatchObject({ ok: false, kind: 'network' });
    expect(await client.checkKey('serpapi')).toMatchObject({ ok: false, kind: 'network', problem: 'Could not reach SerpApi to check it just now. Try again in a moment.' });
    const s = await client.state();
    expect(s.keys).toMatchObject({ ebay: true, serpapi: true, keepa: false });
    expect(JSON.stringify(await client.settings())).not.toContain('secret-serp-key');
    await client.deleteKey('ebay');
    expect((await client.state()).keys.ebay).toBe(false);
  });

  it('changes a provider and takes the key and trust the agent sets with it', async () => {
    const saved = await client.patchSettings({ ai: { research: { provider: 'openai-compatible' } } });
    expect(saved.ai.research).toMatchObject({ provider: 'openai-compatible', apiKeyRef: 'openai', trusted: false });
    expect((await client.settings()).ai.research.provider).toBe('openai-compatible');
  });

  it('lists a pairing request, allows it, lists the paired Chrome, and revokes it', async () => {
    const asked = agent.auth.requestPairing(EXT, `chrome-extension://${EXT}`);
    expect('code' in asked).toBe(true);
    const pending = await client.pairRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ extensionId: EXT, code: (asked as { code: string }).code });
    await client.decidePairing(pending[0]!.requestId, true);
    expect(await client.pairRequests()).toEqual([]);
    // The extension collects its token; only then is it a paired Chrome.
    const claim = agent.auth.claim(pending[0]!.requestId, (asked as { claimSecret: string }).claimSecret, `chrome-extension://${EXT}`);
    expect(claim).toMatchObject({ status: 'approved' });
    expect((await client.pairedExtensions()).map((p) => p.extensionId)).toEqual([EXT]);
    expect((await client.state()).helper.paired).toBe(true);
    await client.revokeExtension(EXT);
    expect(await client.pairedExtensions()).toEqual([]);
  });

  it('installs the Chrome helper: the agent unpacks its zip into the folder and the client says where', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sf-helper-src-'));
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Helper', version: '0.1.0', permissions: ['storage'] }));
    writeFileSync(join(src, 'background.js'), '//');
    const zip = join(mkdtempSync(join(tmpdir(), 'sf-helper-zip-')), 'bundle-split-finder-0.1.0-chrome.zip');
    execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: src });
    const dir = join(mkdtempSync(join(tmpdir(), 'sf-helper-dir-')), 'split-finder');
    vi.stubEnv('SPLIT_FINDER_EXTENSION_ZIP', zip);
    vi.stubEnv('SPLIT_FINDER_EXTENSION_DIR', dir);
    try {
      const r = await client.installExtension();
      expect(r).toMatchObject({ ok: true, extensionDir: dir, extensionReady: true, zipAvailable: true });
      expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('resets the scan data and says where the backup is; the keys stay', async () => {
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-0123456789' }));
    const { backup } = await client.resetScanData();
    expect(existsSync(backup)).toBe(true);
    expect(agent.store.get('keys').serpapi).toBe('serp-secret-0123456789');
  });

  it('streams the agent\'s events through fetch with the token, the state first and then a change', async () => {
    const events: AgentEvent[] = [];
    const statuses: string[] = [];
    const off = client.subscribe((e) => events.push(e), (s) => statuses.push(s));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'state')).toBe(true));
    expect(statuses[0]).toBe('live');
    agent.store.update('review', (r) => ({ ...r, questions: [splitQuestion()] }));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'review')).toBe(true));
    const latest = [...events].reverse().find((e) => e.type === 'state');
    expect(latest && latest.type === 'state' ? latest.state.counts.review : null).toBe(1);
    off();
  });

  it('is told when the agent is not there', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    await expect(createHttpClient().state()).rejects.toMatchObject({ kind: 'offline' });
  });
});
