// The one place that turns the agent's match-state sentence ("2 title matches", "1 part with no listing · 1 to verify") into a
// reseller's words, so the Deals table, the row's reason line and the inspector say the same thing. The agent's sentence is
// core's `matchState` (core/src/scan/matchState.ts): it is read, never reworded by guess; a sentence this does not know is
// returned as the agent wrote it (CLAUDE.md rule 4: no heuristic turns an unknown case into a confident one).
//
// Vocabulary (docs/design.md, Words): a listing is *confirmed* when the app checked it, *not confirmed yet* when only the
// title matched, *not for sale right now* when Amazon shows it inactive, and a part has *no Amazon listing* when a lookup
// found none. "Match", "title match", "verify" and "inactive" are the code's words, not his.

import type { Grade } from '../api/types';

const parts = (n: number): string => `${n} ${n === 1 ? 'part' : 'parts'}`;
const listings = (n: number): string => `${n} ${n === 1 ? 'listing' : 'listings'}`;

/** "1 of 2 listings" when the bundle's part count is known (the inspector), "1 listing" when it is not (a table row). */
const ofTotal = (n: number, total: number | undefined): string => (total && total >= n && total > 1 ? `${n} of ${total} listings` : listings(n));

export interface MatchOptions {
  /** How many parts the bundle has, when the caller knows (the inspector does; a table row does not). */
  total?: number;
}

/** What each of the agent's sentences means, by pattern. Order matters only where two could match: the combined one is first. */
export function matchWords(state: string | null, o: MatchOptions = {}): string | null {
  if (state === null) return null;
  const s = state.trim();
  let m: RegExpMatchArray | null;

  // "1 part with no listing · 1 to verify": a part with no Amazon listing, and listings still to confirm.
  if ((m = s.match(/^(\d+) parts? with no listing · (\d+) to verify$/))) return `${noListing(Number(m[1]))} · ${notConfirmed(Number(m[2]), o.total)}`;
  if ((m = s.match(/^(\d+) parts? with no listing$/))) return noListing(Number(m[1]));
  if ((m = s.match(/^(\d+) title match(?:es)?$/))) return notConfirmed(Number(m[1]), o.total);
  if ((m = s.match(/^(\d+) parts? to verify$/))) return notConfirmed(Number(m[1]), o.total);
  if ((m = s.match(/^(\d+) parts? matched$/))) {
    const n = Number(m[1]);
    return n === 1 ? 'Its part is on a confirmed listing' : `All ${n} parts on confirmed listings`;
  }
  if ((m = s.match(/^(\d+) listings? inactive$/))) {
    const n = Number(m[1]);
    return n === 1 ? '1 listing is not for sale right now' : `${n} listings are not for sale right now`;
  }
  if ((m = s.match(/^(\d+) parts? to look up$/))) return `${parts(Number(m[1]))} waiting for an Amazon lookup`;
  if ((m = s.match(/^(\d+) parts? unknown$/))) return `${parts(Number(m[1]))} not looked up on Amazon yet`;
  if (s === 'No bundle price') return 'Home Depot shows no price for it';
  return s;
}

function noListing(n: number): string {
  return n === 1 ? '1 part has no Amazon listing' : `${n} parts have no Amazon listing`;
}

function notConfirmed(n: number, total: number | undefined): string {
  return `${ofTotal(n, total)} not confirmed yet`;
}

/** A part's own state in the inspector, in the same words (Grade is the agent's per-part state). */
export const PART_STATE_WORDS: Record<Grade, string> = {
  verified: 'Confirmed listing',
  title_match: 'Not confirmed yet',
  needs_answer: 'Needs your answer',
  inactive: 'Not for sale right now',
  missing: 'No Amazon listing',
  not_looked_up: 'Not looked up yet',
};

/** The sentence under the verdict in the inspector: how many of the parts sit on a confirmed Amazon listing. */
export function partsSummary(grades: readonly Grade[]): string | null {
  if (grades.length === 0) return null;
  const n = grades.length;
  const count = (g: Grade): number => grades.filter((x) => x === g).length;
  const verified = count('verified');
  if (verified === n) return n === 1 ? 'Its part is on a confirmed Amazon listing.' : `All ${n} parts are on confirmed Amazon listings.`;
  const bits: string[] = [];
  if (verified > 0) bits.push(`${verified} of ${n} parts on a confirmed listing`);
  const notYet = count('title_match') + count('needs_answer');
  if (notYet > 0) bits.push(`${notYet} not confirmed yet`);
  const none = count('missing');
  if (none > 0) bits.push(none === 1 ? '1 has no Amazon listing' : `${none} have no Amazon listing`);
  const off = count('inactive');
  if (off > 0) bits.push(off === 1 ? '1 is not for sale right now' : `${off} are not for sale right now`);
  const waiting = count('not_looked_up');
  if (waiting > 0) bits.push(`${waiting} not looked up yet`);
  const first = bits[0]!;
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}${bits.length > 1 ? `; ${bits.slice(1).join('; ')}` : ''}.`;
}
