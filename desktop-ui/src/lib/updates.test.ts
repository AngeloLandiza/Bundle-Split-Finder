import { describe, expect, it } from 'vitest';
import type * as C from '@core/api/contract';
import { mapState } from '../api/map';
import { updatesHelp, versionLine } from './updates';

const NOW = Date.parse('2026-11-26T12:00:00Z');

describe('Settings, General: new versions', () => {
  it('names the version and the last look, and what it found', () => {
    const base = { can: true, version: '0.2.0', checkedAt: null, outcome: null } as const;
    expect(versionLine(base, NOW)).toBe('Version 0.2.0. Not checked yet: Split Finder looks a minute after it opens.');
    expect(versionLine({ ...base, checkedAt: '2026-11-26T11:40:00Z', outcome: 'current' }, NOW)).toBe('Version 0.2.0. Last checked 20 min ago: this is the newest.');
    expect(versionLine({ ...base, checkedAt: '2026-11-26T11:40:00Z', outcome: 'failed' }, NOW)).toBe('Version 0.2.0. The last look, 20 min ago, did not get through; it looks again in 6 hours.');
    expect(versionLine({ ...base, checkedAt: '2026-11-26T11:40:00Z', outcome: 'found', ready: '0.2.1' }, NOW)).toBe('Version 0.2.0. Version 0.2.1 is downloaded and checked (20 min ago).');
    expect(versionLine(undefined)).toBeNull();
    expect(versionLine({ ...base, version: null })).toBeNull();
  });

  it('a copy that cannot update itself says why, and keeps the old promise of a link', () => {
    const help = updatesHelp({ can: false, why: 'A development build does not update itself.', version: '0.2.0', checkedAt: null, outcome: null });
    expect(help).toContain('A development build does not update itself.');
    expect(versionLine({ can: false, version: '0.2.0', checkedAt: null, outcome: null })).toBe('Version 0.2.0.');
    expect(updatesHelp(undefined)).toContain('must carry the project’s signature');
  });
});

describe('the agent state’s update fields, read strictly', () => {
  const base: C.AgentState = {
    agent: { status: 'idle', nextScanAt: null, lastScan: null },
    helper: { paired: false, connected: false, lastSeenAt: null },
    budget: { serpLeft: null, serpReserve: 20, keepaTokens: null, aiSpentUsd: 0, aiCapUsd: 20 },
    counts: { review: 0, autopilotApplied: 0, newDeals: 0, jobsWaiting: 0 },
    keys: { serpapi: false, keepa: false, anthropic: false, openai: false, ebay: false, telegram: false, amazonSeller: false },
  };

  it('a ready or updated notice never carries a link; an old download notice keeps the allowed link only', () => {
    const ready = mapState({ ...base, update: { kind: 'ready', version: '0.2.1', date: '2026-11-26', notes: ['A.'], link: 'https://evil.example/x.exe', waiting: 'It installs when nothing is running; a scan is running.' } });
    expect(ready.update).toEqual({ kind: 'ready', version: '0.2.1', date: '2026-11-26', notes: ['A.'], link: null, waiting: 'It installs when nothing is running; a scan is running.' });
    const old = mapState({ ...base, update: { version: '0.2.1', date: '2026-11-26', notes: ['A.'], link: 'https://evil.example/x.exe' } });
    expect(old.update).toMatchObject({ kind: 'download', link: null });
    const good = 'https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/latest/download/Split-Finder-Windows-x64-setup.exe';
    expect(mapState({ ...base, update: { version: '0.2.1', date: '2026-11-26', notes: [], link: good } }).update?.link).toBe(good);
  });

  it('reads the updater state, and leaves it out when an older agent sends none', () => {
    expect(mapState(base).updater).toBeUndefined();
    const s = mapState({ ...base, updater: { can: true, version: '0.2.0', checkedAt: '2026-11-26T11:40:00Z', outcome: 'found', ready: '0.2.1' } });
    expect(s.updater).toEqual({ can: true, version: '0.2.0', checkedAt: '2026-11-26T11:40:00Z', outcome: 'found', ready: '0.2.1' });
    expect(mapState({ ...base, updater: { can: 'yes' } as never }).updater).toBeUndefined();
  });
});
