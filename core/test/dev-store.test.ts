// The Node-side store that development scripts use to track paid searches.
// These tests touch the file system in a temp folder only. No network.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireSpendLock, appendLedger, mainCheckout, SpendLockError, spentThisMonth, stateRoot } from '../../scripts/node-store';

let dir: string;
const saved = process.env.SERPAPI_STATE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bsf-store-'));
});
afterEach(() => {
  if (saved === undefined) delete process.env.SERPAPI_STATE_DIR;
  else process.env.SERPAPI_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('one ledger across git worktrees', () => {
  it('treats a normal checkout as its own state folder', () => {
    delete process.env.SERPAPI_STATE_DIR;
    mkdirSync(join(dir, '.git'));
    expect(mainCheckout(dir)).toBeUndefined();
    expect(stateRoot(dir)).toBe(dir);
  });

  it('sends a linked worktree back to the main checkout', () => {
    delete process.env.SERPAPI_STATE_DIR;
    const main = join(dir, 'main');
    const tree = join(dir, 'trees', 'side-panel');
    mkdirSync(join(main, '.git', 'worktrees', 'side-panel'), { recursive: true });
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'side-panel')}\n`);
    expect(mainCheckout(tree)).toBe(main);
    expect(stateRoot(tree)).toBe(main);
  });

  it('does not mistake a submodule for a worktree', () => {
    delete process.env.SERPAPI_STATE_DIR;
    writeFileSync(join(dir, '.git'), 'gitdir: ../.git/modules/thing\n');
    expect(mainCheckout(dir)).toBeUndefined();
  });

  it('counts this month by bucket from the shared ledger', () => {
    process.env.SERPAPI_STATE_DIR = dir;
    const now = new Date('2026-11-09T12:00:00Z');
    const entry = (at: string, label: string) => ({ at, label, engine: 'amazon', key: `engine=amazon&k=${label}` });
    appendLedger(entry('2026-11-09T10:00:00.000Z', 'fixtures:hd-search'));
    appendLedger(entry('2026-11-09T10:01:00.000Z', 'fixtures:amazon-search'));
    appendLedger(entry('2026-11-09T10:02:00.000Z', 'demo:amazon-search'));
    appendLedger(entry('2026-10-30T10:00:00.000Z', 'fixtures:old'));
    expect(spentThisMonth(now)).toEqual({ fixtures: 2, demo: 1 });
  });
});

describe('one spender at a time', () => {
  it('refuses a second spender while the first is alive', () => {
    process.env.SERPAPI_STATE_DIR = dir;
    // Our parent process is alive and is not us: it stands in for another agent.
    writeFileSync(join(dir, '.serpapi.lock'), JSON.stringify({ pid: process.ppid, owner: 'demo', at: '2026-11-09T10:00:00.000Z' }));
    expect(() => acquireSpendLock('fixtures')).toThrow(SpendLockError);
    expect(existsSync(join(dir, '.serpapi.lock'))).toBe(true); // the other agent keeps its lock
  });

  it('takes over a lock whose holder has died', () => {
    process.env.SERPAPI_STATE_DIR = dir;
    const dead = spawnSync(process.execPath, ['-e', '']).pid; // ran and exited
    writeFileSync(join(dir, '.serpapi.lock'), JSON.stringify({ pid: dead, owner: 'crashed', at: '2026-11-09T10:00:00.000Z' }));
    const release = acquireSpendLock('fixtures');
    release();
    expect(existsSync(join(dir, '.serpapi.lock'))).toBe(false);
  });

  it('lets the same process ask twice, and frees the lock on release', () => {
    process.env.SERPAPI_STATE_DIR = dir;
    const first = acquireSpendLock('live');
    const second = acquireSpendLock('live');
    expect(existsSync(join(dir, '.serpapi.lock'))).toBe(true);
    second();
    first();
    expect(existsSync(join(dir, '.serpapi.lock'))).toBe(false);
  });
});
