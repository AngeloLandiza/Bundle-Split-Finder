// Running without the owner (Nov 25): Chrome opened for a scheduled scan, "Open at login" turned on once, the catch-up sentence and the
// weekly message, with the agent's real scheduler on a fake clock. A fake Chrome control (nothing is started), a fake fetch (no
// network) and a fake scan.

import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityResponse, AgentState, NotifyEvent, SettingsResponse } from '../../core/src/api/contract';
import type { runScan } from '../../core/src/scan/runner';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';
import type { ChromeControl } from '../openChrome';

const SERP_KEY = 'serp-secret-key-123';
const BOT = '999:bot-secret-token';
/** Local times on Nov 25, 2026 (a Wednesday). */
const at = (h: number, m = 0, s = 0, d = 25) => new Date(2026, 10, d, h, m, s).getTime();

let server: Server;
let agent: Agent;
let base: string;
let clock: number;
let opened: number;
let quit: number;
let chromeRunning: boolean;
let openResult: { ok: true } | { ok: false; why: string };
let telegram: string[];
let notified: NotifyEvent[];
let scans: number;

const chrome: ChromeControl = {
  running: async () => chromeRunning,
  open: async () => {
    opened += 1;
    return openResult;
  },
  quit: async () => {
    quit += 1;
    return true;
  },
};

/** A scan that ends at once: this file is about the schedule around it. */
const quickScan = (async () => {
  scans += 1;
  throw new Error('stop here');
}) as unknown as typeof runScan;

async function start(opts: { now?: number; dataDir?: string } = {}) {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  clock = opts.now ?? at(6);
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.includes('/account.json')) return new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE), { status: 200 });
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
  agent = createAgent({ dataDir: opts.dataDir ?? mkdtempSync(join(tmpdir(), 'sf-selfrun-')), port, timers: false, fetchFn, now: () => clock, work: { runScan: quickScan, chrome } });
  server.on('request', agent.handle);
  vi.spyOn(agent.events, 'publish').mockImplementation(((name: string, data: unknown) => {
    if (name === 'notify') notified.push(data as NotifyEvent);
  }) as never);
}

beforeEach(() => {
  opened = 0;
  quit = 0;
  scans = 0;
  chromeRunning = false;
  openResult = { ok: true };
  telegram = [];
  notified = [];
});

afterEach(async () => {
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', Connection: 'close', ...(init.headers ?? {}) } });
const json = async <T>(path: string, init?: RequestInit) => (await (await ui(path, init)).json()) as T;
const patch = (body: unknown) => ui('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
const settings = async () => (await json<SettingsResponse>('/api/settings')).settings;
const activity = async () => (await json<ActivityResponse>('/api/activity')).runs;
const said = async (re: RegExp) => (await activity()).filter((r) => re.test(r.summary));
/** The scheduler's look at `time`, with the helper connected or not. */
async function tickAt(time: number, helper = false): Promise<boolean> {
  clock = time;
  if (helper) agent.auth.touch('ext');
  await agent.work.selfRun.tick();
  return agent.work.tick();
}

/**
 * A scan started while the helper counts as connected would wait for pages nobody reads here: it is stopped, and what is looked at is
 * that it started (the schedule counts from its start).
 */
async function stopped(): Promise<void> {
  agent.work.stop();
  await agent.work.idle();
}
const ranAt = () => agent.store.get('runtime').lastScheduledRunAt;

/** A daily 7:00 schedule set at 6:00, the SerpApi key in; the scan reads Home Depot pages through Chrome, so it waits for it. */
async function daily() {
  expect((await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: SERP_KEY }) })).status).toBe(200);
  expect((await patch({ settings: { schedule: { mode: 'daily', at: '07:00' } } })).status).toBe(200);
}

