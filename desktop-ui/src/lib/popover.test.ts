import { describe, expect, it } from 'vitest';
import { DEALS, QUESTIONS, STATE } from '../api/mockData';
import type { AppState, PipelineView } from '../api/types';
import { bestDeal, needsYou, orderQuestions, popoverStatus, scanBlocked, scanCost } from './popover';

const state = (patch: (s: AppState) => void): AppState => {
  const s = structuredClone(STATE);
  patch(s);
  return s;
};

const pipeline = (stepsDone: number): PipelineView => ({
  current: { label: 'Checking eBay listings', count: '23 of 60' },
  estimateText: 'about 4 min',
  stepsDone,
  stepsTotal: 6,
  fraction: 0.4,
  ariaValueText: 'Step 3 of 6',
  steps: [],
});

describe('popover status', () => {
  it('says Idle with nothing wrong', () => {
    expect(popoverStatus(STATE, true)).toMatchObject({ state: 'Idle', progress: null, attention: false });
  });
  it('counts the scan step from the agent: the step in progress is one past those done', () => {
    const s = state((x) => {
      x.agent.status = 'scanning';
      x.agent.pipeline = pipeline(2);
    });
    expect(popoverStatus(s, true)).toEqual({
      state: 'Scanning',
      detail: 'Step 3 of 6 · Checking eBay listings 23 of 60',
      progress: { step: 3, of: 6, fraction: 0.4 },
      attention: false,
    });
  });
  it('never shows a step past the last', () => {
    const s = state((x) => {
      x.agent.status = 'scanning';
      x.agent.pipeline = pipeline(6);
    });
    expect(popoverStatus(s, true).progress?.step).toBe(6);
  });
  it('shows no bar for a run that reports no stages', () => {
    const s = state((x) => {
      x.agent.status = 'asking';
      x.agent.step = 'Asking about 4 questions';
    });
    expect(popoverStatus(s, true)).toMatchObject({ state: 'Asking AI', detail: 'Asking about 4 questions', progress: null });
  });
  it('says Paused, and Chrome closed only when nothing else is going on', () => {
    expect(popoverStatus(state((x) => (x.agent.status = 'paused')), true).state).toBe('Paused');
    const closed = state((x) => (x.helper = { paired: true, connected: false, lastSeenAt: null, jobsWaiting: 0 }));
    expect(popoverStatus(closed, true)).toMatchObject({ state: 'Chrome closed', attention: true });
    closed.agent.status = 'paused';
    expect(popoverStatus(closed, true).state).toBe('Paused');
  });
  it('says the agent is offline instead of a stale state', () => {
    expect(popoverStatus(STATE, false)).toMatchObject({ state: 'Agent offline', attention: true });
  });
});

describe('popover questions', () => {
  it('lists AI-verified first, then the oldest, three at most, and counts the rest from the agent', () => {
    const ordered = orderQuestions(QUESTIONS);
    const verified = QUESTIONS.filter((q) => q.suggestion?.status === 'verified').length;
    expect(ordered.slice(0, verified).every((q) => q.suggestion?.status === 'verified')).toBe(true);
    const { shown, more } = needsYou(QUESTIONS, 7);
    expect(shown).toHaveLength(Math.min(3, QUESTIONS.length));
    expect(more).toBe(7 - shown.length);
  });
  it('has nothing more when the agent counts fewer than are shown', () => {
    expect(needsYou(QUESTIONS, 0).more).toBe(0);
  });
});

describe('best deal', () => {
  it('is the highest estimated profit with no open question', () => {
    const best = bestDeal(DEALS);
    const eligible = DEALS.filter((r) => r.profit !== null && !r.needsAnswer);
    expect(best?.profit).toBe(Math.max(...eligible.map((r) => r.profit ?? -Infinity)));
    expect(best?.needsAnswer).toBe(false);
  });
  it('never picks a loss: when every estimate is below zero there is no best deal', () => {
    const loss = DEALS.find((r) => r.profit !== null && r.profit < 0)!;
    expect(loss).toBeDefined();
    expect(bestDeal(DEALS.map((r) => ({ ...r, profit: r.profit === null ? null : -Math.abs(r.profit) - 1 })))).toBeNull();
    expect(bestDeal([loss])).toBeNull();
  });
  it('is nothing when no bundle has an estimate', () => {
    expect(bestDeal(DEALS.map((r) => ({ ...r, profit: null })))).toBeNull();
    expect(bestDeal([])).toBeNull();
  });
});

describe('scan button', () => {
  it('shows what a scan costs and can be pressed', () => {
    expect(scanCost(STATE)).toBe('up to 5 searches');
    expect(scanBlocked(STATE, true)).toBeNull();
  });
  it('says why it cannot: offline, paused, no key, at the reserve', () => {
    expect(scanBlocked(STATE, false)).toMatch(/not running/);
    expect(scanBlocked(state((x) => (x.agent.status = 'paused')), true)).toMatch(/Resume/);
    expect(scanBlocked(state((x) => (x.keys.serpapi = false)), true)).toMatch(/key/);
    expect(scanBlocked(state((x) => (x.budget.serpLeft = 20)), true)).toMatch(/reserve/);
  });
});
