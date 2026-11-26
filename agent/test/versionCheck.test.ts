// Nov 25, new versions: the agent looks at the project's public release note once a day and tells the owner once per
// version (docs/decisions.md, "New versions"). A fake fetch only: no test reaches the network.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, ActivityResponse, NotifyEvent } from '../../core/src/api/contract';
import { MAX_FILE_BYTES, RELEASE_URL } from '../../core/src/release/note';
import { createAgent, type Agent } from '../app';
import { RELEASE_EVERY_MS } from '../versionCheck';

const GOOD = 'https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.1.1/Split-Finder-0.1.1-setup.exe';
const file = (o: Record<string, unknown> = {}) => JSON.stringify({ version: '0.1.1', date: '2026-11-26', notes: ['Fixes the scan button.', 'Faster Review'], downloadUrl: GOOD, ...o });
const TOKEN = '123456:SECRET-bot-token-abc';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let server: Server;
let agent: Agent;
let base: string;
let calls: Call[];
let release: () => Response;
let clock = Date.parse('2026-11-26T12:00:00Z');
let notified: NotifyEvent[];
let logged: string[];

/** The release note and Telegram answer; any other address is a test failure. */
const fake = (async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  if (String(url) === RELEASE_URL) return release();
  if (String(url).startsWith('https://api.telegram.org/')) return new Response('{"ok":true,"result":{}}', { status: 200 });
  throw new Error(`unexpected request to ${String(url)}`);
}) as unknown as typeof fetch;

const make = async (appVersion: string | null = '0.1.0') => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-ver-')), port, timers: false, fetchFn: fake, shippedHelperVersion: null, appVersion, now: () => clock, releaseLog: (l) => logged.push(l) });
  server.on('request', agent.handle);
  vi.spyOn(agent.events, 'publish').mockImplementation(((name: string, data: unknown) => {
    if (name === 'notify') notified.push(data as NotifyEvent);
  }) as never);
};

beforeEach(async () => {
  calls = [];
  notified = [];
  logged = [];
  clock = Date.parse('2026-11-26T12:00:00Z');
  release = () => new Response(file(), { status: 200 });
  await make();
});

afterEach(async () => {
  vi.restoreAllMocks();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const state = async () => (await (await ui('/api/state')).json()) as AgentState;
const activity = async () => (await (await ui('/api/activity')).json()) as ActivityResponse;
const telegramCalls = () => calls.filter((c) => c.url.startsWith('https://api.telegram.org/'));
const releaseCalls = () => calls.filter((c) => c.url === RELEASE_URL);
const setTelegram = () => agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: '42' } }));
const patch = (body: unknown) => ui('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });

const TEXT = `Split Finder 0.1.1 is ready. What changed: Fixes the scan button. Faster Review. Download: ${GOOD}`;

describe('a newer version', () => {
  it('is announced once: an Activity entry, one system notification, one Telegram message, one notice with its link', async () => {
    setTelegram();
    expect(await agent.checkVersion({ force: true })).toBe('announced');

    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ kind: 'version', title: 'Split Finder', body: TEXT });
    expect(telegramCalls()).toHaveLength(1);
    expect(JSON.parse(String(telegramCalls()[0]!.init?.body))).toEqual({ chat_id: '42', text: TEXT });

    const a = await activity();
    expect(a.versions).toHaveLength(1);
    expect(a.versions![0]).toMatchObject({ version: '0.1.1', sentence: 'Split Finder 0.1.1 is ready. What changed: Fixes the scan button. Faster Review.' });
    expect(JSON.stringify(a.versions)).not.toContain('https://');

    expect((await state()).update).toEqual({ version: '0.1.1', date: '2026-11-26', notes: ['Fixes the scan button.', 'Faster Review'], link: GOOD });
  });

  it('is never announced again for the same version, however often the note is read, even after a restart', async () => {
    setTelegram();
    await agent.checkVersion({ force: true });
    expect(await agent.checkVersion({ force: true })).toBe('seen');
    expect(await agent.checkVersion({ force: true })).toBe('seen');
    expect(notified).toHaveLength(1);
    expect(telegramCalls()).toHaveLength(1);
    expect((await activity()).versions).toHaveLength(1);
  });

  it('a newer one again is announced again (once)', async () => {
    await agent.checkVersion({ force: true });
    release = () => new Response(file({ version: '0.1.2', notes: ['Another fix.'] }), { status: 200 });
    expect(await agent.checkVersion({ force: true })).toBe('announced');
    expect(notified.map((n) => n.body.slice(0, 27))).toEqual(['Split Finder 0.1.1 is ready', 'Split Finder 0.1.2 is ready']);
    expect((await state()).update?.version).toBe('0.1.2');
  });

  it('without Telegram set up only the system notification goes', async () => {
    await agent.checkVersion({ force: true });
    expect(notified).toHaveLength(1);
    expect(telegramCalls()).toHaveLength(0);
  });

  it('with the notification kind off: no system notification and no Telegram, but the quiet notice and Activity stay', async () => {
    setTelegram();
    expect((await patch({ notifications: { kinds: { version: false } } })).status).toBe(200);
    await agent.checkVersion({ force: true });
    expect(notified).toHaveLength(0);
    expect(telegramCalls()).toHaveLength(0);
    expect((await state()).update?.version).toBe('0.1.1');
    expect((await activity()).versions).toHaveLength(1);
  });

  it('closing the notice keeps it closed for that version only', async () => {
    await agent.checkVersion({ force: true });
    expect((await ui('/api/update/dismiss', { method: 'POST', body: JSON.stringify({ version: '0.1.1' }) })).status).toBe(200);
    expect((await state()).update).toBeUndefined();
    await agent.checkVersion({ force: true });
    expect((await state()).update).toBeUndefined();
    release = () => new Response(file({ version: '0.1.2' }), { status: 200 });
    await agent.checkVersion({ force: true });
    expect((await state()).update?.version).toBe('0.1.2');
  });

  it('the dismiss route refuses anything that is not a version', async () => {
    for (const body of [{}, { version: 3 }, { version: '<b>' }, { version: '0.1' }]) {
      expect((await ui('/api/update/dismiss', { method: 'POST', body: JSON.stringify(body) })).status).toBe(400);
    }
  });
});

