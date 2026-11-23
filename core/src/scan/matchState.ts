import type { BundleRow, PartRow } from './types';

const count = (n: number, tail: string): string => `${n} ${n === 1 ? 'part' : 'parts'} ${tail}`;

const isWaiting = (p: PartRow): boolean => p.status === 'waiting' || p.status === 'unmatched';

/**
 * Nov 23: the match state of a bundle whose own Home Depot page is not read yet (BundleRow.waitingPage). The agent's
 * DealRow carries the code in `matchState` (and `matchKind`); a screen shows WAITING_PAGE_TEXT for it.
 */
export const WAITING_PAGE = 'waiting_page';
export const WAITING_PAGE_TEXT = 'Waiting for its Home Depot page';
/**
 * Step 15: the match state of a bundle whose split waits for Home Depot's part pages (BundleRow.waitingParts): the free
 * part-price read, or a kit's own page, settles it or asks. The DealRow carries the code as WAITING_PAGE's is.
 */
export const WAITING_PARTS = 'waiting_parts';
export const WAITING_PARTS_TEXT = "Waiting for Home Depot's part pages";
/**
 * Step 15 (decision 4): a part looked up on Amazon with no listing found. It is the part's state (the owner can confirm
 * a price for it, or mark it not sold separately), never a question about the bundle's split.
 */
export const NO_AMAZON_LISTING_TEXT = 'No Amazon listing found';

/** The match-state line on a Deals row. Shared by the helper and the native app. */
export function matchState(row: BundleRow): string | null {
  if (row.waitingPage) return WAITING_PAGE_TEXT;
  if (row.waitingParts) return WAITING_PARTS_TEXT;
  const parts = row.parts;
  if (parts.length === 0) return null;
  const verify = parts.filter((p) => !isWaiting(p) && (p.grade === 'probable' || p.status === 'review')).length;
  const toLookUp = parts.filter(isWaiting).length;
  switch (row.section) {
    case 'inactive_listing': {
      if (row.price === null) return 'No bundle price';
      const inactive = parts.filter((p) => p.availability === 'inactive').length;
      if (inactive > 0) return `${inactive} ${inactive === 1 ? 'listing' : 'listings'} inactive`;
      break;
    }
    case 'confirmed': {
      const probable = parts.filter((p) => p.grade === 'probable').length;
      if (probable > 0) return `${probable} title ${probable === 1 ? 'match' : 'matches'}`;
      break;
    }
    case 'waiting':
      if (toLookUp > 0) return count(toLookUp, 'to look up');
      break;
    case 'missing_listing': {
      const none = parts.filter((p) => p.availability === 'missing').length;
      const others = parts.filter((p) => p.availability !== 'missing' && !isWaiting(p) && (p.grade === 'probable' || p.status === 'review')).length;
      if (none > 0) return count(none, 'with no listing') + (others > 0 ? ` · ${others} to verify` : '');
      break;
    }
    default:
      break;
  }
  if (parts.every((p) => p.grade === 'exact' || p.grade === 'strong')) return count(parts.length, 'matched');
  if (verify > 0) return count(verify, 'to verify');
  if (toLookUp > 0) return count(toLookUp, 'unknown');
  const missing = parts.filter((p) => p.availability === 'missing').length;
  if (missing > 0) return count(missing, 'with no listing');
  return null;
}