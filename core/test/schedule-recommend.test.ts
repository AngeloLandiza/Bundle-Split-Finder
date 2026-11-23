import { describe, expect, it } from 'vitest';

import { runsPerMonth, validateSchedule } from '../src/schedule';
import { CHROME_NO_KEEPA_SCAN_SEARCHES, HEADROOM, KEEPA_SCAN_SEARCHES, MIN_SCAN_INTERVAL_HOURS, NO_KEEPA_SCAN_SEARCHES, recommendSchedule, SCHEDULE_OPTIONS, typicalScanSearches } from '../src/schedule/recommend';

// Nov 23, 2026 at noon: 8 days left in the month, today included.
const NOV_23 = new Date(2026, 10, 23, 12, 0, 0);
const owner = { monthly: 250, reserve: 100, perScanCap: 18, now: NOV_23 };
const scan = (searchesUsed: number, status = 'finished', kind = 'scan') => ({ kind, status, searchesUsed });

describe('recommendSchedule on the owner\'s numbers (250 a month, reserve 100, cap 18)', () => {
  it('with Keepa: daily, 30 scans x 4 searches = 120, inside the 150 left after the reserve', () => {
    const r = recommendSchedule({ ...owner, hasKeepa: true });
    expect(r.option.id).toBe('daily');
    expect(r.option.schedule).toEqual({ mode: 'daily', at: '07:00' });
    expect(r.perScan).toBe(4);
    expect(r.perScanBasis).toBe('keepa');
    expect(r.usable).toBe(150);
    expect(r.option.searchesPerMonth).toBe(120);
    expect(r.sentence).toBe('Daily at 7:00. About 4 searches a scan, about 120 a month, inside your 150.');
    expect(r.arithmetic).toBe('30 scans × 4 searches = about 120 a month. Your plan gives 250 a month and the reserve keeps 100, so 150 are left to spend.');
  });

  it('without Keepa and no runs yet: 10 a scan, so twice a week (9 scans = 90)', () => {
    const r = recommendSchedule({ ...owner, hasKeepa: false });
    expect(r.perScan).toBe(NO_KEEPA_SCAN_SEARCHES);
    expect(r.perScanBasis).toBe('no-keepa');
    expect(r.option.id).toBe('twice-a-week');
    expect(r.option.searchesPerMonth).toBe(90);
    expect(r.option.schedule).toEqual({ mode: 'interval', hours: 84 });
  });

  it('never plans past the headroom of what is usable, whatever is chosen', () => {
    for (const hasKeepa of [true, false]) {
      for (const used of [1, 3, 5, 8, 12, 18]) {
        const r = recommendSchedule({ ...owner, hasKeepa, recentRuns: [scan(used), scan(used), scan(used)] });
        if (r.option.id === 'manual') continue;
        expect(r.option.searchesPerMonth).toBeLessThanOrEqual(r.usable * HEADROOM);
        expect(r.option.searchesPerMonth).toBeLessThanOrEqual(r.usable);
      }
    }
  });
});

describe('what a scan uses', () => {
  it('reads the median of recent finished or limited scans, newest first, at most five', () => {
    const t = typicalScanSearches({ hasKeepa: true, perScanCap: 18, recentRuns: [scan(5), scan(9, 'limit'), scan(3), scan(20), scan(4), scan(99)] });
    // 5, 9, 3, 20, 4 are the five newest: sorted 3 4 5 9 20, median 5.
    expect(t).toEqual({ perScan: 5, basis: 'recent' });
  });

  it('skips failed, stopped, running, zero-search and non-scan runs', () => {
    const runs = [scan(7, 'failed'), scan(7, 'stopped'), scan(7, 'running'), scan(0), scan(7, 'finished', 'lookup'), scan(Number.NaN)];
    expect(typicalScanSearches({ hasKeepa: true, perScanCap: 18, recentRuns: runs })).toEqual({ perScan: KEEPA_SCAN_SEARCHES, basis: 'keepa' });
  });

  it('is never above the per-scan cap and never below 1', () => {
    expect(typicalScanSearches({ hasKeepa: true, perScanCap: 3, recentRuns: [scan(12)] }).perScan).toBe(3);
    expect(typicalScanSearches({ hasKeepa: false, perScanCap: 6 }).perScan).toBe(6);
    expect(typicalScanSearches({ hasKeepa: true, perScanCap: 0 }).perScan).toBe(1);
  });

  it('a real history moves the schedule: 6 a scan is every 2 days, 15 x 6 = 90', () => {
    const r = recommendSchedule({ ...owner, hasKeepa: true, recentRuns: [scan(6), scan(6), scan(6)] });
    expect(r.perScanBasis).toBe('recent');
    expect(r.option.id).toBe('every-2-days');
    expect(r.option.searchesPerMonth).toBe(90);
  });
});

