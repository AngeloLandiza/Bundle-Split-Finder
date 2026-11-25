// Nov 25, supervision: when the agent dies, and the agent that starts after it. The desktop shell restarts a sidecar that
// ended without being asked to (src-tauri/src/agent.rs); this side makes the death clean and says why.
//
//   An uncaught exception or an unhandled rejection is the truly unexpected (a job's failure is caught where the job runs
//   and is an Activity error): one scrubbed line goes to <dataDir>/agent-crash.jsonl, the store lock and the keep-awake
//   hold are released, and the process exits with CRASH_EXIT_CODE so the shell starts it again. It never keeps running in
//   a state nobody knows.
//   The agent the shell starts again reads that line and the shell's restart count, marks the runs the dead one left as
//   running as stopped, and writes one Activity line saying what happened and what became of a scan that was running.

import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord } from '../core/src/api/contract';
import type { ActivityErrorRecord } from './store';

export const CRASH_FILE = 'agent-crash.jsonl';
/** EX_SOFTWARE: an internal error. Anything not 0 makes the shell restart the agent; this one says it was a crash. */
export const CRASH_EXIT_CODE = 70;
const KEEP_CRASHES = 20;
/** A crash line older than this when the agent starts again is not the one that just happened. */
export const CRASH_FRESH_MS = 10 * 60_000;

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

export interface CrashRecord {
  at: string;
  kind: CrashKind;
  /** The error's name ("TypeError"), or the type of what was thrown. */
  name: string;
  /** The first line of its message, scrubbed, at most 200 characters. */
  message: string;
  /** What the agent was doing: "scan: Reading Home Depot pages", "drip", or null when nothing ran. */
  step: string | null;
}

/** Runs of letters, digits, - and _ this long look like a key or a token, whatever the store holds: masked. */
const KEYLIKE = /[A-Za-z0-9_-]{20,}/g;

/**
 * Text that may leave the process: the first line only, every secret given replaced by "[key]", anything else shaped like
 * a key masked, control characters out, at most `max` characters. Never throws.
 */
