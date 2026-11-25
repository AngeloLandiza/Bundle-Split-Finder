// Running without the owner (Nov 25): when Chrome is started for a scan, the Windows lookups, the catch-up sentence, what the next
// scan depends on, and the weekly message's schedule. Pure: a fake clock and plain facts, no process is started.

import { describe, expect, it } from 'vitest';

import { catchUpSentence, LATE_MS, slotOf } from '../src/selfRun/catchUp';
import {
  attemptSentence, CHROME_LEAD_MS, CHROME_WAIT_MS, type ChromeAttempt, type ChromeFacts, chromeSentence, chromeWanted, connectedSentence, mayScanWithoutChrome,
  PAGES_WAIT_MS, pathFromRegQuery, windowsChromeFolders,
} from '../src/selfRun/chrome';
import { lastWeeklyDue, weeklyDecision, weeklyOf } from '../src/selfRun/weekly';
import { nextScanNeeds } from '../src/selfRun/words';

const at = (h: number, m = 0, d = 25) => new Date(2026, 10, d, h, m).getTime();
const MIN = 60_000;

const base = (o: Partial<ChromeFacts> = {}): ChromeFacts => ({
  now: at(6, 56), setting: true, scheduled: true, paused: false, helperConnected: false, busy: false, nextScanAt: at(7), scanKey: 'scan:1',
  pagesWaitingSince: null, hdPausedUntil: null, today: '2026-11-25', last: undefined, ...o,
});

describe('chromeWanted', () => {
  it('opens Chrome a few minutes before a scheduled scan, not earlier', () => {
    expect(chromeWanted(base({ now: at(7) - CHROME_LEAD_MS - MIN }))).toBeNull();
    expect(chromeWanted(base({ now: at(7) - CHROME_LEAD_MS }))).toEqual({ reason: 'scan', key: 'scan:1' });
  });

  it('opens it at once for a scan that is overdue (the catch-up)', () => {
    expect(chromeWanted(base({ now: at(9, 12), nextScanAt: at(9, 12) }))).toEqual({ reason: 'scan', key: 'scan:1' });
  });

  it('never when the helper is connected, and never without the setting, a schedule, or while paused or busy', () => {
    expect(chromeWanted(base({ helperConnected: true }))).toBeNull();
    expect(chromeWanted(base({ setting: false }))).toBeNull();
    expect(chromeWanted(base({ scheduled: false, nextScanAt: null }))).toBeNull();
    expect(chromeWanted(base({ paused: true }))).toBeNull();
    expect(chromeWanted(base({ busy: true }))).toBeNull();
  });

  it('only once for the same scan, and again for the next one', () => {
    const last: ChromeAttempt = { key: 'scan:1', reason: 'scan', at: at(6, 55), result: 'started', weStarted: true };
    expect(chromeWanted(base({ last }))).toBeNull();
    expect(chromeWanted(base({ last, scanKey: 'scan:2' }))).toEqual({ reason: 'scan', key: 'scan:2' });
  });

  it('for waiting Home Depot pages: after the stated wait, once a day, not while Home Depot has paused reading, not next to a scan', () => {
    const f = (o: Partial<ChromeFacts>) => base({ now: at(15), nextScanAt: at(7, 0, 26), pagesWaitingSince: at(15) - PAGES_WAIT_MS, ...o });
    expect(chromeWanted(f({}))).toEqual({ reason: 'pages', key: 'pages:2026-11-25' });
    expect(chromeWanted(f({ pagesWaitingSince: at(15) - PAGES_WAIT_MS + MIN }))).toBeNull();
    expect(chromeWanted(f({ last: { key: 'pages:2026-11-25', reason: 'pages', at: at(14), result: 'started', weStarted: true } }))).toBeNull();
    expect(chromeWanted(f({ hdPausedUntil: at(16) }))).toBeNull();
    // Close to a scan the scan's own start is the one that counts, never a second one for the pages.
    expect(chromeWanted(f({ now: at(6, 40), nextScanAt: at(7), last: { key: 'scan:1', reason: 'scan', at: at(6, 40), result: 'started', weStarted: true } }))).toBeNull();
  });
});