describe('opening Chrome for a scheduled scan', () => {
  it('opens it a few minutes before, once, and says so in Activity; the scan waits for the helper', async () => {
    await start();
    await daily();
    expect(await tickAt(at(6, 54))).toBe(false);
    expect(opened).toBe(0);
    expect(await tickAt(at(6, 55))).toBe(false);
    expect(opened).toBe(1);
    expect(await tickAt(at(6, 56))).toBe(false);
    expect(await tickAt(at(6, 58, 30))).toBe(false);
    expect(opened).toBe(1);
    expect(await said(/^Opened Chrome in the background for the 7:00 AM scan/)).toHaveLength(1);
    expect(agent.store.get('runtime').selfRun?.chrome).toMatchObject({ key: expect.stringMatching(/^scan:/), reason: 'scan', result: 'started', weStarted: true });
    // The helper connects: the scan starts, and Activity says how long Chrome took.
    expect(await tickAt(at(6, 59), true)).toBe(false);
    expect(await tickAt(at(7, 0, 10), true)).toBe(true);
    await stopped();
    expect(opened).toBe(1);
    expect(ranAt()).toBe(at(7, 0, 10));
    expect(await said(/^The Split Finder helper connected 4 minutes after Chrome was opened\.$/)).toHaveLength(1);
    const run = (await activity()).find((r) => r.kind === 'scan')!;
    expect(run.summary).not.toMatch(/Chrome did not open|did not connect/);
  });

  it('never when the helper is connected', async () => {
    await start();
    await daily();
    for (const t of [at(6, 55), at(6, 57), at(7, 0, 10)]) await tickAt(t, true);
    await stopped();
    expect(opened).toBe(0);
    expect(ranAt()).toBe(at(7, 0, 10));
    expect(await said(/Opened Chrome/)).toHaveLength(0);
  });

  it('with the setting off, or a manual schedule, it never opens it, and a due scan keeps waiting for Chrome', async () => {
    await start();
    await daily();
    expect((await patch({ scan: { openChrome: false } })).status).toBe(200);
    for (const t of [at(6, 56), at(7), at(7, 30)]) expect(await tickAt(t)).toBe(false);
    expect(opened).toBe(0);
    expect(scans).toBe(0);

    expect((await patch({ scan: { openChrome: true }, settings: { schedule: { mode: 'manual' } } })).status).toBe(200);
    await tickAt(at(7, 40));
    expect(opened).toBe(0);
  });

  it('Chrome opened but the helper never connected: the scan goes on without it and says so once', async () => {
    await start();
    await daily();
    await tickAt(at(6, 55));
    expect(await tickAt(at(6, 59, 30))).toBe(false);
    expect(await tickAt(at(7, 0, 5))).toBe(true);
    await agent.work.idle();
    expect(scans).toBe(1);
    const run = (await activity()).find((r) => r.kind === 'scan')!;
    expect(run.summary.match(/Home Depot pages wait/g)).toHaveLength(1);
    expect(run.summary).toContain('Chrome opened, but the Split Finder helper did not connect, so Home Depot pages wait.');
    expect(run.summary).not.toContain('Chrome is closed');
    expect(opened).toBe(1);
  });

  it('Chrome would not open: the scan goes on at its time, and the sentence is "Chrome did not open, so Home Depot pages wait."', async () => {
    await start();
    await daily();
    openResult = { ok: false, why: 'Google Chrome was not found on this Mac.' };
    expect(await tickAt(at(6, 55))).toBe(false);
    expect(await said(/^Chrome could not be opened for the 7:00 AM scan: Google Chrome was not found on this Mac\.$/)).toHaveLength(1);
    expect(await tickAt(at(6, 59))).toBe(false);
    expect(await tickAt(at(7))).toBe(true);
    await agent.work.idle();
    const run = (await activity()).find((r) => r.kind === 'scan')!;
    expect(run.summary).toContain('Chrome did not open, so Home Depot pages wait.');
    expect(run.summary).not.toContain('Chrome is closed');
    expect(opened).toBe(1);
  });

  it('a scan the owner starts says the usual sentence; only a scheduled one has the app\'s', async () => {
    await start();
    await daily();
    await tickAt(at(6, 55));
    expect((await ui('/api/scan', { method: 'POST' })).status).toBe(200);
    await agent.work.idle();
    const run = (await activity()).find((r) => r.trigger === 'manual')!;
    expect(run.summary).toContain('Chrome is closed, so Home Depot pages wait for the next scan.');
  });

  it('once more for the next scan, not for the one that ran', async () => {
    await start();
    await daily();
    await tickAt(at(6, 55));
    await tickAt(at(7, 0, 5));
    await agent.work.idle();
    expect(opened).toBe(1);
    // Tomorrow's scan is one more try.
    await tickAt(at(6, 56, 0, 26));
    expect(opened).toBe(2);
  });

  it('Home Depot pages that have waited an hour with Chrome closed: opened once that day, between scans', async () => {
    await start({ now: at(8) });
    await daily();
    agent.store.update('runtime', (r) => ({ ...r, hdBacklog: { pages: 40, sets: 20, bundles: 20, at: at(8) } }));
    // The scan's time (tomorrow 7:00) is far: only the pages are a reason.
    await tickAt(at(8, 1));
    expect(opened).toBe(0);
    await tickAt(at(9, 0));
    expect(opened).toBe(0);
    await tickAt(at(9, 2));
    expect(opened).toBe(1);
    await tickAt(at(15));
    expect(opened).toBe(1);
    expect(await said(/^Opened Chrome in the background for the Home Depot pages that wait/)).toHaveLength(1);
  });

  it('closes a Chrome it opened after the scan only when the setting says so, and never one that was already running', async () => {
    await start();
    await daily();
    await patch({ scan: { closeChromeAfter: true } });
    await tickAt(at(6, 55));
    await tickAt(at(6, 59), true);
    await tickAt(at(7, 0, 5), true);
    await stopped();
    expect(quit).toBe(0);
    await tickAt(at(7, 3), true);
    expect(quit).toBe(1);
    await tickAt(at(7, 4), true);
    expect(quit).toBe(1);
    expect(await said(/^Closed the Chrome that Split Finder opened for the scan\.$/)).toHaveLength(1);
  });

  it('a Chrome that was running already is not closed, and with the setting off nothing is', async () => {
    await start();
    await daily();
    await patch({ scan: { closeChromeAfter: true } });
    chromeRunning = true;
    await tickAt(at(6, 55));
    expect(agent.store.get('runtime').selfRun?.chrome).toMatchObject({ result: 'started', weStarted: false });
    await tickAt(at(7, 0, 5), true);
    await stopped();
    await tickAt(at(7, 3), true);
    expect(quit).toBe(0);
  });

  it('closing is off by default', async () => {
    await start();
    await daily();
    await tickAt(at(6, 55));
    await tickAt(at(7, 0, 5), true);
    await stopped();
    await tickAt(at(7, 3), true);
    expect(quit).toBe(0);
  });
});

