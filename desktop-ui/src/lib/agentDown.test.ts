import { describe, expect, it } from 'vitest';
import { agentDownHint, offlineNotice, supervisionOf, type AgentSupervision } from './agentDown';
import { wordsFor } from './platform';

const mac = wordsFor(false);
const win = wordsFor(true);
const sup = (over: Partial<AgentSupervision>): AgentSupervision => ({ running: false, phase: 'running', restarts: 0, maxRestarts: 5, windowMinutes: 10, nextTryInMs: null, ...over });

describe('the banner while the agent does not answer', () => {
  it('while the shell restarts it: says so, when, and offers nothing to click', () => {
    const n = offlineNotice(sup({ phase: 'restarting', restarts: 2, nextTryInMs: 1_600 }), true, mac);
    expect(n.title).toBe('The agent stopped unexpectedly and is being restarted.');
    expect(n.body).toBe('Split Finder starts it again in 2 seconds (restart 2 of at most 5 in 10 minutes). Nothing saved is lost. What is on screen is from before it stopped.');
    expect(n.action).toBeNull();
    expect(offlineNotice(sup({ phase: 'restarting', restarts: 1, nextTryInMs: 0 }), true, mac).body).toMatch(/^Split Finder starts it again now \(restart 1 of at most 5/);
  });

  it('when the shell gave up: what works (Quit and open again) and the button that does it; Exit on Windows', () => {
    const n = offlineNotice(sup({ phase: 'gaveUp', restarts: 6 }), true, mac);
    expect(n.title).toBe('The agent keeps stopping.');
    expect(n.body).toContain('It stopped 6 times in 10 minutes, so Split Finder stopped restarting it.');
    expect(n.body).toContain('Quit and open again; if it stops again, Activity says why.');
    expect(n.action).toEqual({ kind: 'relaunch', label: 'Quit and open again' });
    expect(offlineNotice(sup({ phase: 'gaveUp', restarts: 6 }), true, win).action).toEqual({ kind: 'relaunch', label: 'Exit and open again' });
  });

  it('never tells him to open an app that is already open', () => {
    const all = [
      offlineNotice(null, true, mac),
      offlineNotice(null, false, mac),
      offlineNotice(sup({}), true, mac),
      offlineNotice(sup({ running: true }), true, mac),
      offlineNotice(sup({ phase: 'restarting' }), true, win),
      offlineNotice(sup({ phase: 'gaveUp' }), true, win),
    ];
    for (const n of all) expect(`${n.title} ${n.body}`).not.toMatch(/Open Split Finder from/);
  });

  it('not restarting and not running (an agent the shell did not start): Quit and open again; running but silent: try again', () => {
    expect(offlineNotice(sup({}), true, mac)).toMatchObject({ title: 'The agent is not running.', action: { kind: 'relaunch' } });
    expect(offlineNotice(sup({ running: true }), true, mac)).toMatchObject({ title: 'The agent is not answering.', action: { kind: 'retry' } });
  });

  it('the short version says the app restarts it, and what to do if it does not come back', () => {
    expect(agentDownHint(mac)).toBe('Split Finder restarts it by itself; if it does not come back, quit Split Finder and open it again.');
    expect(agentDownHint(win)).toBe('Split Finder restarts it by itself; if it does not come back, exit and open Split Finder again.');
  });

  it('reads the shell’s answer defensively: an older shell’s boolean is no supervision', () => {
    expect(supervisionOf(true)).toBeNull();
    expect(supervisionOf({ running: false, phase: 'gaveUp', restarts: 6, maxRestarts: 5, windowMinutes: 10, nextTryInMs: null })).toMatchObject({ phase: 'gaveUp', restarts: 6 });
    expect(supervisionOf({ running: false, phase: 'odd' })).toBeNull();
  });
});
