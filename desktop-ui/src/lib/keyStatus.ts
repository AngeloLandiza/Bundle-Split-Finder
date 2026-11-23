// What the app says about a saved key. A key the service did not accept is saved but not working: the agent says why
// in `keyProblems`, and nothing on screen may call that key fine (docs/ux-checklist.md, item 4 of the eight: say what is
// true). Pure: Settings, the sidebar and Deals read the same words.

import type { AppState, KeyName } from '../api/types';

export const KEY_LABEL: Record<KeyName, string> = {
  serpapi: 'SerpApi',
  keepa: 'Keepa',
  anthropic: 'Anthropic',
  openai: 'OpenAI-compatible',
  ebay: 'eBay',
  telegram: 'Telegram',
};

export type KeyState = 'missing' | 'saved' | 'rejected';

/** A key's state, and the agent's sentence when it is rejected. A problem for a key that is not saved is stale and ignored. */
export function keyState(state: Pick<AppState, 'keys' | 'keyProblems'> | null, name: KeyName): { state: KeyState; problem: string | null } {
  if (!state || !state.keys[name]) return { state: 'missing', problem: null };
  const problem = state.keyProblems?.[name]?.trim() || null;
  return problem ? { state: 'rejected', problem } : { state: 'saved', problem: null };
}

/** The saved keys a service rejected, in the order the Keys pane lists them. */
export function rejectedKeys(state: Pick<AppState, 'keys' | 'keyProblems'> | null): KeyName[] {
  return (Object.keys(KEY_LABEL) as KeyName[]).filter((n) => keyState(state, n).state === 'rejected');
}

/** "eBay key not accepted" for one, "2 keys not accepted" for more; the sidebar's one line. Null when none. */
export function rejectedKeysWords(state: Pick<AppState, 'keys' | 'keyProblems'> | null): string | null {
  const names = rejectedKeys(state);
  if (names.length === 0) return null;
  return names.length === 1 ? `${KEY_LABEL[names[0]!]} key not accepted` : `${names.length} keys not accepted`;
}

/** "Keepa 57 tokens · 1 a minute", only when a Keepa key is saved and the agent has said its tokens. */
/** "24 fee lookups waiting": the Keepa pulls that fill in Amazon's fulfillment fee, when the agent says some wait. */
export function feeLookupWords(drip: { feesWaiting?: number } | undefined): string | null {
  const n = drip?.feesWaiting ?? 0;
  return n > 0 ? `${new Intl.NumberFormat('en-US').format(n)} fee ${n === 1 ? 'lookup' : 'lookups'} waiting` : null;
}

export function keepaWords(state: Pick<AppState, 'keys' | 'budget'> | null): string | null {
  if (!state || !state.keys.keepa || state.budget.keepaTokens === null) return null;
  const tokens = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(state.budget.keepaTokens);
  const rate = state.budget.keepaRefillPerMin;
  const rateWords = typeof rate === 'number' && rate > 0 ? ` · ${rate} a minute` : '';
  return `Keepa ${tokens} ${state.budget.keepaTokens === 1 ? 'token' : 'tokens'}${rateWords}`;
}