describe('an equal or older version, or none the app can compare', () => {
  it('is never shown or announced', async () => {
    for (const v of ['0.1.0', '0.0.9']) {
      release = () => new Response(file({ version: v }), { status: 200 });
      expect(await agent.checkVersion({ force: true })).toBe('current');
    }
    expect(notified).toHaveLength(0);
    expect((await state()).update).toBeUndefined();
    expect((await activity()).versions).toBeUndefined();
  });

  it('a running version that is not x.y.z (or unknown) is never compared and nothing is requested', async () => {
    for (const v of [null, '0.1.0+3c92cc7', 'dev']) {
      agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await make(v);
      expect(await agent.checkVersion({ force: true })).toBe('unknown');
    }
    expect(calls).toHaveLength(0);
  });

  it('a running version above the note: the note is read and ignored', async () => {
    agent.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await make('0.2.0');
    expect(await agent.checkVersion({ force: true })).toBe('current');
    expect((await state()).update).toBeUndefined();
  });
});

describe('a bad file or a failed request is ignored, and silent to the owner', () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ['HTML instead of JSON', () => new Response('<!DOCTYPE html><html><body>404: Not Found</body></html>', { status: 200 })],
    ['wrong types', () => new Response(file({ version: 11 }), { status: 200 })],
    ['notes not a list', () => new Response(file({ notes: 'Fixes it' }), { status: 200 })],
    ['a note longer than 120', () => new Response(file({ notes: ['x'.repeat(121)] }), { status: 200 })],
    ['too many notes', () => new Response(file({ notes: ['1', '2', '3', '4', '5', '6'] }), { status: 200 })],
    ['a bad date', () => new Response(file({ date: 'soon' }), { status: 200 })],
    ['too big', () => new Response(file({ notes: ['x'] }) + ' '.repeat(MAX_FILE_BYTES), { status: 200 })],
    ['too big by its own length header', () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_FILE_BYTES + 1) } })],
    ['not found', () => new Response('Not Found', { status: 404 })],
    ['a redirect', () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } })],
  ];
  for (const [name, make] of cases) {
    it(name, async () => {
      release = make as () => Response;
      expect(await agent.checkVersion({ force: true })).toBe('failed');
      expect(notified).toHaveLength(0);
      expect((await state()).update).toBeUndefined();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/^\[release\] the release note /);
    });
  }

  it('a request that throws (offline), with nothing from the error in the log line', async () => {
    release = () => {
      throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com?token=SECRET');
    };
    expect(await agent.checkVersion({ force: true })).toBe('failed');
    expect(logged).toEqual(['[release] the release note could not be reached.']);
    expect(notified).toHaveLength(0);
  });

  it('a failure is tried again in hours, a success in a day', async () => {
    release = () => new Response('nope', { status: 500 });
    await agent.checkVersion({ force: true });
    expect(await agent.checkVersion()).toBe('not-due');
    clock += 7 * 3_600_000;
    release = () => new Response(file({ version: '0.1.0' }), { status: 200 });
    expect(await agent.checkVersion()).toBe('current');
    clock += RELEASE_EVERY_MS - 1000;
    expect(await agent.checkVersion()).toBe('not-due');
    clock += 2000;
    expect(await agent.checkVersion()).toBe('current');
    expect(releaseCalls()).toHaveLength(3);
  });
});

