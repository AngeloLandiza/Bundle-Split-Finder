import type { BundleRow, ScanJob } from '../scan/types';

import { lookupsSentence } from './lookupCopy';
import { lookupsWaiting } from './waiting';

const HOUR = 60 * 60_000;

export type LimitJob = Pick<
  ScanJob,
  'status' | 'stopReason' | 'stopMessage' | 'searchesUsed' | 'finishedAt' | 'deferred'
> & Partial<Pick<ScanJob, 'lookupsVia' | 'lookupsWaiting' | 'lookupsBlockedBy'>>;

export type LimitContext = {
  lastJob: LimitJob | null;
  searchesPerScan: number;
  rateLimitPerHour: number | null;
  now: number;
  /** Step 15: Keepa's refill, tokens a minute, from its last token status (recorded: 1). */
  keepaRefillPerMin?: number | null;
};

function tryAgain(until: number, now: number): string {
  return until - now < 60_000 ? 'Try again now.' : `Try again after ${Math.ceil((until - now) / 60_000)} min.`;
}

/** Title and sentence when the last scan stopped at a limit; null otherwise. */
export function limitCopy(ctx: LimitContext, bundles: BundleRow[]): { title: string; text: string; limit: boolean } | null {
  const job = ctx.lastJob;
  if (!job || job.status !== 'stopped') return null;
  const k = lookupsWaiting(job, bundles);
  const waiting = () => (k === 0 ? '' : ` ${k} ${k === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup.`);
  const n = ctx.searchesPerScan;
  switch (job.stopReason) {
    case 'user':
      return { title: 'You stopped the last scan', text: `Scan now picks up where it left off.${waiting()}`, limit: false };
    case 'run_cap': {
      const noun = n === 1 ? 'search' : 'searches';
      const used = job.searchesUsed === n ? `the ${n} ${noun}` : `${job.searchesUsed} of the ${n} ${noun}`;
      return { title: 'Scan stopped at your search limit', text: `It used ${used} allowed per scan.${waiting()}`, limit: true };
    }
    case 'keepa_tokens': {
      // Step 15: never "search limit" for a Keepa cause.
      const via = job.lookupsVia ?? { keepa: 0, serpapi: 0 };
      const sentence = lookupsSentence({ waiting: k, keepa: via.keepa, serpapi: via.serpapi, blockedBy: 'keepa_tokens', refillPerMin: ctx.keepaRefillPerMin });
      return {
        title: 'Amazon lookups wait for Keepa tokens',
        text: k === 0 ? 'Keepa refills its tokens over time; the next lookups run as it does.' : `${sentence} They run as Keepa refills, between scans or at the next scan.`,
        limit: true,
      };
    }
    case 'reserve':
      return {
        title: 'Scan stopped at your reserve',
        text: `The rest of this month's searches are kept for scans you start yourself.${waiting()}`,
        limit: true,
      };
    case 'hourly_limit': {
      const until = (job.finishedAt ?? ctx.now) + HOUR;
      const again = tryAgain(until, ctx.now);
      const limit = ctx.rateLimitPerHour;
      return {
        title: 'Scan stopped at the hourly limit',
        text: limit ? `SerpApi allows ${limit} searches an hour. ${again}` : again,
        limit: true,
      };
    }
    default:
      return null;
  }
}