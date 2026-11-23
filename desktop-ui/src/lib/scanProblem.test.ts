import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import type { AppState, DealRow, LastScan } from '../api/types';
import { helperProblem, isWaitingPage, scanProblem } from './scanProblem';

const base = STATE.agent.lastScan as LastScan;
const withScan = (last: Partial<LastScan> | null, patch: (s: AppState) => void = () => undefined): AppState => {
  const s = structuredClone(STATE);
  s.agent.lastScan = last ? { ...base, ...last } : null;
  patch(s);
  return s;
};

describe('scan problem banner', () => {
  it('is absent after a scan that finished, before any scan, and after a stop the owner asked for', () => {
    expect(scanProblem(STATE)).toBeNull();
    expect(scanProblem(withScan(null))).toBeNull();
    expect(scanProblem(withScan({ result: 'stopped', userStopped: true, message: 'You stopped the scan.' }))).toBeNull();
    expect(scanProblem(withScan({ pagesUnread: 0 }))).toBeNull();
  });

  it('says what happened for unread pages, in words, with the consequence and the free action', () => {
    const p = scanProblem(withScan({ result: 'stopped', message: 'Home Depot refused a page (HTTP 200); the rest are read next scan.', pagesUnread: 16, canReadPagesAgain: true }));
    expect(p?.what).toBe('The last scan could not read 16 Home Depot pages, so their parts are not known yet.');
    expect(p?.consequence).toMatch(/no estimate until the page is read/);
    expect(p?.action).toEqual({ enabled: true, reason: null });
  });

  it('is singular for one page', () => {
    expect(scanProblem(withScan({ pagesUnread: 1, canReadPagesAgain: true }))?.what).toBe('The last scan could not read 1 Home Depot page, so its parts are not known yet.');
  });

  it('greys the action with a reason while a scan runs, and when Chrome is closed', () => {
    const running = scanProblem(withScan({ pagesUnread: 3, canReadPagesAgain: true }, (s) => void (s.agent.status = 'scanning')));
    expect(running?.action).toEqual({ enabled: false, reason: 'A scan is running. Read the pages when it has finished.' });
    const closed = scanProblem(withScan({ pagesUnread: 3, canReadPagesAgain: false }, (s) => void (s.helper.connected = false)));
    expect(closed?.action?.enabled).toBe(false);
    expect(closed?.action?.reason).toMatch(/Chrome is closed/);
  });

  it('offers no action when the agent did not say it can (an older agent)', () => {
    expect(scanProblem(withScan({ pagesUnread: 3 }))?.action).toBeNull();
  });

  it('says a stop or failure with the agent message and no read action', () => {
    const stopped = scanProblem(withScan({ result: 'stopped', message: 'Home Depot refused a page (HTTP 200); the rest are read next scan.' }));
    expect(stopped?.what).toBe('Home Depot refused a page (HTTP 200); the rest are read next scan.');
    expect(stopped?.action).toBeNull();
    expect(scanProblem(withScan({ result: 'failed', message: 'SerpApi did not answer.' }))?.what).toBe('The last scan failed. SerpApi did not answer.');
  });

  it('leaves a stop at the reserve to the notice that already says it', () => {
    const atReserve = (s: AppState) => {
      s.budget.serpLeft = s.budget.serpReserve;
    };
    expect(scanProblem(withScan({ result: 'limit', message: 'Stopped at your reserve.' }, atReserve))).toBeNull();
    expect(scanProblem(withScan({ result: 'limit', message: 'Stopped at the hourly limit.' }))?.what).toBe('Stopped at the hourly limit.');
  });
});

describe('outdated helper banner', () => {
  it('shows only when the agent says the helper is older, with the fallback line', () => {
    expect(helperProblem(STATE)).toBeNull();
    const s = structuredClone(STATE);
    s.helper.outdated = true;
    s.helper.version = '0.4.1';
    const h = helperProblem(s);
    expect(h?.title).toBe('The Chrome helper is older than the app.');
    expect(h?.text).toMatch(/version 0\.4\.1/);
    expect(h?.fallback).toBe('If nothing changes: open chrome://extensions and press Reload on Split Finder.');
  });
});

describe('waiting_page rows', () => {
  it('is waiting only when the agent says so', () => {
    expect(isWaitingPage({ matchKind: 'waiting_page' })).toBe(true);
    expect(isWaitingPage({ matchKind: null })).toBe(false);
    expect(isWaitingPage({} as Pick<DealRow, 'matchKind'>)).toBe(false);
  });
});
