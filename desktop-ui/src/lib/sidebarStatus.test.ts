import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import type { AppState } from '../api/types';
import { feeLookupWords } from './keyStatus';
import { sidebarStatus } from './sidebarStatus';

const NOW = Date.parse('2026-11-23T10:00:00');
const at = (min: number): string => new Date(NOW + min * 60_000).toISOString();
const make = (patch: (s: AppState) => void): AppState => {
  const s = structuredClone(STATE);
  patch(s);
  return s;
};

describe('the sidebar status', () => {
  it('is at most four lines: state, when, one usage line and at most one problem', () => {
    const v = sidebarStatus(
      make((s) => {
        s.agent.nextScanAt = null;
        s.agent.lastScan = { at: at(-51), result: 'finished', newDeals: 0, searches: 1, message: null };
        s.budget = { ...s.budget, serpLeft: 119, keepaTokens: 57, keepaRefillPerMin: 1 };
        s.keyProblems = { ebay: 'not accepted' };
      }),
      NOW,
    );
    expect(v).toEqual({ state: 'Idle', running: false, when: 'Last scan 51 min ago', usage: '119 searches left · Keepa 57 tokens', usageFull: '119 searches left · Keepa 57 tokens · 1 a minute', problem: { text: 'eBay key not accepted', to: { screen: 'settings', id: 'keys' } } });
  });

  it('folds the fee lookups into the usage line when some wait, never a fifth line', () => {
    const v = sidebarStatus(make((s) => { s.budget = { ...s.budget, serpLeft: 119, keepaTokens: 13, keepaRefillPerMin: 1 }; s.agent.drip = { active: true, waiting: 0, nextAt: null, lastLookupAt: null, feesWaiting: 24 }; }), NOW);
    expect(v.usage).toBe('119 searches · 24 fee lookups');
    expect(v.usageFull).toBe('119 searches left · 24 fee lookups waiting · Keepa 13 tokens · 1 a minute');
    expect(sidebarStatus(make((s) => { s.agent.drip = { active: true, waiting: 0, nextAt: null, lastLookupAt: null }; }), NOW).usage).not.toMatch(/fee lookup/);
    expect(feeLookupWords({ feesWaiting: 1 })).toBe('1 fee lookup waiting');
  });

  it('says the next scan when one is planned', () => {
    expect(sidebarStatus(make((s) => { s.agent.nextScanAt = at(133); }), NOW).when).toMatch(/^Next scan /);
  });

  it('says the step and shows the bar while a scan runs, and nothing for when', () => {
    const v = sidebarStatus(
      make((s) => {
        s.agent.status = 'scanning';
        s.agent.pipeline = { stepsDone: 3, stepsTotal: 8, fraction: 0.46, current: { label: 'Reading part prices', count: '31 of 40' } } as never;
      }),
      NOW,
    );
    expect(v.state).toBe('Scanning · step 4 of 8');
    expect(v.running).toBe(true);
    expect(v.when).toBeNull();
  });

  it('has no problem line when nothing is wrong, and names Chrome when it is closed or not connected', () => {
    expect(sidebarStatus(make(() => undefined), NOW).problem).toBeNull();
    expect(sidebarStatus(make((s) => { s.helper = { ...s.helper, connected: false }; }), NOW).problem).toEqual({ text: 'Chrome closed', to: { screen: 'settings', id: 'chrome' } });
    expect(sidebarStatus(make((s) => { s.helper = { paired: false, connected: false, lastSeenAt: null, jobsWaiting: 0 }; }), NOW).problem?.text).toBe('Chrome not connected');
  });

  it('shows one problem even when two are true: the rejected key first', () => {
    const v = sidebarStatus(make((s) => { s.helper = { ...s.helper, connected: false }; s.keyProblems = { keepa: 'x', ebay: 'y' }; }), NOW);
    expect(v.problem?.text).toBe('2 keys not accepted');
  });

  it('leaves Keepa out of the usage line without a key, and says when searches are not checked', () => {
    expect(sidebarStatus(make((s) => { s.keys.keepa = false; }), NOW).usage).toBe('187 searches left');
    expect(sidebarStatus(make((s) => { s.budget.serpLeft = null; s.keys.keepa = false; }), NOW).usage).toBe('Searches not checked yet');
    expect(sidebarStatus(make((s) => { s.budget.serpLeft = 1; s.keys.keepa = false; }), NOW).usage).toBe('1 search left');
  });
});