export function scrubCrashText(text: unknown, secrets: readonly string[], max = 200): string {
  let t = String(text ?? '');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) t = t.split(s).join('[key]');
  t = (t.split(/\r?\n/)[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(KEYLIKE, '[hidden]').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function crashRecord(err: unknown, kind: CrashKind, at: number, step: string | null, secrets: readonly string[]): CrashRecord {
  const name = err instanceof Error ? scrubCrashText(err.name || 'Error', secrets, 60) : typeof err;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return { at: new Date(at).toISOString(), kind, name: name || 'Error', message: scrubCrashText(message, secrets), step: step === null ? null : scrubCrashText(step, secrets, 80) };
}

/** Appends the line (owner-only), keeping the last KEEP_CRASHES. Never throws: the process is on its way out. */
export function writeCrashRecord(dataDir: string, rec: CrashRecord): void {
  const path = join(dataDir, CRASH_FILE);
  try {
    appendFileSync(path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > KEEP_CRASHES) writeFileSync(path, `${lines.slice(-KEEP_CRASHES).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // nowhere to write: the shell still sees the exit code
  }
}

/** The crash lines, oldest first; lines that do not parse are skipped. */
export function readCrashes(dataDir: string): CrashRecord[] {
  let text: string;
  try {
    text = readFileSync(join(dataDir, CRASH_FILE), 'utf8');
  } catch {
    return [];
  }
  const out: CrashRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<CrashRecord>;
      if (typeof r.at === 'string' && typeof r.name === 'string' && typeof r.message === 'string') {
        out.push({ at: r.at, kind: r.kind === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException', name: r.name, message: r.message, step: typeof r.step === 'string' ? r.step : null });
      }
    } catch {
      // a half-written line from a hard stop
    }
  }
  return out;
}

export interface CrashDeps {
  dataDir: string;
  /** Every key the store holds and the app's token: none of them may reach the file. Read when the crash comes. */
  secrets: () => readonly string[];
  /** What was running (AgentWork.currentStep), when the agent got that far. */
  step: () => string | null;
  /** Releases what must be released: the store lock, the keep-awake hold, the timers (Agent.close). */
  release: () => void;
  exit: (code: number) => void;
  now?: () => number;
  /** One line for whoever reads the sidecar's output (the shell's log in a dev build). */
  log?: (line: string) => void;
}

/**
 * Installs the two last-resort handlers on `proc` (the real process, or a fake in tests). Each writes the crash line,
 * releases, and exits non-zero. A second error while that happens changes nothing: the first is the one recorded.
 * Returns the handler, for tests.
 */
export function installCrashHandlers(proc: { on(event: CrashKind, fn: (err: unknown) => void): unknown }, deps: CrashDeps): (err: unknown, kind: CrashKind) => void {
  let dying = false;
  const die = (err: unknown, kind: CrashKind): void => {
    if (dying) return;
    dying = true;
    let rec: CrashRecord | null = null;
    try {
      const secrets = safe(deps.secrets, [] as readonly string[]);
      rec = crashRecord(err, kind, (deps.now ?? Date.now)(), safe(deps.step, null), secrets);
      writeCrashRecord(deps.dataDir, rec);
    } catch {
      // the exit below is what matters
    }
    try {
      deps.log?.(`[agent] stopped unexpectedly: ${rec ? `${rec.name}: ${rec.message}` : kind}`);
    } catch {
      // no output to write to
    }
    try {
      deps.release();
    } catch {
      // a half-closed agent is still better gone
    }
    deps.exit(CRASH_EXIT_CODE);
  };
  proc.on('uncaughtException', (err) => die(err, 'uncaughtException'));
  proc.on('unhandledRejection', (reason) => die(reason, 'unhandledRejection'));
  return die;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- the agent after a restart

/** What the shell says when it starts the agent again: the how-many-th restart in its window, and when the last one died. */
export interface RestartInfo {
  attempt: number;
  stoppedAt: number | null;
}

/** SPLIT_FINDER_RESTART (1 for the first restart in the shell's window) and SPLIT_FINDER_STOPPED_AT (epoch ms). Null: a normal start. */
export function restartFromEnv(env: Record<string, string | undefined>): RestartInfo | null {
  const attempt = Number(env.SPLIT_FINDER_RESTART);
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  const at = Number(env.SPLIT_FINDER_STOPPED_AT);
  return { attempt, stoppedAt: Number.isFinite(at) && at > 0 ? at : null };
}

/** The scan the dead agent left, as the restart line describes it. */
export interface Interrupted {
  trigger: 'scheduled' | 'manual';
  /** The scan's saved job is still "running": the next scan continues it from its last saved step (core runner). */
  continues: boolean;
}

/** "3:12 PM", in the computer's own time. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** The cause, for the end of the line: "TypeError while reading Home Depot pages", or null when the agent left none. */
function causeOf(crash: CrashRecord | null): string | null {
  if (!crash) return null;
  const step = crash.step ? ` during ${crash.step}` : '';
  return `${crash.name}${crash.message ? `: ${crash.message}` : ''}${step}`;
}

/**
 * The one Activity line after a restart. Nothing the store held is lost (each write is whole); what a scan had saved is
 * kept. A scan whose saved job is still running is continued by the next scan (Scan again, or the next scheduled one); a
 * scan that had finished its reads had saved them, and the next scan builds on them.
 */
export function restartSentence(o: { at: number; attempt: number; crash: CrashRecord | null; interrupted: Interrupted | null }): string {
  const head = `Split Finder's background agent stopped unexpectedly at ${clockTime(o.at)} and was restarted${o.attempt > 1 ? ` (${o.attempt} times in the last 10 minutes)` : ''}.`;
  const kept = 'Nothing saved was lost.';
  let scan = '';
  if (o.interrupted?.continues) {
    scan = o.interrupted.trigger === 'scheduled'
      ? ' The scheduled scan that was running stopped at its last saved step: Scan again continues it from there, or the next scheduled scan will.'
      : ' The scan that was running stopped at its last saved step: Scan again continues it from there.';
  } else if (o.interrupted) {
    scan = ' The scan that was running had saved its searches and page reads; Scan again builds the deals from them.';
  }
  const cause = causeOf(o.crash);
  return `${head} ${kept}${scan}${cause ? ` What stopped it: ${cause}.` : ''}`;
}

/**
 * Whether the owner hears of it beyond Activity: a scheduled scan was running (he did not start it, so he would not
 * notice it stopped), or it is the second time in the shell's window (the first repeat; the shell itself tells him when
 * it gives up).
 */
export function restartNotifies(attempt: number, interrupted: Interrupted | null): boolean {
  return interrupted?.trigger === 'scheduled' || attempt === 2;
}

/** The newest crash line written since the agent before this one died, or null (a hard stop writes none). */
export function freshCrash(crashes: readonly CrashRecord[], now: number, stoppedAt: number | null): CrashRecord | null {
  const last = crashes[crashes.length - 1];
  if (!last) return null;
  const at = Date.parse(last.at);
  if (!Number.isFinite(at) || now - at > CRASH_FRESH_MS) return null;
  // The shell saw the death a moment after the line was written; a line from long before that is an older crash.
  if (stoppedAt !== null && stoppedAt - at > 60_000) return null;
  return last;
}

/** Runs the dead agent left as running: stopped, with the sentence. Nothing runs when an agent starts. */
export function closeOrphanRuns(runs: readonly RunRecord[], at: string): { runs: RunRecord[]; closed: RunRecord[] } {
  const closed: RunRecord[] = [];
  const next = runs.map((r) => {
    if (r.status !== 'running') return r;
    const done: RunRecord = { ...r, status: 'stopped', finishedAt: at, stopReason: r.stopReason ?? 'agent', error: r.error ?? 'The agent stopped while this ran.', summary: r.summary && r.summary !== 'Scanning.' ? r.summary : 'Stopped when the agent stopped.' };
    closed.push(r);
    return done;
  });
  return { runs: next, closed };
}

/** The Activity error for the restart: Scan again when a scan was interrupted, nothing to retry otherwise. */
export function restartError(sentence: string, at: number, interrupted: Interrupted | null, searchesPerScan: number): ActivityErrorRecord {
  return {
    id: `err-restart-${at}`,
    at: new Date(at).toISOString(),
    sentence,
    retry: interrupted ? { kind: 'scan', label: 'Scan again', searches: searchesPerScan, usd: 0 } : null,
    resolvedAt: null,
  };
}