describe('a tight budget', () => {
  it('asks for less often as the plan or the usable searches shrink', () => {
    // 250 with reserve 200: 50 usable, 4 a scan: 12 scans fit, so twice a week (9 x 4 = 36 <= 42.5), not every 2 days (60).
    expect(recommendSchedule({ ...owner, reserve: 200, hasKeepa: true }).option.id).toBe('twice-a-week');
    // 250 with reserve 225: 25 usable, 21.25 planned: weekly (5 x 4 = 20).
    expect(recommendSchedule({ ...owner, reserve: 225, hasKeepa: true }).option.id).toBe('weekly');
  });

  it('a big plan allows twice a day', () => {
    const r = recommendSchedule({ ...owner, monthly: 1000, reserve: 100, hasKeepa: true });
    expect(r.option.id).toBe('twice-a-day');
    expect(r.option.searchesPerMonth).toBe(240);
  });

  it('says only when I press Scan now when not even a weekly scan fits, and never schedules on a reserve', () => {
    const r = recommendSchedule({ ...owner, reserve: 245, hasKeepa: true });
    expect(r.option.id).toBe('manual');
    expect(r.option.schedule).toEqual({ mode: 'manual' });
    expect(r.sentence).toContain('Only when I press Scan now');
    expect(r.arithmetic).toContain('one a week would use about 20 a month');
    // A reserve as large as the plan leaves nothing.
    expect(recommendSchedule({ ...owner, reserve: 250, hasKeepa: true }).option.id).toBe('manual');
    expect(recommendSchedule({ ...owner, reserve: 400, hasKeepa: true }).usable).toBe(0);
  });

  it('a month already mostly spent holds the schedule back for what is left of it', () => {
    // 160 left of 250 with a 100 reserve: 60 to spend in the 8 days left, 4 a scan. Daily would need 8 x 4 = 32 <= 51: fits.
    expect(recommendSchedule({ ...owner, hasKeepa: true, searchesLeft: 160 }).option.id).toBe('daily');
    // 110 left: 10 to spend, 8.5 planned: twice a week needs 3 scans x 4 = 12 in the 8 days left and fails; weekly 2 x 4 = 8 fits.
    const r = recommendSchedule({ ...owner, hasKeepa: true, searchesLeft: 110 });
    expect(r.option.id).toBe('weekly');
    // At or under the reserve: nothing is scheduled.
    expect(recommendSchedule({ ...owner, hasKeepa: true, searchesLeft: 100 }).option.id).toBe('manual');
    expect(recommendSchedule({ ...owner, hasKeepa: true, searchesLeft: 3 }).option.id).toBe('manual');
  });

  it('an unreadable plan uses the free 250', () => {
    expect(recommendSchedule({ ...owner, monthly: null, hasKeepa: true }).usable).toBe(150);
    expect(recommendSchedule({ ...owner, monthly: Number.NaN, hasKeepa: true }).usable).toBe(150);
  });
});

describe('the options', () => {
  it('are valid schedules, most frequent first, with the scans a month the forecast counts', () => {
    const counts = SCHEDULE_OPTIONS.map((o) => o.scansPerMonth);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    for (const o of SCHEDULE_OPTIONS) {
      expect(validateSchedule(o.schedule)).toBeNull();
      // Settings' forecast floors an interval's runs; ours round up, so ours are never fewer.
      expect(o.scansPerMonth).toBeGreaterThanOrEqual(runsPerMonth(o.schedule));
    }
  });

  it('are all listed with whether each fits', () => {
    const r = recommendSchedule({ ...owner, hasKeepa: true });
    expect(r.options.map((o) => [o.id, o.fits])).toEqual([
      ['twice-a-day', false],
      ['daily', true],
      ['every-2-days', true],
      ['twice-a-week', true],
      ['weekly', true],
      ['manual', true],
    ]);
  });
});

describe('the free scan (bundle lists read in Chrome)', () => {
  it('with Keepa a scan spends no search: every 3 hours while Chrome is open, bounded by Home Depot, not the budget', () => {
    // The owner's account today: 2 searches above the reserve, and recent scans that paid for listing pages.
    const r = recommendSchedule({ ...owner, hasKeepa: true, discovery: 'chrome', searchesLeft: 102, recentRuns: [scan(16), scan(3), scan(3)] });
    expect(r.option.id).toBe('every-3-hours');
    expect(r.option.schedule).toEqual({ mode: 'interval', hours: MIN_SCAN_INTERVAL_HOURS });
    expect(r.option.scansPerMonth).toBe(240);
    expect(r).toMatchObject({ perScan: 0, perScanBasis: 'chrome-keepa' });
    expect(r.option.searchesPerMonth).toBe(0);
    expect(r.sentence).toBe('Every 3 hours while Chrome is open. A scan spends no searches to find bundles: Home Depot\'s lists are read in Chrome and Amazon lookups go to Keepa first.');
    expect(r.arithmetic).toBe('Home Depot is read at most every 3 hours, so the schedule is set by that, not by searches. Your plan gives 250 a month and the reserve keeps 100, so 150 are left to spend. They go to confirming listings, the lookups you start, and a lookup Keepa cannot pay for (never the reserve).');
    // Every choice fits: none spends a search.
    expect(r.options.every((o) => o.fits)).toBe(true);
  });

  it('nothing more often than the politeness limit is offered', () => {
    const r = recommendSchedule({ ...owner, hasKeepa: true, discovery: 'chrome' });
    const hours = r.options.flatMap((o) => (o.schedule.mode === 'interval' ? [o.schedule.hours] : []));
    expect(Math.min(...hours)).toBe(MIN_SCAN_INTERVAL_HOURS);
  });

  it('without Keepa the lookups are still searches (about 6 a scan), so the budget decides again', () => {
    const r = recommendSchedule({ ...owner, hasKeepa: false, discovery: 'chrome' });
    expect(r).toMatchObject({ perScan: CHROME_NO_KEEPA_SCAN_SEARCHES, perScanBasis: 'chrome' });
    expect(CHROME_NO_KEEPA_SCAN_SEARCHES).toBe(6);
    // 15 scans × 6 = 90 fits the 127 of headroom; daily (180) does not.
    expect(r.option.id).toBe('every-2-days');
  });

  it('SerpApi discovery is unchanged: no 3-hour option, recent runs as before', () => {
    const r = recommendSchedule({ ...owner, hasKeepa: true, discovery: 'serpapi' });
    expect(r.options.map((o) => o.id)).toEqual(SCHEDULE_OPTIONS.map((o) => o.id));
    expect(r.option.id).toBe('daily');
  });
});
