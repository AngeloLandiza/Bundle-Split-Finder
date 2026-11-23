/** Deals list sort keys (design.md — same as the side panel). */

export type DealSortKey = 'profit' | 'roi' | 'roiLowest' | 'roiHighest' | 'discount';

export const DEAL_SORTS: readonly { key: DealSortKey; label: string }[] = [
  { key: 'profit', label: 'Profit' },
  { key: 'roi', label: 'ROI' },
  { key: 'roiLowest', label: 'Lowest ROI' },
  { key: 'roiHighest', label: 'Highest ROI' },
  { key: 'discount', label: 'Discount' },
];

export type SortableDealRow = {
  percentOff?: number | null;
  profit?: number | null;
  roi?: number | null;
  roiLowest?: number | null;
  roiHighest?: number | null;
};

const metric = (row: SortableDealRow, sort: DealSortKey): number | null => {
  if (sort === 'discount') {
    return typeof row.percentOff === 'number' ? row.percentOff : null;
  }
  if (sort === 'roiLowest') return typeof row.roiLowest === 'number' ? row.roiLowest : null;
  if (sort === 'roiHighest') return typeof row.roiHighest === 'number' ? row.roiHighest : null;
  if (sort === 'roi') return typeof row.roi === 'number' ? row.roi : null;
  return typeof row.profit === 'number' ? row.profit : null;
};

/** Highest first; rows with no figure last; ties keep input order. */
export function sortDealRows<T extends SortableDealRow>(rows: readonly T[], sort: DealSortKey): T[] {
  return rows
    .map((row, i) => ({ row, i, v: metric(row, sort) }))
    .sort((a, b) => (a.v === null ? (b.v === null ? 0 : 1) : b.v === null ? -1 : b.v - a.v) || a.i - b.i)
    .map((x) => x.row);
}