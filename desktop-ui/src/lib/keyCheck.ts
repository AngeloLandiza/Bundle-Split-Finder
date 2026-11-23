// What Settings, Keys says about a key's check (agent/keyChecks.ts): the line under a saved key, and the eBay shape hints.
// Pure: the Keys pane and the welcome sheet's SerpApi step read the same words.

import type { AppState, KeyCheck, KeyName } from '../api/types';
import { when } from './format';

/** The service as a sentence names it: "Checking with eBay…". */
export const SERVICE_NAME: Record<KeyName, string> = {
  serpapi: 'SerpApi',
  keepa: 'Keepa',
  anthropic: 'Anthropic',
  openai: 'the model service',
  ebay: 'eBay',
  telegram: 'Telegram',
};

/** One answer, as the pane keeps it after a Save or a Check again: what the agent said, and when this window heard it. */
export interface CheckedNow {
  check: KeyCheck;
  at: number;
}

export type KeyCheckLine =
  | { tone: 'none' }
  | { tone: 'checking'; text: string }
  /** `text` is "Works · 118 of 250 searches left"; `when` is "Checked 2 min ago". */
  | { tone: 'works'; text: string; when: string }
  /** The service answered and did not accept the key: its words, with what to do. */
  | { tone: 'rejected'; text: string; when: string | null }
  /** Nothing is known: the service could not be reached, had an outage, asked to slow down, or has nothing to check against. */
  | { tone: 'unreached'; text: string };

/** "Works · 118 of 250 searches left", or "Works". */
export const worksWords = (detail: string | undefined): string => (detail?.trim() ? `Works · ${detail.trim()}` : 'Works');

/**
 * The line under a key. A check in flight says so; a fresh answer from this window wins (it may be an outage the agent
 * records nothing for); otherwise the agent's own record says it: the problem when the service refused the key, the last
 * verdict when it worked, nothing for a key not yet checked.
 */
export function keyCheckLine(args: {
  name: KeyName;
  state: Pick<AppState, 'keys' | 'keyProblems' | 'keyChecks'> | null;
  checking: boolean;
  now: CheckedNow | null;
  at: number;
}): KeyCheckLine {
  const { name, state, checking, now, at } = args;
  if (checking) return { tone: 'checking', text: `Checking with ${SERVICE_NAME[name]}…` };
  if (now) {
    const c = now.check;
    if (c.ok) return { tone: 'works', text: worksWords(c.detail), when: when(now.at, at) };
    if (c.kind === 'rejected') return { tone: 'rejected', text: c.problem, when: when(now.at, at) };
    return { tone: 'unreached', text: c.problem };
  }
  if (!state || !state.keys[name]) return { tone: 'none' };
  const problem = state.keyProblems?.[name]?.trim();
  const record = state.keyChecks?.[name];
  if (problem) return { tone: 'rejected', text: problem, when: record ? when(record.at, at) : null };
  if (record?.ok) return { tone: 'works', text: worksWords(record.detail), when: when(record.at, at) };
  return { tone: 'none' };
}

/** "Checked 2 min ago" (or "Checked 3:05 PM", "Checked yesterday 3:05 PM"): `when` says the moment, this puts the verb before it. */
export const checkedWords = (whenWords: string): string => `Checked ${whenWords}`;

// ---------------------------------------------------------------- eBay: which field a value belongs in

/** A Cert ID (Client Secret) starts with PRD- or SBX- (Production or Sandbox). */
const certShaped = (v: string): boolean => /^(PRD|SBX)-/i.test(v);
/** An App ID (Client ID) is "Name-Words-PRD-1234567890-abcdef12": the environment sits in the middle. */
const appShaped = (v: string): boolean => /.-(PRD|SBX)-/i.test(v);
const sandbox = (v: string): boolean => /^SBX-|-SBX-/i.test(v);

/**
 * Hints under an eBay field, only when what was typed plainly has the other field's shape, or is a Sandbox key. A hint,
 * never a block: eBay's own answer after Save is the last word. At most two lines.
 */
export function ebayHints(field: 'appId' | 'certId', value: string): string[] {
  const v = value.trim();
  if (!v) return [];
  const out: string[] = [];
  if (field === 'appId' && certShaped(v) && !appShaped(v)) out.push('This looks like a Cert ID — the App ID goes here');
  if (field === 'certId' && appShaped(v) && !certShaped(v)) out.push('This looks like an App ID — the Cert ID goes here');
  if (sandbox(v)) out.push('This is a Sandbox key; Split Finder needs the Production keyset.');
  return out;
}