describe('a scan that waits for Chrome', () => {
  const started: ChromeAttempt = { key: 'scan:1', reason: 'scan', at: at(6, 55), result: 'started', weStarted: true };

  it('goes on without it only after the app tried and the wait is over, or the start failed', () => {
    expect(mayScanWithoutChrome(undefined, 'scan:1', at(7), false)).toBe(false);
    expect(mayScanWithoutChrome(started, 'scan:1', started.at + CHROME_WAIT_MS - 1, false)).toBe(false);
    expect(mayScanWithoutChrome(started, 'scan:1', started.at + CHROME_WAIT_MS, false)).toBe(true);
    expect(mayScanWithoutChrome(started, 'scan:1', started.at + CHROME_WAIT_MS, true)).toBe(false);
    expect(mayScanWithoutChrome({ ...started, result: 'failed' }, 'scan:1', started.at + 1, false)).toBe(true);
    // An attempt for another scan says nothing about this one.
    expect(mayScanWithoutChrome(started, 'scan:2', started.at + CHROME_WAIT_MS, false)).toBe(false);
  });

  it('says it once, in plain words, for each way it went wrong', () => {
    expect(chromeSentence({ ...started, result: 'failed', why: 'Chrome was not found on this computer.' }, 'scan:1')).toBe('Chrome did not open, so Home Depot pages wait.');
    expect(chromeSentence(started, 'scan:1')).toBe('Chrome opened, but the Split Finder helper did not connect, so Home Depot pages wait.');
    expect(chromeSentence({ ...started, weStarted: false }, 'scan:1')).toBe('Chrome is open, but the Split Finder helper did not connect, so Home Depot pages wait.');
    expect(chromeSentence(undefined, 'scan:1')).toBeNull();
    expect(chromeSentence(started, 'scan:2')).toBeNull();
  });

  it('Activity lines for the start, the failure and the connection', () => {
    expect(attemptSentence(started, '7:00 AM')).toBe('Opened Chrome in the background for the 7:00 AM scan, and waited for the Split Finder helper. It is your own Chrome and profile.');
    expect(attemptSentence({ ...started, result: 'failed', why: 'Chrome was not found on this computer.' }, null)).toBe('Chrome could not be opened for a scheduled scan: Chrome was not found on this computer.');
    expect(connectedSentence({ ...started, connectedAt: started.at + 40_000 })).toBe('The Split Finder helper connected 40 seconds after Chrome was opened.');
    expect(connectedSentence({ ...started, connectedAt: started.at + 3 * MIN })).toBe('The Split Finder helper connected 3 minutes after Chrome was opened.');
  });
});

