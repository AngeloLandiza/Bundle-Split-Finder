// Nov 25, supervision: the agent dies cleanly and says why; one job's failure is an Activity error and the agent lives;
// the agent the shell starts again writes one line about it. The scan job and the run are the owner's real ones from
// Nov 23 (fixtures/e2e-2026-11-23), set back to "running" as an agent that died mid-scan leaves them. No network.

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '../../core/src/api/contract';
import type { ScanJob } from '../../core/src/scan/types';
import { createAgent, type Agent } from '../app';
import { CRASH_EXIT_CODE, CRASH_FILE, clockTime, installCrashHandlers, readCrashes, restartFromEnv, restartNotifies, restartSentence, scrubCrashText, writeCrashRecord } from '../crash';
import { EventHub } from '../events';
import { FileScanStore } from '../scanStore';
import { Store } from '../store';
import { TICK_MS } from '../work';

const SERP = 'serp-secret-0123456789abcdef0123456789abcdef';
const BOT = '999:bot-secret-token';
const T0 = Date.parse('2026-11-23T15:12:30.000Z');

const RUNS = (JSON.parse(readFileSync('fixtures/e2e-2026-11-23/store/activity.json', 'utf8')) as { runs: RunRecord[] }).runs;
const JOBS = JSON.parse(readFileSync('fixtures/e2e-2026-11-23/scan/scans.json', 'utf8')) as [string, ScanJob][];

