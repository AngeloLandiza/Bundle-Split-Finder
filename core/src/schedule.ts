// How often a scan runs. The founder changes this in Settings; nothing here is hard-coded.
//
// A Chrome extension only runs while Chrome is open, so a missed run is caught
// up once when Chrome next starts. It never runs a backlog of missed scans.

export type Schedule =
  | { mode: 'manual' }
  | { mode: 'interval'; hours: number }
  | { mode: 'daily'; at: string }; // "HH:MM", local time

export const SCHEDULE_PRESETS: { label: string; schedule: Schedule }[] = [
  { label: 'Only when I click Scan', schedule: { mode: 'manual' } },
  { label: 'Every 6 hours', schedule: { mode: 'interval', hours: 6 } },
  { label: 'Every 12 hours', schedule: { mode: 'interval', hours: 12 } },
  { label: 'Once a day', schedule: { mode: 'daily', at: '07:00' } },
];

export function validateSchedule(s: Schedule): string | null {
  if (s.mode === 'interval' && !(Number.isFinite(s.hours) && s.hours >= 1 && s.hours <= 168)) {
    return 'Choose between 1 and 168 hours.';
  }
  if (s.mode === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) return 'Use a 24-hour time such as 07:00.';
  return null;
}

/** When the next automatic scan is due, or null for manual mode. */
export function nextRun(schedule: Schedule, now: Date, lastRun: Date | null): Date | null {
  if (schedule.mode === 'manual') return null;

  if (schedule.mode === 'interval') {
    if (!lastRun) return now;
    const due = new Date(lastRun.getTime() + schedule.hours * 3_600_000);
    return due <= now ? now : due;
  }

  const [h, m] = schedule.at.split(':').map(Number) as [number, number];
  const today = new Date(now);
  today.setHours(h, m, 0, 0);
  if (now >= today) {
    // Today's slot has passed. If nothing ran since, catch up once now.
    if (!lastRun || lastRun < today) return now;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }
  return today;
}

/** Automatic scans in a 30-day month. */
export function runsPerMonth(schedule: Schedule): number {
  if (schedule.mode === 'manual') return 0;
  if (schedule.mode === 'daily') return 30;
  return Math.floor((30 * 24) / schedule.hours);
}

export interface UsageForecast {
  /** Worst case: every automatic scan spends its full allowance. */
  searchesPerMonth: number;
  fitsPlan: boolean;
  /** The largest per-scan allowance that still fits the plan at this frequency. */
  maxPerRunThatFits: number;
}

/**
 * Worst-case searches a schedule can use in a month, against what the plan gives.
 * Shown next to the frequency setting so a frequency that cannot fit the plan is
 * visible before it is saved.
 */
export function forecastUsage(schedule: Schedule, maxPerRun: number, planPerMonth: number, reserve: number): UsageForecast {
  const runs = runsPerMonth(schedule);
  const usable = Math.max(0, planPerMonth - reserve);
  const searchesPerMonth = runs * maxPerRun;
  return {
    searchesPerMonth,
    fitsPlan: searchesPerMonth <= usable,
    maxPerRunThatFits: runs === 0 ? usable : Math.floor(usable / runs),
  };
}
