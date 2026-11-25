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

/** Nov 25: Keepa lookups by what found their candidates, and the tokens Keepa counted for each kind of request. */
export interface LookupWays {
  barcode: number;
  search: number;
  barcodeTokens: number;
  searchTokens: number;
  /** Code requests that found nothing the matcher keeps, so the search ran after them. */
  codeMisses: number;
}

export const NO_WAYS: LookupWays = { barcode: 0, search: 0, barcodeTokens: 0, searchTokens: 0, codeMisses: 0 };

/** The ways plus one Keepa lookup's (SearchResult fields): a barcode lookup's code and search tokens, or a plain search's. */
export function addLookupWay(
  w: LookupWays | undefined,
  r: { keepaTokens?: number; source: 'cache' | 'network'; barcode?: { via: 'code' | 'search'; codeTokens: number; searchTokens: number } },
): LookupWays {
  const base = w ?? NO_WAYS;
  const b = r.barcode;
  if (b) {
    return {
      barcode: base.barcode + (b.via === 'code' ? 1 : 0), search: base.search + (b.via === 'search' ? 1 : 0),
      barcodeTokens: base.barcodeTokens + b.codeTokens, searchTokens: base.searchTokens + b.searchTokens, codeMisses: base.codeMisses + (b.via === 'search' ? 1 : 0),
    };
  }
  return { ...base, search: base.search + 1, searchTokens: base.searchTokens + (r.source === 'network' ? (r.keepaTokens ?? 0) : 0) };
}

/** The sum of two tallies (a drip round's into its hour's run). */
export const sumWays = (a: LookupWays | undefined, b: LookupWays | undefined): LookupWays => ({
  barcode: (a?.barcode ?? 0) + (b?.barcode ?? 0), search: (a?.search ?? 0) + (b?.search ?? 0),
  barcodeTokens: (a?.barcodeTokens ?? 0) + (b?.barcodeTokens ?? 0), searchTokens: (a?.searchTokens ?? 0) + (b?.searchTokens ?? 0),
  codeMisses: (a?.codeMisses ?? 0) + (b?.codeMisses ?? 0),
});

/**
 * Nov 25: "Keepa lookups: 2 found by barcode, 4 by search; Keepa counted 3 tokens for barcodes (1 found nothing) and 40
 * for searches." The tokens are what Keepa's answers said. Empty when no lookup asked by barcode (nothing new to say
 * beside the lookup sentence).
 */
export function lookupWaysSentence(w: LookupWays | null | undefined): string {
  if (!w || (w.barcode === 0 && w.codeMisses === 0)) return '';
  const tokens = (n: number) => `${n} ${n === 1 ? 'token' : 'tokens'}`;
  const misses = w.codeMisses > 0 ? ` (${w.codeMisses} found nothing)` : '';
  return `Keepa lookups: ${w.barcode} found by barcode, ${w.search} by search; Keepa counted ${tokens(w.barcodeTokens)} for barcodes${misses} and ${tokens(w.searchTokens)} for searches.`;
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