const agents: Agent[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (agents.length) {
    const a = agents.pop()!;
    await a.work.idle();
    a.close();
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sf-crash-'));
}

function start(dataDir: string, extra: Partial<Parameters<typeof createAgent>[0]> = {}, fetched: string[] = []): Agent {
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
    if (url.hostname === 'api.telegram.org') {
      fetched.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  const agent = createAgent({ dataDir, port: 0, timers: false, fetchFn, now: () => T0, appVersion: null, shippedHelperVersion: null, ...extra });
  agents.push(agent);
  return agent;
}

describe('a job that fails is an Activity error, and the agent lives', () => {
  it('the scheduler tick throwing, a drip round rejecting and the held messages failing: one error each, scrubbed, not repeated', async () => {
    const agent = start(tempDir());
    agent.store.update('keys', (k) => ({ ...k, serpapi: SERP }));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const tick = vi.spyOn(agent.work, 'tick').mockImplementation(() => {
      throw new TypeError(`Cannot read the schedule with ${SERP}`);
    });
    vi.spyOn(agent.work, 'flushMessages').mockRejectedValue(new Error('disk full'));
    agent.work.start();
    vi.advanceTimersByTime(TICK_MS);
    await vi.waitFor(() => expect(agent.store.get('activity').errors).toHaveLength(2));
    // The same failure on the next tick is not a second line.
    vi.advanceTimersByTime(TICK_MS);
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(2);
    const sentences = (agent.store.get('activity').errors ?? []).map((e) => e.sentence);
    expect(sentences).toEqual(['The scheduler failed: Cannot read the schedule with [key]', 'Sending the held messages failed: disk full']);
    expect(sentences.join(' ')).not.toContain(SERP);

    // The drip, between scans: its round's rejection is caught where the tick starts it.
    tick.mockRestore();
    vi.spyOn(agent.work, 'drip').mockRejectedValue(new Error('the scan store could not be read'));
    expect(agent.work.tick()).toBe(false);
    await vi.waitFor(() => expect(agent.store.get('activity').errors).toHaveLength(3));
    expect(agent.store.get('activity').errors![2]!.sentence).toBe('A background lookup failed: the scan store could not be read');
    agent.work.close();
  });

  it('a request whose handler throws before it starts is a 500 for that request, not the end of the agent', () => {
    const agent = start(tempDir());
    vi.spyOn(agent.auth, 'hostAllowed').mockImplementation(() => {
      throw new Error('boom');
    });
    const sent: { status?: number; body?: string } = {};
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader: () => undefined,
      end: (body?: string) => {
        sent.status = res.statusCode;
        sent.body = body;
      },
      destroy: () => undefined,
    };
    const req = { method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:8790' }, resume: () => undefined };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => agent.handle(req as never, res as never)).not.toThrow();
    expect(sent.status).toBe(500);
    expect(sent.body).toContain('Something went wrong in the agent.');
  });
});

describe('the truly unexpected: a crash line, release, exit non-zero', () => {
  it('an unhandled rejection: one scrubbed line (no key, no token), release, then exit 70; a second error changes nothing', () => {
    const dir = tempDir();
    const proc = new EventEmitter();
    const order: string[] = [];
    installCrashHandlers(proc as never, {
      dataDir: dir,
      secrets: () => [SERP, 'ui-token-abcdef'],
      step: () => 'scan: Reading Home Depot pages',
      release: () => order.push('release'),
      exit: (code) => order.push(`exit ${code}`),
      now: () => T0,
    });
    proc.emit('unhandledRejection', new RangeError(`Invalid time value for ${SERP} and ui-token-abcdef\n    at Object.<anonymous> (/Users/someone/agent/work.ts:12:3)`));
    proc.emit('uncaughtException', new Error('while dying'));
    expect(order).toEqual(['release', `exit ${CRASH_EXIT_CODE}`]);
    const lines = readFileSync(join(dir, CRASH_FILE), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SERP);
    expect(lines[0]).not.toContain('ui-token-abcdef');
    expect(lines[0]).not.toContain('/Users/someone');
    expect(readCrashes(dir)).toEqual([
      { at: '2026-11-23T15:12:30.000Z', kind: 'unhandledRejection', name: 'RangeError', message: 'Invalid time value for [key] and [key]', step: 'scan: Reading Home Depot pages' },
    ]);
  });

  it('masks what looks like a key even when the store never held it (a parse error quoting a file)', () => {
    expect(scrubCrashText('Unexpected token in JSON: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"', [])).toBe('Unexpected token in JSON: "[hidden]"');
    expect(scrubCrashText('a word '.repeat(60), [], 200)).toHaveLength(200);
  });

  it('a real agent process: an unhandled rejection writes the crash line, releases the store lock and exits 70', () => {
    const dir = tempDir();
    const code = `
      const { createAgent } = await import(${JSON.stringify(resolve('agent/app.ts'))});
      const { installCrashHandlers } = await import(${JSON.stringify(resolve('agent/crash.ts'))});
      const agent = createAgent({ dataDir: ${JSON.stringify(dir)}, port: 0, timers: false, appVersion: null, shippedHelperVersion: null });
      agent.store.update('keys', (k) => ({ ...k, serpapi: ${JSON.stringify(SERP)} }));
      installCrashHandlers(process, { dataDir: ${JSON.stringify(dir)}, secrets: () => agent.secrets(), step: () => agent.step(), release: () => agent.close(), exit: (c) => process.exit(c) });
      setTimeout(() => {}, 5000);
      Promise.reject(new Error('lost the key ' + ${JSON.stringify(SERP)} + ' and the token ' + agent.auth.uiToken));
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000 });
    expect(child.status).toBe(CRASH_EXIT_CODE);
    const token = readFileSync(join(dir, 'agent-token'), 'utf8').trim();
    const text = readFileSync(join(dir, CRASH_FILE), 'utf8');
    expect(text).not.toContain(SERP);
    expect(text).not.toContain(token);
    expect(readCrashes(dir)[0]).toMatchObject({ kind: 'unhandledRejection', name: 'Error', message: 'lost the key [key] and the token [key]', step: null });
    expect(existsSync(join(dir, 'store', 'store.lock'))).toBe(false);
  });
});

describe('the agent the shell starts again', () => {
  /** The data folder an agent that died mid-scan leaves: the run and the scan job still "running", and its crash line. */
  async function diedMidScan(trigger: 'scheduled' | 'manual', crashed = true): Promise<string> {
    const dir = tempDir();
    const store = Store.open(dir);
    const run = RUNS.find((r) => r.id === 'run-1795426927490')!;
    store.update('activity', (a) => ({ ...a, runs: [...RUNS.filter((r) => r !== run), { ...run, status: 'running', finishedAt: null, trigger, summary: 'Scanning.' }] }));
    store.update('keys', (k) => ({ ...k, serpapi: SERP, telegram: { botToken: BOT, chatId: '42' } }));
    store.close();
    const [, job] = JOBS[1]!;
    await new FileScanStore(join(dir, 'scan')).putScan({ ...job, status: 'running', finishedAt: null, stopReason: null });
    if (crashed) writeCrashRecord(dir, { at: new Date(T0 - 20_000).toISOString(), kind: 'uncaughtException', name: 'TypeError', message: "Cannot read properties of undefined (reading 'price')", step: 'scan: Reading Home Depot pages' });
    return dir;
  }

  it('reads the shell’s restart count and when the last agent died', () => {
    expect(restartFromEnv({})).toBeNull();
    expect(restartFromEnv({ SPLIT_FINDER_RESTART: '2', SPLIT_FINDER_STOPPED_AT: String(T0) })).toEqual({ attempt: 2, stoppedAt: T0 });
    expect(restartFromEnv({ SPLIT_FINDER_RESTART: 'x' })).toBeNull();
  });

  it('a manual scan cut off: the run is closed as stopped, one Activity line with Scan again, no message', async () => {
    const dir = await diedMidScan('manual');
    const sent: string[] = [];
    const agent = start(dir, { restart: { attempt: 1, stoppedAt: T0 - 19_000 } }, sent);
    await agent.restartNoted;
    const run = agent.store.get('activity').runs.find((r) => r.id === 'run-1795426927490')!;
    expect(run).toMatchObject({ status: 'stopped', error: 'The agent stopped while this ran.', finishedAt: new Date(T0).toISOString() });
    const errors = agent.store.get('activity').errors ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.retry).toMatchObject({ kind: 'scan', label: 'Scan again' });
    expect(errors[0]!.sentence).toBe(
      `Split Finder's background agent stopped unexpectedly at ${clockTime(T0 - 20_000)} and was restarted. Nothing saved was lost. ` +
        'The scan that was running stopped at its last saved step: Scan again continues it from there. ' +
        "What stopped it: TypeError: Cannot read properties of undefined (reading 'price') during scan: Reading Home Depot pages.",
    );
    expect(sent).toEqual([]);
    // The saved job is untouched, so the next scan continues it (core runner: an interrupted job is continued as saved).
    expect((await agent.work.scanStore.listScans())[0]).toMatchObject({ id: JOBS[1]![0], status: 'running' });
  });

  it('a scheduled scan cut off: also a notification (held until the shell reconnects) and a Telegram message', async () => {
    const dir = await diedMidScan('scheduled');
    const sent: string[] = [];
    const agent = start(dir, { restart: { attempt: 1, stoppedAt: T0 - 19_000 } }, sent);
    await agent.restartNoted;
    const sentence = agent.store.get('activity').errors![0]!.sentence;
    expect(sentence).toContain('The scheduled scan that was running stopped at its last saved step: Scan again continues it from there, or the next scheduled scan will.');
    expect(sent).toEqual([sentence]);
    // No shell listened when it was published; the shell's stream gets it when it attaches, and a page's stream does not.
    const page = fakeStream();
    agent.events.attach(page.res, undefined);
    const shell = fakeStream();
    agent.events.attach(shell.res, undefined, { shell: true });
    expect(page.text()).not.toContain('event: notify');
    expect(shell.text()).toContain('event: notify');
    expect(shell.text()).toContain('"kind":"error"');
  });

  it('a restart with no scan running and no crash line (a hard stop): the short line, no retry; the second restart in the window is a message', async () => {
    const dir = tempDir();
    Store.open(dir).close();
    const sent: string[] = [];
    const first = start(dir, { restart: { attempt: 2, stoppedAt: T0 - 5_000 } }, sent);
    await first.restartNoted;
    const e = first.store.get('activity').errors![0]!;
    expect(e.sentence).toBe(`Split Finder's background agent stopped unexpectedly at ${clockTime(T0 - 5_000)} and was restarted (2 times in the last 10 minutes). Nothing saved was lost.`);
    expect(e.retry).toBeNull();
    // Telegram has no key here; the notification still goes.
    expect(sent).toEqual([]);
  });

  it('who hears of it: a scheduled scan, or the first repeat; and a normal start writes no line', async () => {
    expect(restartNotifies(1, null)).toBe(false);
    expect(restartNotifies(1, { trigger: 'manual', continues: true })).toBe(false);
    expect(restartNotifies(1, { trigger: 'scheduled', continues: true })).toBe(true);
    expect(restartNotifies(2, null)).toBe(true);
    expect(restartNotifies(3, null)).toBe(false);
    expect(restartSentence({ at: T0, attempt: 1, crash: null, interrupted: { trigger: 'manual', continues: false } })).toContain(
      'The scan that was running had saved its searches and page reads; Scan again builds the deals from them.',
    );
    const dir = await diedMidScan('manual', false);
    const agent = start(dir);
    expect(agent.store.get('activity').errors ?? []).toEqual([]);
    // Even without a restart, a run the last agent left as running is closed: nothing runs when an agent starts.
    expect(agent.store.get('activity').runs.find((r) => r.id === 'run-1795426927490')!.status).toBe('stopped');
  });
});

describe('the event hub holds notify events for the shell', () => {
  it('keeps at most five, none older than ten minutes, and hands them to the next shell stream only', () => {
    let now = T0;
    const hub = new EventHub(() => now);
    for (let i = 0; i < 7; i++) hub.publish('notify', { id: `n${i}`, kind: 'error', title: 'Split Finder', body: `b${i}` });
    const shell = fakeStream();
    hub.attach(shell.res, undefined, { shell: true });
    expect(shell.text().match(/event: notify/g)).toHaveLength(5);
    expect(shell.text()).toContain('"body":"b6"');
    expect(shell.text()).not.toContain('"body":"b1"');
    shell.close();
    hub.publish('notify', { id: 'old', kind: 'error', title: 'Split Finder', body: 'old' });
    now += 11 * 60_000;
    const again = fakeStream();
    hub.attach(again.res, undefined, { shell: true });
    expect(again.text()).not.toContain('event: notify');
    hub.close();
  });
});

function fakeStream(): { res: ServerResponse; text: () => string; close: () => void } {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    writeHead: () => res,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    end: () => undefined,
  });
  return { res: res as unknown as ServerResponse, text: () => chunks.join(''), close: () => emitter.emit('close') };
}
