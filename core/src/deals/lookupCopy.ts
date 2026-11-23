// Step 15, decision 2: the one sentence that says what happened to a scan's Amazon lookups and, when some wait, the real
// cause: Keepa's tokens (which refill), the per-scan search limit, the monthly reserve or SerpApi's hourly limit.
// Never "search limit" for a Keepa cause. Read by the scan's Activity summary, the Deals notice and the drip's run.

import type { LookupBlock } from '../keepa/route';

export interface LookupFacts {
  /** Lookups left waiting. */
  waiting: number;
  /** Lookups done, by what paid for them. */
  keepa: number;
  serpapi: number;
  blockedBy: LookupBlock | null | undefined;
  /** Keepa's refill, tokens a minute, when known (recorded: 1). */
  refillPerMin?: number | null;
}

const lookups = (n: number) => `${n} Amazon ${n === 1 ? 'lookup' : 'lookups'}`;

/** Why the waiting lookups wait, after "wait" / "waits". */
export function waitCause(blockedBy: LookupBlock | null | undefined, refillPerMin?: number | null): string {
  switch (blockedBy) {
    case 'keepa_tokens':
      return refillPerMin && refillPerMin > 0 ? `for Keepa tokens (${refillPerMin} a minute)` : 'for Keepa tokens';
    case 'search_cap':
      return "for the next scan: this scan used its search limit";
    case 'reserve':
      return 'for searches: more would dip into your monthly reserve';
    case 'hourly_limit':
      return "for SerpApi's hourly limit to reset";
    default:
      return 'for the next scan';
  }
}

/** "with Keepa", "with searches", "with Keepa and 2 with searches" — what paid for the lookups done. */
function doneWith(keepa: number, serpapi: number): string {
  if (keepa > 0 && serpapi > 0) return `${keepa} ${keepa === 1 ? 'was' : 'were'} done with Keepa and ${serpapi} with searches`;
  if (keepa > 0) return `${keepa} ${keepa === 1 ? 'was' : 'were'} done with Keepa`;
  return `${serpapi} ${serpapi === 1 ? 'was' : 'were'} done with searches`;
}

/**
 * "12 Amazon lookups wait for Keepa tokens (1 a minute); 6 were done with searches." When none waits: "18 Amazon lookups
 * done: 4 with Keepa, 14 with searches." Empty when there were none.
 */
export function lookupsSentence(f: LookupFacts): string {
  const done = f.keepa + f.serpapi;
  if (f.waiting > 0) {
    const head = `${lookups(f.waiting)} ${f.waiting === 1 ? 'waits' : 'wait'} ${waitCause(f.blockedBy, f.refillPerMin)}`;
    return done > 0 ? `${head}; ${doneWith(f.keepa, f.serpapi)}.` : `${head}.`;
  }
  if (done === 0) return '';
  const by = [...(f.keepa > 0 ? [`${f.keepa} with Keepa`] : []), ...(f.serpapi > 0 ? [`${f.serpapi} with searches`] : [])].join(', ');
  return `${lookups(done)} done: ${by}.`;
}