describe('where Windows keeps chrome.exe', () => {
  it('the standard folders from the environment, once each', () => {
    expect(windowsChromeFolders({ ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local', ProgramW6432: 'C:\\Program Files' })).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
    expect(windowsChromeFolders({})).toEqual([]);
  });

  it('the path in reg query output, only when it is a chrome.exe', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n    Path    REG_SZ    C:\\x\r\n';
    expect(pathFromRegQuery(out)).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(pathFromRegQuery('    (Default)    REG_SZ    C:\\Windows\\notepad.exe')).toBeNull();
    expect(pathFromRegQuery('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});

describe('a scan that ran late', () => {
  const daily = { mode: 'daily', at: '07:00' } as const;
  const base = { agentStartedAt: at(6), tickMs: 30_000 };

  it('the slot is the daily time passed since the last run, or the interval after it', () => {
    expect(slotOf(daily, at(9, 12), at(6))).toBe(at(7));
    expect(slotOf(daily, at(9, 12), at(7, 1))).toBeNull();
    expect(slotOf(daily, at(6, 59), at(6))).toBeNull();
    expect(slotOf(daily, at(9, 12), null)).toBeNull();
    expect(slotOf({ mode: 'manual' }, at(9, 12), at(6))).toBeNull();
    expect(slotOf({ mode: 'interval', hours: 6 }, at(14, 5), at(7, 59))).toBe(at(13, 59));
  });

  it('asleep: the app\'s own clock stopped across the slot', () => {
    expect(catchUpSentence({ ...base, slot: at(7), startedAt: at(9, 12), previousTickAt: at(6, 59, 25) })).toBe('The 7:00 AM scan ran at 9:12 AM because the computer was asleep.');
  });

  it('not running: the app started after the slot', () => {
    expect(catchUpSentence({ ...base, agentStartedAt: at(9, 10), slot: at(7), startedAt: at(9, 12), previousTickAt: null })).toBe('The 7:00 AM scan ran at 9:12 AM because Split Finder was not running at 7:00 AM.');
  });

  it('late with the app running and awake: when, and no cause; on time: nothing; another day: its date', () => {
    expect(catchUpSentence({ ...base, slot: at(7), startedAt: at(7, 25), previousTickAt: at(7, 24) })).toBe('The 7:00 AM scan ran at 7:25 AM.');
    expect(catchUpSentence({ ...base, slot: at(7), startedAt: at(7) + LATE_MS - 1, previousTickAt: at(7) })).toBeNull();
    expect(catchUpSentence({ ...base, agentStartedAt: at(6, 0, 20), slot: at(7, 0, 24), startedAt: at(9, 12), previousTickAt: at(6, 59, 24) })).toBe('The 7:00 AM (Nov 24) scan ran at 9:12 AM because the computer was asleep.');
  });
});

describe('what the next scan depends on', () => {
  const f = { coming: true, paired: true, connected: false, openChrome: true, waitsForChrome: true };
  it('nothing is said when the helper is connected or no scan is coming', () => {
    expect(nextScanNeeds({ ...f, connected: true })).toBeNull();
    expect(nextScanNeeds({ ...f, coming: false })).toBeNull();
  });
  it('says what is missing and what happens about it', () => {
    expect(nextScanNeeds(f)).toMatch(/^Needs Chrome, which is closed\. Split Finder opens it a few minutes before the scan; if it does not open/);
    expect(nextScanNeeds({ ...f, openChrome: false })).toMatch(/waits until you open it\. Turn on Open Chrome for scheduled scans/);
    expect(nextScanNeeds({ ...f, paired: false })).toMatch(/helper, which is not connected yet/);
    expect(nextScanNeeds({ ...f, waitsForChrome: false })).toMatch(/^Chrome is closed\. Split Finder opens it/);
  });
});

describe('the weekly time', () => {
  const monday8 = { day: 1, at: '08:00' };
  it('defaults to Monday 8:00 and ignores values it cannot use', () => {
    expect(weeklyOf(undefined)).toEqual(monday8);
    expect(weeklyOf({ weekly: { day: 9, at: '8am' } })).toEqual(monday8);
    expect(weeklyOf({ weekly: { day: 5, at: '17:30' } })).toEqual({ day: 5, at: '17:30' });
  });

  it('the latest moment at or before now', () => {
    // Nov 25, 2026 is a Wednesday; the Monday before is Nov 23.
    expect(lastWeeklyDue(at(10), monday8)).toBe(at(8, 0, 23));
    expect(lastWeeklyDue(at(8, 0, 23), monday8)).toBe(at(8, 0, 23));
    expect(lastWeeklyDue(at(7, 59, 23), monday8)).toBe(at(8, 0, 16));
  });

  it('the first look only seeds; then one message per Monday, and not again before the next', () => {
    const seed = weeklyDecision(at(10), monday8, undefined);
    expect(seed).toEqual({ action: 'seed', sent: { key: '2026-11-23', at: at(10) } });
    if (seed.action !== 'seed') throw new Error('seed');
    expect(weeklyDecision(at(10, 30), monday8, seed.sent)).toEqual({ action: 'none' });
    expect(weeklyDecision(at(7, 59, 30), monday8, seed.sent)).toEqual({ action: 'none' });
    const due = weeklyDecision(at(8, 1, 30), monday8, seed.sent);
    expect(due).toEqual({ action: 'send', key: '2026-11-30', from: at(10) });
    // Sent: not again that day, nor on Tuesday.
    const sent = { key: '2026-11-30', at: at(8, 1, 30) };
    expect(weeklyDecision(at(9, 0, 30), monday8, sent)).toEqual({ action: 'none' });
    expect(weeklyDecision(at(12, 0, 1), monday8, sent)).toEqual({ action: 'none' });
  });

  it('a message that came late covers at most the last seven days', () => {
    const d = weeklyDecision(at(12), monday8, { key: '2026-11-16', at: at(8, 0, 16) });
    expect(d).toMatchObject({ action: 'send', key: '2026-11-23' });
    expect(d.action === 'send' && d.from).toBe(at(12) - 7 * 86_400_000);
  });
});
