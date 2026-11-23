import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import { setupProgress } from './setup';

describe('setup progress', () => {
  it('is complete once Chrome is paired, the key is saved and a scan has run', () => {
    const p = setupProgress(STATE);
    expect(p.complete).toBe(true);
    expect(p.done).toBe(3);
  });
  it('starts at Chrome on a new Mac and counts what is done', () => {
    const fresh = { ...STATE, firstRun: true, helper: { ...STATE.helper, paired: false }, keys: { ...STATE.keys, serpapi: false }, agent: { ...STATE.agent, lastScan: null } };
    expect(setupProgress(fresh)).toMatchObject({ done: 0, current: 'chrome', complete: false });
    expect(setupProgress({ ...fresh, helper: STATE.helper })).toMatchObject({ done: 1, current: 'key' });
    expect(setupProgress({ ...fresh, helper: STATE.helper, keys: STATE.keys })).toMatchObject({ done: 2, current: 'scan' });
  });
});