describe('what the next scan depends on', () => {
  it('the Agent panel says what is missing: Chrome closed, what the app will do, and nothing once it is connected', async () => {
    await start();
    await daily();
    const note = async () => (await json<AgentState>('/api/state')).agent.nextScanNote;
    // Not paired: the helper has never connected.
    expect(await note()).toMatch(/helper, which is not connected yet/);
    agent.store.update('pairing', (p) => ({ ...p, extensions: [{ extensionId: 'ext', pairedAt: new Date(clock).toISOString(), lastSeenAt: null } as never] }));
    expect(await note()).toMatch(/^Needs Chrome, which is closed\. Split Finder opens it a few minutes before the scan/);
    await patch({ scan: { openChrome: false } });
    expect(await note()).toMatch(/the scan waits until you open it\. Turn on Open Chrome for scheduled scans in Settings, Scanning/);
    agent.auth.touch('ext');
    expect(await note()).toBeUndefined();
    await patch({ settings: { schedule: { mode: 'manual' } } });
    clock += 5 * 60_000;
    expect(await note()).toBeUndefined();
  });
});

describe('Open at login for a schedule', () => {
  it('manual schedule: untouched. A schedule: turned on once, in Activity and as a quiet notice', async () => {
    await start();
    await agent.work.selfRun.tick();
    expect((await settings()).shell.launchAtLogin).toBe(false);
    expect((await json<AgentState>('/api/state')).loginNotice).toBeUndefined();

    await daily();
    const before = (await json<AgentState>('/api/state')).settingsAt;
    clock += 1000;
    await agent.work.selfRun.tick();
    expect((await settings()).shell.launchAtLogin).toBe(true);
    const state = await json<AgentState>('/api/state');
    expect(state.loginNotice?.sentence).toMatch(/opens when you log in/);
    // The shell re-reads the settings when settingsAt moves.
    expect(state.settingsAt).not.toBe(before);
    expect(await said(/^Open at login is on, because you set a schedule/)).toHaveLength(1);
  });

  it('turned off by him, it stays off, however many ticks and whatever the schedule becomes', async () => {
    await start();
    await daily();
    await agent.work.selfRun.tick();
    expect((await patch({ shell: { launchAtLogin: false } })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      clock += 30_000;
      await agent.work.selfRun.tick();
    }
    expect((await settings()).shell.launchAtLogin).toBe(false);
    await patch({ settings: { schedule: { mode: 'interval', hours: 6 } } });
    await agent.work.selfRun.tick();
    expect((await settings()).shell.launchAtLogin).toBe(false);
    expect(await said(/^Open at login is on/)).toHaveLength(1);
  });

  it('"Turn off" on the notice turns it off and closes the notice; OK only closes it', async () => {
    await start();
    await daily();
    await agent.work.selfRun.tick();
    expect((await ui('/api/self-run/login-notice', { method: 'POST', body: JSON.stringify({}) })).status).toBe(200);
    expect((await json<AgentState>('/api/state')).loginNotice).toBeUndefined();
    expect((await settings()).shell.launchAtLogin).toBe(true);

    await patch({ shell: { launchAtLogin: true } });
    agent.store.update('runtime', (r) => ({ ...r, selfRun: { ...r.selfRun, loginNotice: true } }));
    expect((await ui('/api/self-run/login-notice', { method: 'POST', body: JSON.stringify({ turnOff: true }) })).status).toBe(200);
    expect((await settings()).shell.launchAtLogin).toBe(false);
    expect((await json<AgentState>('/api/state')).loginNotice).toBeUndefined();
    await agent.work.selfRun.tick();
    expect((await settings()).shell.launchAtLogin).toBe(false);
  });

  it('already on when the schedule is set: nothing is said', async () => {
    await start();
    await patch({ shell: { launchAtLogin: true } });
    await daily();
    await agent.work.selfRun.tick();
    expect((await json<AgentState>('/api/state')).loginNotice).toBeUndefined();
    expect(await said(/^Open at login/)).toHaveLength(0);
    // And turning it off later is respected.
    await patch({ shell: { launchAtLogin: false } });
    await agent.work.selfRun.tick();
    expect((await settings()).shell.launchAtLogin).toBe(false);
  });
});

describe('a scan that ran late', () => {
  async function lateScan() {
    await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: SERP_KEY }) });
    await patch({ settings: { schedule: { mode: 'daily', at: '07:00' } }, scan: { serpWhenChromeClosed: true, openChrome: false } });
  }
  const summary = async () => (await activity()).find((r) => r.kind === 'scan')!.summary;

  it('the computer was asleep across 7:00: the summary says what was due, when it ran and why', async () => {
    await start({ now: at(5, 59) });
    await lateScan();
    await agent.work.tick();
    clock = at(6, 59, 40);
    await agent.work.tick();
    // Asleep: no tick until 9:12.
    clock = at(9, 12);
    expect(agent.work.tick()).toBe(true);
    await agent.work.idle();
    expect(await summary()).toMatch(/^The 7:00 AM scan ran at 9:12 AM because the computer was asleep\./);
  });

  it('the app was closed at 7:00: it says so', async () => {
    // The agent starts at 9:10; the last scheduled scan was yesterday's.
    await start({ now: at(9, 10) });
    await lateScan();
    agent.store.update('runtime', (r) => ({ ...r, lastScheduledRunAt: at(7, 0, 0, 24), scheduleFrom: null }));
    clock = at(9, 12);
    expect(agent.work.tick()).toBe(true);
    await agent.work.idle();
    expect(await summary()).toMatch(/^The 7:00 AM scan ran at 9:12 AM because Split Finder was not running at 7:00 AM\./);
  });

  it('on time: no sentence', async () => {
    await start({ now: at(5, 59) });
    await lateScan();
    await agent.work.tick();
    clock = at(7, 0, 20);
    expect(agent.work.tick()).toBe(true);
    await agent.work.idle();
    expect(await summary()).not.toMatch(/The 7:00 AM scan ran/);
  });
});

