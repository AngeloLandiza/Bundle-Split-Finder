// A scheduled scan that ran late, and why (Nov 25). A sleeping computer cannot scan, and the app cannot change that (it does not
// touch power settings: docs/decisions.md). When the app is back, the schedule's catch-up runs the missed scan once (core/src/
// schedule.ts nextRun), and the run's summary says what happened instead of nothing. Pure: the clock and the facts are handed in.

import type { Schedule } from '../schedule';

/** A scan later than this after its slot is a catch-up worth a sentence (Chrome's wait and a tick are well inside it). */
export const LATE_MS = 10 * 60_000;

/**
 * The slot a scheduled scan started for, when it is not the first run: the daily slot passed since the last run, or the
 * interval after it. Null for a manual schedule, a first run, or a scan that started before its slot.
 */
export function slotOf(schedule: Schedule, startedAt: number, lastRun: number | null): number | null {
  if (schedule.mode === 'manual' || lastRun === null) return null;
  if (schedule.mode === 'interval') {
    const slot = lastRun + schedule.hours * 3_600_000;
    return slot <= startedAt ? slot : null;
  }
  const [h, m] = schedule.at.split(':').map(Number) as [number, number];
  const today = new Date(startedAt);
  today.setHours(h, m, 0, 0);
  const slot = today.getTime();
  return startedAt >= slot && lastRun < slot ? slot : null;
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const day = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export interface CatchUpFacts {
  slot: number;
  startedAt: number;
  /** When this agent process started. */
  agentStartedAt: number;
  /** The scheduler's tick before the one that started the scan (epoch ms), or null when there was none. */
  previousTickAt: number | null;
  /** The scheduler ticks this often. */
  tickMs: number;
}

/**
 * "The 7:00 AM scan ran at 9:12 AM because the computer was asleep." The cause is named only when it is known: the app started
 * after the slot (it was not running), or its own clock stopped across the slot (the computer slept). Otherwise the sentence
 * says when, and nothing about why. Null when the scan was on time.
 */
export function catchUpSentence(f: CatchUpFacts): string | null {
  if (f.startedAt - f.slot < LATE_MS) return null;
  const sameDay = day(f.slot) === day(f.startedAt);
  const slotWords = `${clock(f.slot)}${sameDay ? '' : ` (${day(f.slot)})`}`;
  const base = `The ${slotWords} scan ran at ${clock(f.startedAt)}`;
  if (f.agentStartedAt > f.slot) return `${base} because Split Finder was not running at ${clock(f.slot)}.`;
  if (f.previousTickAt !== null && f.previousTickAt < f.slot && f.startedAt - f.previousTickAt > 3 * f.tickMs) return `${base} because the computer was asleep.`;
  return `${base}.`;
}
