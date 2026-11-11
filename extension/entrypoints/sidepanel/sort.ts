import { useCallback, useState } from 'react';

export type SortKey = 'profit' | 'roi' | 'discount';

const KEY = 'splitFinder.sort';
const KEYS: readonly SortKey[] = ['profit', 'roi', 'discount'];

function read(): SortKey {
  try {
    const v = localStorage.getItem(KEY);
    return KEYS.find((k) => k === v) ?? 'profit';
  } catch {
    return 'profit';
  }
}

/** The sort choice, remembered in localStorage. Storage can be blocked, so every access is guarded. */
export function useSort(): [SortKey, (s: SortKey) => void] {
  const [sort, setSortState] = useState<SortKey>(read);
  const setSort = useCallback((s: SortKey) => {
    setSortState(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      // Not remembered; the choice still holds for this session.
    }
  }, []);
  return [sort, setSort];
}
