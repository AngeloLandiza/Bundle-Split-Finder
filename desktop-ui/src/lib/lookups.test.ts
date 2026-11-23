import { describe, expect, it } from 'vitest';
import { DEALS, STATE } from '../api/mockData';
import type { AppState, DealRow } from '../api/types';
import { keepaLookupsPerHour, lookupNotice, lookupsStartedWords, searchesAvailable, waitingLookups } from './lookups';

const state = (patch: (s: AppState) => void): AppState => {
  const s = structuredClone(STATE);
  s.agent.lastScan = { at: '2026-11-23T10:00:00Z', result: 'finished', newDeals: 0, searches: 1, message: null };
  s.budget = { ...s.budget, serpLeft: 119, serpReserve: 100, serpPerScan: 18, keepaTokens: 57, keepaRefillPerMin: 1 };
  patch(s);
  return s;
};
const dripping = (s: AppState) => {
  s.agent.drip = { active: true, waiting: 18, nextAt: null, lastLookupAt: null };
  s.agent.lastScan!.waitingLookups = 18;
};

describe('the notice for parts waiting on an Amazon lookup', () => {
  it('says how many wait and that Keepa looks them up as its tokens refill, at its rate', () => {
    const n = lookupNotice(state(dripping), []);
    expect(n?.title).toBe('18 parts are waiting for an Amazon lookup.');
    expect(n?.text).toBe('Keepa looks them up as its tokens refill (about 6 an hour).');
  });
  it('words the cause the agent named, and nothing else', () => {
    const n = lookupNotice(state((s) => { dripping(s); s.agent.lastScan!.lookupsBlockedBy = 'search_cap'; }), []);
    expect(n?.text).toBe('The last scan reached its search limit for one scan. Keepa looks them up as its tokens refill (about 6 an hour).');
    expect(lookupNotice(state((s) => { dripping(s); s.agent.lastScan!.lookupsBlockedBy = 'hourly_limit'; }), [])?.text).toContain('SerpApi’s hourly limit was reached.');
    expect(lookupNotice(state((s) => { dripping(s); s.agent.lastScan!.lookupsBlockedBy = 'reserve'; }), [])?.text).toContain('down to the reserve you keep');
  });
  it('does not promise Keepa without a Keepa key, and says how to get it', () => {
    const n = lookupNotice(state((s) => { dripping(s); s.keys.keepa = false; }), []);
    expect(n?.text).toContain('Add a Keepa key');
    expect(n?.text).not.toContain('refill');
  });
  it('is nothing when none wait or the agent says nothing', () => {
    expect(lookupNotice(state((s) => { s.agent.lastScan!.waitingLookups = 0; }), [])).toBeNull();
    expect(lookupNotice(null, DEALS)).toBeNull();
    expect(lookupNotice(state(() => undefined), null)).toBeNull();
  });
  it('counts the rows that wait when the agent sends no count', () => {
    const rows: DealRow[] = [{ ...DEALS[0]!, lookup: { searches: 2 } }, { ...DEALS[1]!, lookup: { searches: 1 } }, { ...DEALS[2]!, lookup: null }];
    expect(waitingLookups(state(() => undefined), rows)).toBe(2);
  });
});

describe('Look up now', () => {
  it('spends up to the per-scan cap, or what is left above the reserve, whichever is less', () => {
    expect(searchesAvailable({ ...STATE.budget, serpLeft: 119, serpReserve: 100, serpPerScan: 18 })).toBe(18);
    expect(searchesAvailable({ ...STATE.budget, serpLeft: 105, serpReserve: 100, serpPerScan: 18 })).toBe(5);
    expect(searchesAvailable({ ...STATE.budget, serpLeft: 90, serpReserve: 100, serpPerScan: 18 })).toBe(0);
    expect(searchesAvailable({ ...STATE.budget, serpLeft: null })).toBeNull();
  });
  it('shows its cost as a ceiling, never more than the parts that wait', () => {
    const a = lookupNotice(state(dripping), [])?.action;
    expect(a).toMatchObject({ label: 'Look up now', cost: 'up to 18 searches', maxSearches: 18, enabled: true, reason: null });
    const few = lookupNotice(state((s) => { dripping(s); s.agent.lastScan!.waitingLookups = 3; s.agent.drip!.waiting = 3; }), [])?.action;
    expect(few).toMatchObject({ maxSearches: 3, cost: 'up to 3 searches' });
  });
  it('is greyed with the reason when no search may be spent, a scan runs or the key is missing', () => {
    const atReserve = lookupNotice(state((s) => { dripping(s); s.budget.serpLeft = 100; }), [])?.action;
    expect(atReserve).toMatchObject({ enabled: false, cost: null, maxSearches: 0, reason: 'Your searches are at the reserve of 100.' });
    expect(lookupNotice(state((s) => { dripping(s); s.agent.status = 'scanning'; }), [])?.action.reason).toBe('A scan is running. Look up when it has finished.');
    expect(lookupNotice(state((s) => { dripping(s); s.keys.serpapi = false; }), [])?.action.reason).toContain('SerpApi key');
  });
  it('says what a started run does, or why it did not start', () => {
    expect(lookupsStartedWords({ started: true, viaKeepa: 5, viaSerpapi: 3 })).toBe('Looking up 5 parts through Keepa and 3 parts through 3 searches. Results appear here as they arrive.');
    expect(lookupsStartedWords({ started: false, reason: 'A scan is running.', viaKeepa: 0, viaSerpapi: 0 })).toBe('A scan is running.');
  });
  it('reads Keepa’s refill as lookups an hour, only when it is known', () => {
    expect(keepaLookupsPerHour(1)).toBe(6);
    expect(keepaLookupsPerHour(undefined)).toBeNull();
    expect(keepaLookupsPerHour(0)).toBeNull();
  });
});
