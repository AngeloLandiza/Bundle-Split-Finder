// Keep the computer awake while a scan runs: the command each system gets (checked as text, nothing is spawned), the hold's
// life with a fake spawner, and the agent holding it only while a scan runs and only when the setting says so.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { runScan } from '../../core/src/scan/runner';
import type { ScanJob } from '../../core/src/scan/types';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';
import { KeepAwake, keepAwakeCommand, type ChildLike, type Spawner } from '../keepAwake';

/** A child that records being killed and can fail or exit on cue. */
class FakeChild implements ChildLike {
  killed = 0;
  private handlers: Record<string, ((...a: never[]) => void)[]> = {};
  kill(): boolean {
    this.killed += 1;
    return true;
  }
  on(event: 'error' | 'exit', fn: (...a: never[]) => void): this {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  emit(event: 'error' | 'exit', arg?: unknown): void {
    for (const fn of this.handlers[event] ?? []) fn(arg as never);
  }
  unref(): void {}
}

function fakeSpawner() {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const children: FakeChild[] = [];
  const spawn: Spawner = (command, args, options) => {
    calls.push({ command, args, options });
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  return { spawn, calls, children };
}

describe('keepAwakeCommand', () => {
  it('macOS: caffeinate -i (no idle sleep) tied to the agent’s pid with -w', () => {
    expect(keepAwakeCommand('darwin', 4321)).toEqual({ command: 'caffeinate', args: ['-i', '-w', '4321'] });
  });

  it('Windows: hidden PowerShell, an encoded script that sets ES_CONTINUOUS | ES_SYSTEM_REQUIRED and waits for the pid', () => {
    const c = keepAwakeCommand('win32', 4321)!;
    expect(c.command).toBe('powershell.exe');
    expect(c.args.slice(0, 6)).toEqual(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass']);
    expect(c.args[6]).toBe('-EncodedCommand');
    const script = Buffer.from(c.args[7]!, 'base64').toString('utf16le');
    expect(script).toContain('SetThreadExecutionState');
    // 0x80000001 = ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1); never ES_DISPLAY_REQUIRED (0x2).
    expect(script).toContain('[uint32]2147483649');
    expect(0x80000000 + 0x1).toBe(2147483649);
    expect(script).toContain('Wait-Process -Id 4321');
    expect(c.args).toHaveLength(8);
  });

  it('other systems, and a pid that is not one: nothing', () => {
    expect(keepAwakeCommand('linux', 4321)).toBeNull();
    expect(keepAwakeCommand('darwin', 0)).toBeNull();
    expect(keepAwakeCommand('win32', Number.NaN)).toBeNull();
  });
});

describe('KeepAwake', () => {
  it('starts one child on the first hold, kills it on the last release, and a release twice does nothing more', () => {
    const f = fakeSpawner();
    const k = new KeepAwake({ platform: 'darwin', pid: 7, spawn: f.spawn });
    expect(k.active).toBe(false);
    const a = k.hold();
    const b = k.hold();
    expect(f.calls).toEqual([{ command: 'caffeinate', args: ['-i', '-w', '7'], options: { stdio: 'ignore', windowsHide: true } }]);
    expect(k.active).toBe(true);
    a();
    a();
    expect(f.children[0]!.killed).toBe(0);
    b();
    expect(f.children[0]!.killed).toBe(1);
    expect(k.active).toBe(false);
    // The next hold is a new child.
    k.hold()();
    expect(f.calls).toHaveLength(2);
  });

  it('holds nothing where there is no command', () => {
    const f = fakeSpawner();
    const k = new KeepAwake({ platform: 'linux', pid: 7, spawn: f.spawn });
    k.hold()();
    expect(f.calls).toEqual([]);
    expect(k.active).toBe(false);
  });

  it('a helper that cannot start is said once and never throws into the scan', () => {
    const said: string[] = [];
    const k = new KeepAwake({
      platform: 'darwin',
      pid: 7,
      spawn: () => {
        throw new Error('spawn caffeinate ENOENT');
      },
      warn: (m) => said.push(m),
    });
    expect(() => k.hold()()).not.toThrow();
    expect(() => k.hold()()).not.toThrow();
    expect(said).toEqual(['Keeping the computer awake during a scan is not available here (caffeinate did not start).']);
    expect(k.active).toBe(false);
  });

  it('a helper that fails after it started, or exits by itself, is let go', () => {
    const f = fakeSpawner();
    const said: string[] = [];
    const k = new KeepAwake({ platform: 'win32', pid: 7, spawn: f.spawn, warn: (m) => said.push(m) });
    const release = k.hold();
    f.children[0]!.emit('error', new Error('blocked'));
    expect(k.active).toBe(false);
    expect(said).toHaveLength(1);
    release();
    expect(f.children[0]!.killed).toBe(0);
  });
});

describe('the agent holds the computer awake only while a scan runs', () => {
  let agent: Agent;
  afterEach(async () => {
    await agent.work.idle();
    agent.close();
  });

  /** A fake scan that waits for the test to let it finish. */
  function setup(opts: { keepAwake?: boolean } = {}) {
    let gate!: () => void;
    const open = new Promise<void>((r) => (gate = r));
    const holds: { held: boolean }[] = [];
    const hold = () => {
      const h = { held: true };
      holds.push(h);
      return () => {
        h.held = false;
      };
    };
    const fakeScan = (async () => {
      await open;
      return { id: '1', startedAt: 1, finishedAt: 1, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', queue: [], deferred: [], searchesUsed: 0, keepaTokensUsed: 0, counts: {} } as unknown as ScanJob;
    }) as unknown as typeof runScan;
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.includes('/account.json')) return new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE), { status: 200 });
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    agent = createAgent({
      dataDir: mkdtempSync(join(tmpdir(), 'sf-awake-')), port: 0, timers: false, fetchFn, now: () => Date.UTC(2026, 10, 23, 9),
      work: { runScan: fakeScan, ...(opts.keepAwake === false ? {} : { keepAwake: { hold } }) },
    });
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-key-123' }));
    return { holds, gate };
  }

  it('Scan now holds it until the scan ends', async () => {
    const { holds, gate } = setup();
    agent.work.scanNow();
    expect(holds.map((h) => h.held)).toEqual([true]);
    gate();
    await agent.work.idle();
    expect(holds.map((h) => h.held)).toEqual([false]);
  });

  it('is released when the scan fails', async () => {
    const { holds } = setup();
    agent.store.update('keys', (k) => ({ ...k, serpapi: undefined }));
    agent.work.scanNow();
    await agent.work.idle();
    expect(holds.map((h) => h.held)).toEqual([false]);
  });

  it('holds nothing when the owner turned it off, and a store from before the setting holds it', async () => {
    const { holds, gate } = setup();
    agent.store.update('settings', (s) => ({ ...s, shell: { ...s.shell, keepAwakeDuringScan: false } }));
    agent.work.scanNow();
    gate();
    await agent.work.idle();
    expect(holds).toEqual([]);
  });

  it('a fresh store has the setting on', () => {
    setup({ keepAwake: false });
    expect(agent.store.get('settings').shell.keepAwakeDuringScan).toBe(true);
  });

  it('a store saved before the setting existed reads it as on', () => {
    setup({ keepAwake: false });
    const { keepAwakeDuringScan: _gone, ...old } = agent.store.get('settings').shell;
    agent.store.update('settings', (s) => ({ ...s, shell: old as typeof s.shell }));
    // The scan's check is "not false": a missing value holds.
    expect((agent.store.get('settings').shell as { keepAwakeDuringScan?: boolean }).keepAwakeDuringScan !== false).toBe(true);
  });
});
