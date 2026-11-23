import type { ReportSection } from '../scan/types';

import { sortDealRows, type DealSortKey } from './sort';

export const DEAL_SECTION_ORDER: readonly ReportSection[] = [
  'confirmed',
  'waiting',
  'inactive_listing',
  'missing_listing',
  'split',
];

export const DEAL_SECTION_LABEL: Record<ReportSection, string> = {
  confirmed: 'CONFIRMED',
  waiting: 'WAITING FOR AN AMAZON LOOKUP',
  inactive_listing: 'REVIEW: INACTIVE LISTING',
  missing_listing: 'REVIEW: MISSING LISTING',
  split: 'CONTENTS NOT KNOWN',
};

export type DealListSection<T extends { section: string }> = {
  id: ReportSection;
  label: string;
  rows: T[];
};

export function dealListSections<T extends { section: string } & import('./sort').SortableDealRow>(
  bundles: readonly T[],
  sort: DealSortKey,
): DealListSection<T>[] {
  return DEAL_SECTION_ORDER.map((id) => ({
    id,
    label: DEAL_SECTION_LABEL[id],
    rows: sortDealRows(
      bundles.filter((b) => b.section === id),
      sort,
    ),
  })).filter((s) => s.rows.length > 0);
}