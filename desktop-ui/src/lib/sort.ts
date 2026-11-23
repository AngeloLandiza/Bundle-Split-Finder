// Table sorting. A column is sorted by one value per row; rows with no value always sit last,
// whichever the direction, and ties keep the order they came in (a stable sort), so a re-sort
// never shuffles rows that compare equal.

export type SortDirection = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  dir: SortDirection;
}

export type SortValue = number | string | null | undefined;

export function sortRows<T, K extends string>(rows: readonly T[], state: SortState<K>, value: (row: T, key: K) => SortValue): T[] {
  const sign = state.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row, state.key) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined;
      const bn = b.v === null || b.v === undefined;
      if (an || bn) return an && bn ? a.i - b.i : an ? 1 : -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v));
      return c * sign || a.i - b.i;
    })
    .map((x) => x.row);
}

/**
 * The next state when a head is pressed: the same column flips; a new column starts at its
 * natural direction (figures high to low, words A to Z).
 */
export function nextSort<K extends string>(current: SortState<K>, key: K, natural: SortDirection): SortState<K> {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: natural };
}

/** aria-sort for a head. */
export function ariaSort<K extends string>(current: SortState<K>, key: K): 'ascending' | 'descending' | 'none' {
  if (current.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}
