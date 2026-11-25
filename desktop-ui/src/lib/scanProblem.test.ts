import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import type { AppState, DealRow, LastScan } from '../api/types';
import { helperProblem, isWaitingPage, scanProblem, waitingPages } from './scanProblem';

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
    expect(h?.action).toBe('reload');
  });

  // Nov 25: a reload loads the same old files, so the reload and the chrome://extensions advice are only for a helper the
  // app has no files for. The agent says which of the three it is (helper.update).
  it('says the app is updating the helper by itself, quietly and with no button', () => {
    const s = structuredClone(STATE);
    s.helper.outdated = true;
    s.helper.update = { state: 'updating' };
    const h = helperProblem(s);
    expect(h).toMatchObject({ title: 'The Chrome helper is being updated.', action: 'none', quiet: true, fallback: null });
  });

  it('when the app cannot update it, says why and offers Install the helper again, not a reload or chrome://extensions', () => {
    const s = structuredClone(STATE);
    s.helper.outdated = true;
    s.helper.version = '0.1.0+old0001';
    s.helper.update = { state: 'install', why: 'The app cannot tell which folder Chrome loaded the helper from.' };
    const h = helperProblem(s);
    expect(h?.action).toBe('install');
    expect(h?.quiet).toBe(false);
    expect(h?.text).toBe('It is version 0.1.0+old0001. The app cannot tell which folder Chrome loaded the helper from.');
    expect(`${h?.text} ${h?.fallback}`).not.toMatch(/chrome:\/\/extensions|Reload/);
  });
});

// Nov 25: "The last scan could not read 139 pages" said 139 while the between-scan reader had brought the waiting sets to 80 and was
// still going, and it asked for a click the app no longer needed. The agent now counts them live (agent.homeDepot).
describe('the Home Depot pages waiting, counted live', () => {
  const NOW = Date.parse('2026-11-25T10:20:00');
  const at = (h: number, m: number) => new Date(2026, 10, 25, h, m).toISOString();
  const live = (patch: (s: AppState) => void = () => undefined, last: Partial<LastScan> | null = { pagesUnread: 139, canReadPagesAgain: true }): AppState =>
    withScan(last, (s) => {
      s.helper.paired = true;
      s.helper.connected = true;
      s.agent.homeDepot = { pausedUntil: null, pagesWaiting: 105, setsWaiting: 58, bundlesWaiting: 0, perHour: 20, perDay: 240, readToday: 30, nextReadAt: at(10, 54), slowed: true };
      patch(s);
    });

  it('is a quiet line with no button while the app reads them itself: how many, the pace today, and when the next one is', () => {
    const w = waitingPages(live(), NOW);
    expect(w).toEqual({
      tone: 'quiet',
      text: '58 sets are waiting for 105 Home Depot pages. The app is reading them: about 20 an hour today; next at 10:54 AM.',
      action: null,
    });
    expect(w).not.toHaveProperty('title');
  });

  it('the last scan\'s stale count asks for nothing: no "could not read" banner, no Read pages again button', () => {
    expect(scanProblem(live())).toBeNull();
    // Without the live count (an older agent) the last scan's figure is still said, with its button.
    const old = withScan({ pagesUnread: 139, canReadPagesAgain: true });
    expect(scanProblem(old)?.what).toMatch(/could not read 139 Home Depot pages/);
    expect(scanProblem(old)?.action).toEqual({ enabled: true, reason: null });
    // A scan that failed is still said, with no unread count in it.
    expect(scanProblem(live(() => undefined, { result: 'failed', message: 'SerpApi did not answer.', pagesUnread: 139 }))?.what).toBe('The last scan failed. SerpApi did not answer.');
  });

  it('is nothing when no page waits (the last scan said 139; the app has read them all)', () => {
    expect(waitingPages(live((s) => void (s.agent.homeDepot!.pagesWaiting = 0)), NOW)).toBeNull();
    expect(waitingPages(withScan({ pagesUnread: 3 }), NOW)).toBeNull();
  });

  it('says the pause and its end while Home Depot paused reading, and the full pace without "today"', () => {
    const paused = waitingPages(live((s) => void (s.agent.homeDepot!.pausedUntil = at(11, 5))), NOW);
    expect(paused).toMatchObject({ tone: 'quiet', action: null });
    expect(paused?.text).toBe('58 sets are waiting for 105 Home Depot pages. Home Depot paused reading until 11:05 AM; the app reads them then.');
    const full = waitingPages(live((s) => Object.assign(s.agent.homeDepot!, { slowed: false, perHour: 40, setsWaiting: 1, pagesWaiting: 2, bundlesWaiting: 3 })), NOW);
    expect(full?.text).toBe('1 set and 3 bundles are waiting for 2 Home Depot pages. The app is reading them: about 40 an hour; next at 10:54 AM.');
    const spent = waitingPages(live((s) => void (s.agent.homeDepot!.readToday = 240)), NOW);
    expect(spent?.text).toBe("58 sets are waiting for 105 Home Depot pages. Today's 240 pages are read; the app goes on tomorrow.");
  });

  it('is an attention banner with the button that helps only when reading cannot go on by itself: the app is paused, so Resume', () => {
    const w = waitingPages(live((s) => void (s.agent.status = 'paused')), NOW);
    expect(w).toEqual({ tone: 'attention', title: '58 sets are waiting for 105 Home Depot pages.', text: 'Reading is switched off while the app is paused.', action: 'resume' });
  });

  it('leaves Chrome closed or not connected to the Chrome notice, and a running scan to the scan', () => {
    expect(waitingPages(live((s) => void (s.helper.connected = false)), NOW)).toBeNull();
    expect(waitingPages(live((s) => void (s.helper.paired = false)), NOW)).toBeNull();
    expect(waitingPages(live((s) => void (s.agent.status = 'scanning')), NOW)).toBeNull();
  });
});

describe('waiting_page rows', () => {
  it('is waiting only when the agent says so', () => {
    expect(isWaitingPage({ matchKind: 'waiting_page' })).toBe(true);
    expect(isWaitingPage({ matchKind: null })).toBe(false);
    expect(isWaitingPage({} as Pick<DealRow, 'matchKind'>)).toBe(false);
  });
});