describe('the link is checked before it is shown', () => {
  const bad = [
    'http://drive.google.com/file/d/abc',
    'https://evil.example/Split.exe',
    'https://drive.google.com.evil.example/x',
    'https://user@drive.google.com/x',
    'https://github.com/someone-else/repo/releases',
    'https://github.com/AngeloLandiza/Bundle-Split-Finder/../../evil',
    'javascript:alert(1)',
    `https://drive.google.com/${'a'.repeat(300)}`,
    'https://drive.google.com/a\tb',
  ];
  for (const link of bad) {
    it(`drops ${link.slice(0, 50).replace(/\t/g, '\\t')}`, async () => {
      release = () => new Response(file({ downloadUrl: link }), { status: 200 });
      setTelegram();
      expect(await agent.checkVersion({ force: true })).toBe('announced');
      expect((await state()).update).toMatchObject({ version: '0.1.1', link: null });
      expect(notified[0]!.body).toBe('Split Finder 0.1.1 is ready. What changed: Fixes the scan button. Faster Review. Ask the developer for the download link.');
      expect(JSON.stringify(notified)).not.toContain('evil');
      expect(String(telegramCalls()[0]!.init?.body)).not.toContain('evil');
      expect(logged).toEqual(['[release] the release note names a download link that is not allowed; it is shown without one.']);
    });
  }

  it('a null link (nothing to download yet) says to ask the developer', async () => {
    release = () => new Response(file({ downloadUrl: null }), { status: 200 });
    await agent.checkVersion({ force: true });
    expect((await state()).update).toMatchObject({ link: null });
    expect(logged).toEqual([]);
  });

  it('Google Drive and Docs links are kept', async () => {
    release = () => new Response(file({ downloadUrl: 'https://drive.google.com/file/d/abc123/view?usp=sharing' }), { status: 200 });
    await agent.checkVersion({ force: true });
    expect((await state()).update?.link).toBe('https://drive.google.com/file/d/abc123/view?usp=sharing');
  });
});

describe('what the request sends', () => {
  it('a plain GET of the one address, with a generic User-Agent and nothing about the owner', async () => {
    setTelegram();
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'SERP-KEY-1234567890', anthropic: 'sk-ant-SECRET-1234567890' }));
    await agent.checkVersion({ force: true });
    const [c] = releaseCalls();
    expect(c!.url).toBe('https://raw.githubusercontent.com/AngeloLandiza/Bundle-Split-Finder/main/docs/release.json');
    expect(c!.init?.method).toBe('GET');
    expect(c!.init?.body).toBeUndefined();
    expect(c!.init?.credentials).toBe('omit');
    expect(c!.init?.redirect).toBe('error');
    expect(c!.init?.signal).toBeDefined();
    expect(c!.init?.headers).toEqual({ 'User-Agent': 'SplitFinder', Accept: 'application/json, text/plain' });
    expect(JSON.stringify(c)).not.toMatch(/SECRET|SERP-KEY|0\.1\.0|127\.0\.0\.1/);
  });

  it('the only hosts reached are the release note and Telegram', async () => {
    setTelegram();
    await agent.checkVersion({ force: true });
    expect(new Set(calls.map((c) => new URL(c.url).hostname))).toEqual(new Set(['raw.githubusercontent.com', 'api.telegram.org']));
  });
});

describe('"Tell me when a new version is ready"', () => {
  it('is on by default, and so is installing automatically', async () => {
    const s = (await (await ui('/api/settings')).json()) as { settings: { updates?: { tellMeAboutNewVersion: boolean } } };
    expect(s.settings.updates).toEqual({ tellMeAboutNewVersion: true, installAutomatically: true });
  });

  it('off: no request at all, no notice, no message', async () => {
    expect((await patch({ updates: { tellMeAboutNewVersion: false } })).status).toBe(200);
    expect(await agent.checkVersion({ force: true })).toBe('off');
    expect(await agent.checkVersion()).toBe('off');
    expect(calls).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  it('off hides a notice already known; on again shows it, without a second announcement', async () => {
    await agent.checkVersion({ force: true });
    await patch({ updates: { tellMeAboutNewVersion: false } });
    expect((await state()).update).toBeUndefined();
    await patch({ updates: { tellMeAboutNewVersion: true } });
    expect((await state()).update?.version).toBe('0.1.1');
    await agent.checkVersion({ force: true });
    expect(notified).toHaveLength(1);
  });

  it('turned off while the request is out: nothing is kept or said', async () => {
    release = () => {
      agent.store.update('settings', (s) => ({ ...s, updates: { tellMeAboutNewVersion: false } }));
      return new Response(file(), { status: 200 });
    };
    expect(await agent.checkVersion({ force: true })).toBe('off');
    expect(notified).toHaveLength(0);
  });

  it('refuses a value that is not true or false', async () => {
    expect((await patch({ updates: { tellMeAboutNewVersion: 'yes' } })).status).toBe(400);
  });

  it('with the background timers off, nothing is requested by itself', async () => {
    expect(calls).toHaveLength(0);
  });
});
