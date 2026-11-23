// The one notice Deals shows when parts wait for an Amazon lookup, and the one action beside it (docs/ux-checklist.md:
// one notice, no per-row buttons; Nielsen heuristic 1, say why). The words follow the agent's `lookupsBlockedBy` and
// `drip`; nothing here guesses a cause the agent did not name. Pure: Deals only draws it.

import type { AppState, DealRow, LookupBlock } from '../api/types';
import { count, plural } from './format';

/** What one Keepa lookup costs in tokens (a search is 10, recorded: docs/superpowers/plans/2026-11-23-step-15-real-run-fixes.md). */
export const KEEPA_LOOKUP_TOKENS = 10;

export interface LookupNotice {
  /** "18 parts are waiting for an Amazon lookup." */
  title: string;
  /** Why they wait and what happens next, in one or two sentences. */
  text: string;
  action: {
    label: string;
    /** "up to 5 searches"; null when none would be spent, or when the label already says it. */
    cost: string | null;
    /** The ceiling sent with the request. */
    maxSearches: number;
    /** The owner's explicit yes to spend from the reserve: sent only by "Use searches for these", at or below it. */
    useReserve: boolean;
    enabled: boolean;
    /** Why it is greyed, said on screen. */
    reason: string | null;
  };
}

/** Parts waiting: the scan's own count, else the drip's, else the rows that say they wait. Null when the agent says nothing. */
export function waitingLookups(state: AppState | null, rows: readonly DealRow[] | null): number | null {
  const fromScan = state?.agent.lastScan?.waitingLookups;
  const drip = state?.agent.drip;
  if (drip?.active) return drip.waiting;
  if (typeof fromScan === 'number') return fromScan;
  if (drip) return drip.waiting;
  if (rows) return rows.filter((r) => r.lookup !== null).length;
  return null;
}

/** Lookups an hour Keepa's refill pays for ("about 6 an hour"), or null when the agent has not said the rate. */
export function keepaLookupsPerHour(refillPerMin: number | null | undefined): number | null {
  if (typeof refillPerMin !== 'number' || !Number.isFinite(refillPerMin) || refillPerMin <= 0) return null;
  const n = Math.floor((refillPerMin * 60) / KEEPA_LOOKUP_TOKENS);
  return n >= 1 ? n : null;
}

/** Searches a "Look up now" may spend: the per-scan cap, and what is left above the reserve. 0 when none. Null when searches are not checked yet. */
export function searchesAvailable(b: AppState['budget']): number | null {
  if (b.serpLeft === null) return null;
  const aboveReserve = Math.max(0, b.serpLeft - b.serpReserve);
  return b.serpPerScan > 0 ? Math.min(b.serpPerScan, aboveReserve) : aboveReserve;
}

const BLOCK_WHY: Record<LookupBlock, string> = {
  keepa_tokens: 'Keepa has no tokens to spare right now.',
  search_cap: 'The last scan reached its search limit for one scan.',
  reserve: 'Your searches are down to the reserve you keep.',
  hourly_limit: 'SerpApi’s hourly limit was reached.',
};

/** The notice for waiting lookups, or null when none wait. */
export function lookupNotice(state: AppState | null, rows: readonly DealRow[] | null): LookupNotice | null {
  if (!state) return null;
  const n = waitingLookups(state, rows);
  if (!n || n <= 0) return null;
  const { budget, agent, keys } = state;
  const perHour = keys.keepa ? keepaLookupsPerHour(budget.keepaRefillPerMin) : null;
  const blocked = agent.lastScan?.lookupsBlockedBy ?? null;
  const drip = agent.drip;
  const dripping = drip?.active === true || (keys.keepa && drip !== undefined);

  const parts: string[] = [];
  if (blocked) parts.push(BLOCK_WHY[blocked]);
  if (keys.keepa && (dripping || blocked === 'keepa_tokens')) {
    parts.push(perHour ? `Keepa looks them up as its tokens refill (about ${perHour} an hour).` : 'Keepa looks them up as its tokens refill.');
  } else if (!keys.keepa) {
    parts.push('Add a Keepa key in Settings › Keys and they fill in by themselves; or look some up now with searches.');
  }
  if (blocked === 'hourly_limit') parts.push('Searches continue after the hour.');
  const text = parts.join(' ') || 'They are looked up with the next scan, or now.';

  const available = searchesAvailable(budget);
  const running = agent.status === 'scanning' || agent.status === 'asking' || agent.status === 'stopping';
  const cap = available === null ? 0 : Math.min(available, n);
  // Nov 23: at or below the reserve the one action is the owner's explicit yes to spend from it, within the per-scan limit.
  const atReserve = budget.serpLeft !== null && budget.serpLeft <= budget.serpReserve;
  const reserveCap = budget.serpLeft === null ? 0 : Math.min(Math.max(0, budget.serpPerScan), n, budget.serpLeft);
  let reason: string | null = null;
  if (running) reason = 'A scan is running. Look up when it has finished.';
  else if (!keys.serpapi) reason = 'Add your SerpApi key in Settings › Keys first.';
  else if (available === null) reason = 'Searches are not checked yet.';
  else if (atReserve && reserveCap <= 0) reason = budget.serpLeft === 0 ? 'No searches are left.' : 'The limit per scan in Settings is 0.';
  else if (available <= 0 && !atReserve) reason = 'The limit per scan in Settings is 0.';
  const title = `${plural(n, 'part is', 'parts are')} waiting for an Amazon lookup.`;
  if (atReserve) {
    return {
      title,
      text: `${text} Your searches are at your reserve of ${count(budget.serpReserve)}, so nothing was spent. Searches from the reserve are spent only when you choose.`,
      action: {
        label: `Use searches for these (up to ${count(reserveCap)} of your ${count(budget.serpLeft ?? 0)} left)`,
        cost: null, maxSearches: reserveCap, useReserve: true, enabled: reason === null, reason,
      },
    };
  }
  return {
    title,
    text,
    action: { label: 'Look up now', cost: cap > 0 ? `up to ${plural(cap, 'search', 'searches')}` : null, maxSearches: cap, useReserve: false, enabled: reason === null, reason },
  };
}

/** What a started run says it did, for the line after the press. */
export function lookupsStartedWords(r: { started: boolean; reason?: string; viaKeepa: number; viaSerpapi: number }): string {
  if (!r.started) return r.reason ?? 'The agent did not start looking up. Try again in a moment.';
  const bits: string[] = [];
  if (r.viaKeepa > 0) bits.push(`${plural(r.viaKeepa, 'part', 'parts')} through Keepa`);
  if (r.viaSerpapi > 0) bits.push(`${plural(r.viaSerpapi, 'part', 'parts')} through ${plural(r.viaSerpapi, 'search', 'searches')}`);
  return bits.length ? `Looking up ${bits.join(' and ')}. Results appear here as they arrive.` : 'Looking up. Results appear here as they arrive.';
}
