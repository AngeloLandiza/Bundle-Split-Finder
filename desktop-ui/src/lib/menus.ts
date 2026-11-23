// What a right-click offers (docs/design.md, Desktop app > Context menus). One pure function per kind of row says
// which items exist, which are greyed (with the sentence why), and where the separators fall. The screen runs them.
// An item that cannot apply is left out, not greyed, unless he could make it apply by waiting (a scan running).

import type { DealPart, DealRow, ReviewQuestion } from '../api/types';
import { bogoMenuLabel } from './bogo';
import { money, plural } from './format';

export interface MenuItem {
  id: string;
  label: string;
  /** Shown at the right: a key that does the same, when there is one. */
  hint?: string;
  /** The sentence that says why the item is not available now; the item is greyed. */
  disabled?: string;
  danger?: boolean;
  /** A hairline above this item. */
  separatorBefore?: boolean;
}

export type DealMenuId = 'open' | 'open-hd' | 'copy-model' | 'copy-asins' | 'watch' | 'unwatch' | 'bogo' | 'lookup' | 'verify' | 'review';
export type QuestionMenuId = 'ask' | 'approve' | 'open-deal' | 'open-hd' | 'copy-question';
export type PartMenuId = 'open-amazon' | 'copy-asin' | 'confirm' | 'remove';

const SCAN_LATER = 'A scan is running. Try again when it has finished.';

/** Core's own match line for a row that has parts to verify: "2 title matches". The row carries no part list. */
export const hasTitleMatches = (row: Pick<DealRow, 'matchState'>): boolean => /\btitle match(es)?\b/.test(row.matchState ?? '');

export function dealMenu(row: DealRow, o: { scanRunning: boolean }): MenuItem[] {
  const items: MenuItem[] = [{ id: 'open', label: 'Open', hint: '↩' }];
  if (row.link) items.push({ id: 'open-hd', label: 'Open on Home Depot' });
  items.push({ id: 'copy-model', label: 'Copy model', separatorBefore: true }, { id: 'copy-asins', label: 'Copy ASINs' });
  const more: MenuItem[] = [row.watched ? { id: 'unwatch', label: 'Unwatch' } : { id: 'watch', label: 'Watch' }, { id: 'bogo', label: bogoMenuLabel(row.bogo) }];
  if (row.lookup) {
    more.push({ id: 'lookup', label: `Look up · ${plural(row.lookup.searches, 'search', 'searches')}`, ...(o.scanRunning ? { disabled: SCAN_LATER } : {}) });
  }
  if (hasTitleMatches(row)) more.push({ id: 'verify', label: 'Verify title matches…' });
  if (row.needsAnswer) more.push({ id: 'review', label: 'Show in Review' });
  more.forEach((m, i) => items.push(i === 0 ? { ...m, separatorBefore: true } : m));
  return items;
}

export function questionMenu(q: ReviewQuestion, o: { hasAi: boolean; asking: boolean }): MenuItem[] {
  const items: MenuItem[] = [];
  if (o.hasAi && q.kind !== 'ebay' && !q.suggestion && q.askCostUsd !== null) {
    items.push({ id: 'ask', label: `Ask AI · about ${money(q.askCostUsd)}`, hint: 'A', ...(o.asking ? { disabled: 'The AI is already asking. Wait for it to finish.' } : {}) });
  }
  if (q.suggestion?.status === 'verified') items.push({ id: 'approve', label: 'Approve suggestion' });
  const tail: MenuItem[] = [];
  if (q.bundle.id) tail.push({ id: 'open-deal', label: 'Open the deal' });
  if (q.bundle.link) tail.push({ id: 'open-hd', label: 'Open on Home Depot' });
  tail.push({ id: 'copy-question', label: 'Copy question' });
  tail.forEach((m, i) => items.push(i === 0 && items.length > 0 ? { ...m, separatorBefore: true } : m));
  return items;
}

export function partMenu(part: DealPart, o: { scanRunning: boolean }): MenuItem[] {
  const items: MenuItem[] = [];
  if (!part.unnamed) items.push({ id: 'open-amazon', label: part.asin ? 'Open on Amazon' : 'Search Amazon' });
  if (part.asin) items.push({ id: 'copy-asin', label: 'Copy ASIN' });
  const own = part.confirm.confirmed;
  items.push({ id: 'confirm', label: own ? 'Change the confirmed price…' : 'Confirm a price…', ...(items.length ? { separatorBefore: true } : {}) });
  if (own) items.push({ id: 'remove', label: 'Remove confirmed price', danger: true, ...(o.scanRunning ? { disabled: SCAN_LATER } : {}) });
  return items;
}

/** The next enabled item in a direction, wrapping; -1 when none can be chosen. Used by the menu's arrow keys. */
export function stepMenu(items: readonly MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const at = (((from + dir * i) % n) + n) % n;
    if (!items[at]!.disabled) return at;
  }
  return -1;
}
