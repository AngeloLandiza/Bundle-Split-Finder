// One notice region per screen shows at most one banner (docs/ux-checklist.md: one notice at a time; NN/g heuristic 8,
// minimalist design; HIG, status without stacking). When several things are true at once, the most urgent is the banner
// and the others wait behind "N more". Pure: the region only draws what this picks.

import type { AppState, KeyName } from '../api/types';
import { keyState, KEY_LABEL } from './keyStatus';

/**
 * Every banner kind, most urgent first. The agent being offline makes everything else moot; a request to connect is a
 * question waiting for him; then the helper that is out of date, a scan that left work undone, and the setup that stops
 * a scan, then a key the service rejected, then lookups waiting (a notice about a convenience), then a stale price, and last a new version of the app (never urgent, and he can close it).
 */
export const NOTICE_ORDER = ['offline', 'pairing', 'helper', 'scan', 'chrome', 'key-missing', 'reserve', 'key-rejected', 'lookups', 'stale', 'update'] as const;
export type NoticeKind = (typeof NOTICE_ORDER)[number];

export interface Chosen<T> {
  /** The banner, or null when nothing applies. */
  first: T | null;
  /** The others, in priority order: the "1 more" popover lists them. */
  more: T[];
}

/**
 * The banner and what waits behind it. While a scan runs the lookups notice is hidden: the scan is doing them, and a
 * button that is disabled "until the scan has finished" is noise.
 */
export function chooseNotices<T extends { kind: NoticeKind }>(items: readonly T[], o: { scanning: boolean }): Chosen<T> {
  const rank = (k: NoticeKind): number => NOTICE_ORDER.indexOf(k);
  const kept = items.filter((i) => !(o.scanning && i.kind === 'lookups'));
  // Array.prototype.sort is stable: two of one kind (two pairing requests) keep the order they came in.
  const sorted = [...kept].sort((a, b) => rank(a.kind) - rank(b.kind));
  return { first: sorted[0] ?? null, more: sorted.slice(1) };
}

/** "1 more" / "3 more" on the banner. */
export const moreWords = (n: number): string => `${n} more`;

/** The keys each screen works with; a rejected key among them is worth a banner there, one it does not use is not. */
export const SCREEN_KEYS = {
  today: ['serpapi'],
  deals: ['serpapi', 'keepa'],
  review: ['anthropic', 'openai'],
} as const satisfies Record<string, readonly KeyName[]>;

/** The one sentence for the saved keys this screen needs that their service rejected, or null. */
export function rejectedKeyNotice(state: Pick<AppState, 'keys' | 'keyProblems'> | null, names: readonly KeyName[]): { title: string; text: string } | null {
  const bad = names.filter((n) => keyState(state, n).state === 'rejected');
  const first = bad[0];
  if (!first) return null;
  if (bad.length > 1) return { title: `${bad.length} keys are not accepted.`, text: `${bad.map((n) => KEY_LABEL[n]).join(' and ')} did not accept the key saved here.` };
  return { title: `The ${KEY_LABEL[first]} key is not accepted.`, text: keyState(state, first).problem ?? '' };
}
