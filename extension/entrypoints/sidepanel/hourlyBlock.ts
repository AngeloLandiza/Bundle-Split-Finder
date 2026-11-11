import { when } from '../../lib/format';
import type { AppState } from '../../lib/messages';

/** Scan now waits only after the hourly limit stopped the last scan, and only until an hour has passed. */
export function hourlyBlockTitle(state: AppState, now: number): string | undefined {
  const job = state.lastJob;
  if (!job || job.status !== 'stopped' || job.stopReason !== 'hourly_limit' || job.finishedAt === null) return undefined;
  const until = job.finishedAt + 60 * 60_000;
  return until > now ? `The hourly search limit is reached. Try again after ${when(until, now).replace(/^in /, '')}.` : undefined;
}
