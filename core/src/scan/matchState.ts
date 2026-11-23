import type { BundleRow, PartRow } from './types';

const count = (n: number, tail: string): string => `${n} ${n === 1 ? 'part' : 'parts'} ${tail}`;

const isWaiting = (p: PartRow): boolean => p.status === 'waiting' || p.status === 'unmatched';

/** The match-state line on a Deals row. Shared by the helper and the native app. */
export function matchState(row: BundleRow): string | null {
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