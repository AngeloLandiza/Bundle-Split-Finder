import { when } from '../../lib/format';
import type { AppState } from '../../lib/messages';

/** "Try again after 40 min.", or "Try again now." once less than a minute is left. */
export function tryAgain(until: number, now: number): string {
  return until - now < 60_000 ? 'Try again now.' : `Try again after ${when(until, now).replace(/^in /, '')}.`;
}

/** Scan now waits only after the hourly limit stopped the last scan, and only until an hour has passed. */
export function hourlyBlockTitle(state: AppState, now: number): string | undefined {
  const job = state.lastJob;
  if (!job || job.status !== 'stopped' || job.stopReason !== 'hourly_limit' || job.finishedAt === null) return undefined;
  const until = job.finishedAt + 60 * 60_000;
  return until > now ? `The hourly search limit is reached. ${tryAgain(until, now)}` : undefined;
}