describe('the weekly message', () => {
  // The owner's real stores after scan 5 (Nov 23, 5:23 PM). The weekly time is Tuesday 8:00, so the week holds that scan.
  const D = (month: number, day: number, h = 8, m = 0, sec = 0) => new Date(2026, month - 1, day, h, m, sec).getTime();
  const dir = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6', 'store');
  const deals = JSON.parse(readFileSync(join(dir, 'deals.json'), 'utf8')) as { bundles: never[] };
  const tracking = JSON.parse(readFileSync(join(dir, 'tracking.json'), 'utf8'));
  const weeklies = () => notified.filter((n) => n.kind === 'weekly');

  async function withStores() {
    await start({ now: D(11, 20, 10) });
    agent.store.update('deals', (d) => ({ ...d, bundles: deals.bundles }));
    agent.store.update('tracking', () => tracking);
    expect((await ui('/api/keys/telegram', { method: 'PUT', body: JSON.stringify({ botToken: BOT, chatId: '42' }) })).status).toBe(200);
    expect((await patch({ notifications: { weekly: { day: 2, at: '08:00' } } })).status).toBe(200);
  }

  it('the first look sends nothing; the next Tuesday at 8:00 sends one, short as a notification and in full on Telegram, never twice', async () => {
    await withStores();
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(0);
    expect(telegram).toHaveLength(0);

    clock = D(11, 24, 7, 59, 30);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(0);

    clock = D(11, 24, 8, 0, 30);
    await agent.work.selfRun.tick();
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(1);
    expect(weeklies()[0]).toMatchObject({ kind: 'weekly', title: 'Split Finder', route: '/today' });
    expect(weeklies()[0]!.body).toMatch(/^Your week: 36 new deals, 3 announced as worth buying now\. No purchases recorded\./);
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('Split Finder, your week: Nov 20 to Nov 24');
    expect(telegram[0]).toContain('- 36 new deals found (every part priced).');
    expect(telegram[0]).toContain('- No purchases recorded this week.');
    expect(telegram[0]).not.toContain(BOT);

    // Later that day, and every day to the next Tuesday: not again. That Tuesday: once more.
    for (const t of [D(11, 24, 9), D(11, 24, 23, 59), D(11, 25), D(11, 30), D(12, 1, 7, 59)]) {
      clock = t;
      await agent.work.selfRun.tick();
    }
    expect(weeklies()).toHaveLength(1);
    clock = D(12, 1, 8, 1);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(2);
    expect(telegram).toHaveLength(2);
    expect(telegram[1]).toContain('Split Finder, your week: Nov 24 to Dec 1');
    expect(telegram[1]).toContain('- No new deals found.');
  });

  it('across a restart: what was sent is in the store, so the same Tuesday is not sent again', async () => {
    await withStores();
    await agent.work.selfRun.tick();
    clock = D(11, 24, 8, 5);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(1);
    expect(agent.store.get('runtime').selfRun?.weekly).toMatchObject({ key: '2026-11-24' });
    // A restarted agent builds its scheduler from the store: the same record, the same Tuesday.
    const { SelfRun } = await import('../selfRun');
    let again = 0;
    const restarted = new SelfRun({
      store: agent.store, now: () => clock + 3_600_000, helperConnected: () => false, nextScanAt: () => null, busy: () => false, jobsWaiting: () => 0, hdPausedUntil: () => null,
      record: () => {}, changed: () => {}, costs: agent.work.costs, announceWeekly: async () => { again += 1; },
    });
    await restarted.tick();
    expect(again).toBe(0);
  });

  it('the Weekly summary kind switched off: nothing is sent, and turning it on later does not send an old week', async () => {
    await withStores();
    await agent.work.selfRun.tick();
    expect((await patch({ notifications: { kinds: { weekly: false } } })).status).toBe(200);
    clock = D(11, 24, 8, 0, 30);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(0);
    expect(telegram).toHaveLength(0);
    expect((await patch({ notifications: { kinds: { weekly: true } } })).status).toBe(200);
    clock = D(11, 24, 12);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(0);
  });

  it('the day and time are the owner\'s setting, and a value that is not one is refused', async () => {
    await withStores();
    expect((await patch({ notifications: { weekly: { day: 5, at: '17:30' } } })).status).toBe(200);
    expect((await settings()).notifications.weekly).toEqual({ day: 5, at: '17:30' });
    await agent.work.selfRun.tick();
    clock = D(11, 20, 17, 29);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(0);
    clock = D(11, 20, 17, 31);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(1);
    expect((await patch({ notifications: { weekly: { day: 7 } } })).status).toBe(400);
    expect((await patch({ notifications: { weekly: { at: '5pm' } } })).status).toBe(400);
  });

  it('quiet hours hold the notification, as for every kind; Telegram is not held', async () => {
    await withStores();
    await patch({ notifications: { quietHours: { enabled: true, from: '07:00', to: '09:00' } } });
    await agent.work.selfRun.tick();
    clock = D(11, 24, 8, 0, 30);
    await agent.work.selfRun.tick();
    expect(weeklies()).toHaveLength(0);
    expect(telegram).toHaveLength(1);
  });
});
