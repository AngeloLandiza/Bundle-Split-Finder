import { DEAL_SORTS, type DealSortKey } from '@core/deals/sort';
import { useCallback, useState } from 'react';

const KEY = 'splitFinder.appDealsSort';

export { DEAL_SORTS, type DealSortKey };

function read(): DealSortKey {
  try {
    const v = localStorage.getItem(KEY);
    return DEAL_SORTS.some((s) => s.key === v) ? (v as DealSortKey) : 'profit';
  } catch {
    return 'profit';
  }
}

export function useDealSort(): [DealSortKey, (s: DealSortKey) => void] {
  const [sort, setSortState] = useState<DealSortKey>(read);
  const setSort = useCallback((s: DealSortKey) => {
    setSortState(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      // session-only
    }
  }, []);
  return [sort, setSort];
}