// Node-side storage for scripts and live tests: a file cache, an append-only ledger,
// and a lock that lets only one process spend searches at a time.
// (The extension uses IndexedDB behind the same Cache interface.)
//
// The key, the cache, the ledger and the lock live in ONE place even when the repo is
// checked out several times as git worktrees (subagents often work in worktrees).
// Otherwise each worktree would start with an empty ledger and an empty cache, and the
// monthly caps would stop meaning anything.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Cache, CacheEntry, LedgerEntry } from '../core/src/serpapi/client';

/** This checkout. Recorded fixtures are written here, because they belong to the branch. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The main checkout, if `dir` is a linked git worktree; otherwise undefined.
 * A linked worktree has a `.git` FILE that reads "gitdir: <main>/.git/worktrees/<name>".
 */
export function mainCheckout(dir: string): string | undefined {
  const dotGit = join(dir, '.git');
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return undefined;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!m) return undefined;
  const gitDir = resolve(dir, m[1]!.trim());
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const at = gitDir.lastIndexOf(marker);
  return at === -1 ? undefined : gitDir.slice(0, at);
}

/** Where the key, cache, ledger and lock live: SERPAPI_STATE_DIR, else the main checkout. */
export function stateRoot(checkout: string = ROOT): string {
  const override = process.env.SERPAPI_STATE_DIR;
  if (override) return resolve(override);
  return mainCheckout(checkout) ?? checkout;
}

const cacheDir = () => join(stateRoot(), 'cache');
const ledgerFile = () => join(stateRoot(), '.serpapi-ledger.jsonl');
const lockFile = () => join(stateRoot(), '.serpapi.lock');

/** Load KEY=value lines from .env into process.env (existing variables win). */
export function loadEnv(): void {
  const file = join(stateRoot(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]!] === undefined) {
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

export class FileCache implements Cache {
  private path(key: string): string {
    const engine = /engine=([a-z_]+)/.exec(key)?.[1] ?? 'other';
    return join(cacheDir(), engine, `${createHash('sha1').update(key).digest('hex')}.json`);
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    const file = this.path(key);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as CacheEntry) : undefined;
  }
  async set(key: string, entry: CacheEntry): Promise<void> {
    const file = this.path(key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ key, ...entry }, null, 2));
  }
}

export function appendLedger(entry: LedgerEntry): void {
  appendFileSync(ledgerFile(), `${JSON.stringify(entry)}\n`);
}

export function readLedger(): LedgerEntry[] {
  const file = ledgerFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
}

/** Paid searches this repo has made in the current calendar month, by label prefix. */
export function spentThisMonth(now = new Date()): Record<string, number> {
  const month = now.toISOString().slice(0, 7);
  const out: Record<string, number> = {};
  for (const e of readLedger()) {
    if (!e.at.startsWith(month)) continue;
    const category = e.label.split(':')[0] ?? 'other';
    out[category] = (out[category] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------- one spender at a time

export class SpendLockError extends Error {}

interface LockInfo {
  pid: number;
  owner: string;
  at: string;
}

function readLock(file: string): LockInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
    return typeof info.pid === 'number' ? info : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only asks whether the process exists
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the spend lock, or throw SpendLockError if another live process holds it.
 * Two agents that each check the ledger and then both spend would overrun a cap;
 * the lock makes that impossible. A lock left by a process that died is taken over.
 * Returns a function that releases the lock (also released when this process exits).
 */
export function acquireSpendLock(owner: string): () => void {
  const file = lockFile();
  const release = () => {
    if (readLock(file)?.pid === process.pid) rmSync(file, { force: true });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() } satisfies LockInfo), { flag: 'wx' });
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const held = readLock(file);
      if (held?.pid === process.pid) return release; // this process already holds it
      if (held && isAlive(held.pid)) {
        const what = held.owner === 'keepa' ? 'Keepa tokens' : 'searches';
        throw new SpendLockError(
          `Another process is already spending ${what} (${held.owner}, pid ${held.pid}, since ${held.at}). ` +
            'Only one may spend at a time. Wait for it to finish.',
        );
      }
      rmSync(file, { force: true }); // unreadable, or its holder is gone
    }
  }
  throw new SpendLockError('Could not take the spend lock. Try again.');
}
