// Home Depot's pace, the order (Nov 23, after scan 5): with a few dozen pages a scan and a slow drip between scans, the
// pages go where a deal can be. Bundles and sets with a Home Depot saving first, the biggest percent off first; a bundle or
// set with no saving at all last. A set's unread items are queued together, so the first pages read finish whole sets; an
// item two sets share is read once. Pure.

import type { BundleRecord } from './types';

/** A bundle's Home Depot saving: its percent off and dollars off, from the listing (a set's own promotion figures too). */
export function savingOf(b: Pick<BundleRecord, 'price' | 'regularPrice' | 'percentOff' | 'set'>): { has: boolean; percent: number; dollars: number } {
  const listed = b.price !== null && b.regularPrice !== null && b.regularPrice > b.price ? b.regularPrice - b.price : 0;
  const dollars = Math.max(listed, b.set?.dollarOff ?? 0);
  const fromPrices = listed > 0 && b.regularPrice ? (listed / b.regularPrice) * 100 : 0;
  const percent = Math.max(b.percentOff ?? 0, b.set?.percentageOff ?? 0, fromPrices);
  return { has: percent > 0 || dollars > 0, percent, dollars };
}

/** Saving first (any before none), then the biggest percent off, then the most dollars off, then newest, then key. */
export function bySaving(a: BundleRecord, b: BundleRecord): number {
  const x = savingOf(a);
  const y = savingOf(b);
  return Number(y.has) - Number(x.has) || y.percent - x.percent || y.dollars - x.dollars || b.seenAt - a.seenAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** One Home Depot page a bundle waits for: its own page (a plain bundle), or one of a set's items' pages. */
export type PageWant =
  | { kind: 'bundle'; itemId: string; bundle: string }
  | { kind: 'item'; itemId: string; sets: string[] };

/** A set item whose page was never read (an item read with no model number is not read again: it would say the same). */
export const itemUnread = (i: { model?: string; readAt?: number }): boolean => !i.model && i.readAt === undefined;

/**
 * The Home Depot pages the stored bundles wait for, in the order they are read: bundles by bySaving; a plain bundle's own
 * page when it was never read; a set's unread items, together, each item once (the sets that share it are named on it).
 * `kinds`: only these kinds (a run with no reader for the other).
 */
export function pagesWanted(bundles: readonly BundleRecord[], kinds: ReadonlySet<PageWant['kind']> = new Set(['bundle', 'item'])): PageWant[] {
  const out: PageWant[] = [];
  const items = new Map<string, Extract<PageWant, { kind: 'item' }>>();
  for (const b of [...bundles].sort(bySaving)) {
    if (b.set) {
      if (!kinds.has('item')) continue;
      for (const i of b.set.items) {
        if (!itemUnread(i)) continue;
        const known = items.get(i.itemId);
        if (known) {
          if (!known.sets.includes(b.key)) known.sets.push(b.key);
          continue;
        }
        const want = { kind: 'item' as const, itemId: i.itemId, sets: [b.key] };
        items.set(i.itemId, want);
        out.push(want);
      }
    } else if (kinds.has('bundle') && (b.page === undefined || b.page === null)) out.push({ kind: 'bundle', itemId: b.itemId, bundle: b.key });
  }
  return out;
}

/** What the pages wanted add up to: distinct pages, and the sets and plain bundles that wait for them. */
export function backlogOf(wants: readonly PageWant[]): { pages: number; sets: number; bundles: number } {
  const sets = new Set(wants.flatMap((w) => (w.kind === 'item' ? w.sets : [])));
  return { pages: wants.length, sets: sets.size, bundles: wants.filter((w) => w.kind === 'bundle').length };
}
