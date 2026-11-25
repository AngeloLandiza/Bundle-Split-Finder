// Nov 25, supervision: what the window says while the agent does not answer. The shell restarts an agent that stopped
// unexpectedly (src-tauri/src/agent.rs: at once, then after 2 s, 10 s, 60 s and 60 s, at most 5 times in 10 minutes) and
// answers `agent_status` with what it is doing; the banner says that, and only offers what really works.

import type { Words } from './platform';

/** The shell's `agent_status` (agent.rs AgentStatus). An older shell answers a bare boolean. */
export interface AgentSupervision {
  running: boolean;
  phase: 'running' | 'restarting' | 'gaveUp';
  restarts: number;
  maxRestarts: number;
  windowMinutes: number;
  nextTryInMs: number | null;
}

/** What the shell answered, read defensively: null for a browser, an older shell, or anything not the struct. */
export function supervisionOf(raw: unknown): AgentSupervision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.running !== 'boolean' || (r.phase !== 'running' && r.phase !== 'restarting' && r.phase !== 'gaveUp')) return null;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    running: r.running,
    phase: r.phase,
    restarts: n(r.restarts, 0),
    maxRestarts: n(r.maxRestarts, 5),
    windowMinutes: n(r.windowMinutes, 10),
    nextTryInMs: typeof r.nextTryInMs === 'number' ? r.nextTryInMs : null,
  };
}

/** The banner: its words, and its one button ("retry": ask the agent again; "relaunch": Quit and open again; none). */
export interface OfflineNotice {
  title: string;
  body: string;
  action: { kind: 'retry' | 'relaunch'; label: string } | null;
}

const STALE = 'What is on screen is from before it stopped.';

function seconds(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s === 1 ? '1 second' : `${s} seconds`;
}

/**
 * `sup` null: no shell to ask (a browser, or a shell from before supervision). `inShell` false: the dev page in a
 * browser, where starting the agent is the developer's.
 */
export function offlineNotice(sup: AgentSupervision | null, inShell: boolean, w: Pick<Words, 'quit'>): OfflineNotice {
  if (!inShell) return { title: 'The agent is not running.', body: `Start it, then try again. ${STALE}`, action: { kind: 'retry', label: 'Try again' } };
  const relaunch = { kind: 'relaunch' as const, label: `${w.quit === 'Exit' ? 'Exit' : 'Quit'} and open again` };
  if (!sup) return { title: 'The agent is not running.', body: `${w.quit} and open it again to start it. ${STALE}`, action: { kind: 'retry', label: 'Try again' } };
  if (sup.phase === 'restarting') {
    const when = sup.nextTryInMs !== null && sup.nextTryInMs > 1000 ? `in ${seconds(sup.nextTryInMs)}` : 'now';
    return {
      title: 'The agent stopped unexpectedly and is being restarted.',
      body: `Split Finder starts it again ${when} (restart ${Math.min(sup.restarts, sup.maxRestarts)} of at most ${sup.maxRestarts} in ${sup.windowMinutes} minutes). Nothing saved is lost. ${STALE}`,
      action: null,
    };
  }
  if (sup.phase === 'gaveUp') {
    return {
      title: 'The agent keeps stopping.',
      body: `It stopped ${sup.restarts} times in ${sup.windowMinutes} minutes, so Split Finder stopped restarting it. Scheduled scans, price checks and Telegram wait until it runs. ${relaunch.label}; if it stops again, Activity says why. ${STALE}`,
      action: relaunch,
    };
  }
  // The shell sees it running (it just came back, or answers slowly), or it was never the shell's to restart.
  if (sup.running) return { title: 'The agent is not answering.', body: `It is running; the window asks it again in a moment. ${STALE}`, action: { kind: 'retry', label: 'Try again' } };
  return { title: 'The agent is not running.', body: `${relaunch.label} to start it. ${STALE}`, action: relaunch };
}

/** The short version, where there is no room for the banner (an action's error, Preferences, the welcome sheet). */
export function agentDownHint(w: Pick<Words, 'quit'>): string {
  const reopen = w.quit === 'Exit' ? 'exit and open Split Finder again' : 'quit Split Finder and open it again';
  return `Split Finder restarts it by itself; if it does not come back, ${reopen}.`;
}
