// Nov 25, key stacking: the words for SerpApi's and Keepa's saved keys, each from its own account. Pure: Settings › Keys,
// Today, the sidebar's status line and the welcome step read the same words. A key's value is never here: the agent sends
// only its id, label, when it was added, its check and its own balance.

import type { AppState, KeyEntryView, StackedKeyName } from '../api/types';

const n = (x: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(x);
const SERVICE: Record<StackedKeyName, string> = { serpapi: 'SerpApi', keepa: 'Keepa' };

/** The saved keys of a service, in order; none when the agent has listed none. */
export function entriesOf(state: Pick<AppState, 'keyEntries'> | null, name: StackedKeyName): KeyEntryView[] {
  return state?.keyEntries?.[name] ?? [];
}

/** The help beside Add another key. Never suggests opening several free accounts; one plain sentence on the accounts' terms. */
export const ADD_ANOTHER_HELP: Record<StackedKeyName, string> = {
  serpapi:
    "A key from another account, for example your partner's or a paid plan. Its searches add to the total; your reserve and searches per scan apply to the total. You are responsible for keeping to each account's terms.",
  keepa:
    "A key from another account, for example your partner's or a paid plan. Its tokens add to the total; your Keepa reserve applies to the total. You are responsible for keeping to each account's terms.",
};

export type EntryTone = 'works' | 'rejected' | 'unknown';

/**
 * One key's check in words: "Accepted, 143 of 250 searches left this month", "Accepted, 300 tokens, 5 a minute", "Not
 * accepted. SerpApi did not accept this key.", or "Not checked yet".
 */
export function entryCheckWords(name: StackedKeyName, e: KeyEntryView): { tone: EntryTone; text: string } {
  if (e.check?.ok === false) return { tone: 'rejected', text: `Not accepted. ${e.check.problem ?? `${SERVICE[name]} did not accept this key.`}`.trim() };
  if (!e.check) return { tone: 'unknown', text: 'Not checked yet' };
  if (name === 'serpapi' && typeof e.searchesLeft === 'number') {
    const of = typeof e.searchesPerMonth === 'number' ? `${n(e.searchesLeft)} of ${n(e.searchesPerMonth)}` : n(e.searchesLeft);
    return { tone: 'works', text: `Accepted, ${of} ${e.searchesLeft === 1 && e.searchesPerMonth === null ? 'search' : 'searches'} left this month` };
  }
  if (name === 'keepa' && typeof e.tokensLeft === 'number') {
    const rate = typeof e.refillPerMin === 'number' && e.refillPerMin > 0 ? `, ${n(e.refillPerMin)} a minute` : '';
    return { tone: 'works', text: `Accepted, ${n(e.tokensLeft)} ${e.tokensLeft === 1 ? 'token' : 'tokens'}${rate}` };
  }
  return { tone: 'works', text: e.check.detail ? `Accepted, ${e.check.detail}` : 'Accepted' };
}

/** "Added Nov 25" (with the year when it is not this one); null for a key saved before key stacking, whose date was not kept. */
export function addedWords(addedAt: string | null, now = Date.now()): string | null {
  if (!addedAt) return null;
  const t = Date.parse(addedAt);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `Added ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}`;
}

/**
 * Each key's share after a total, where there is room (a tooltip, a second line): "Key 1 60 · Partner 143". A refused key
 * says so; a key not checked yet is left out. Null with one key or none.
 */
export function perKeySplit(state: Pick<AppState, 'keyEntries'> | null, name: StackedKeyName): string | null {
  const entries = entriesOf(state, name);
  if (entries.length < 2) return null;
  const parts = entries.flatMap((e) => {
    if (e.check?.ok === false) return [`${e.label} not accepted`];
    const v = name === 'serpapi' ? e.searchesLeft : e.tokensLeft;
    return typeof v === 'number' ? [`${e.label} ${n(v)}`] : [];
  });
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "across 3 keys": how many keys a total sums, for the line under it. Null with one key or none. */
export function acrossWords(state: Pick<AppState, 'keyEntries'> | null, name: StackedKeyName): string | null {
  const count = entriesOf(state, name).length;
  return count >= 2 ? `across ${count} keys` : null;
}

/** The Remove question for one key of several: what stops and what stays. */
export function removeEntryQuestion(name: StackedKeyName, label: string): string {
  return name === 'serpapi'
    ? `Remove SerpApi ${label}? Its searches no longer count; your other keys stay.`
    : `Remove Keepa ${label}? Its tokens no longer count; your other keys stay.`;
}
