import type { AppState, PanelReport } from '../../lib/messages';
import type { SortKey } from './sort';

export interface DealsTabProps {
  report: PanelReport | null;
  state: AppState;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onOpen: (bundleKey: string) => void;
}

// Stub: the deals list comes in a later task.
export function DealsTab({ report }: DealsTabProps) {
  return <p className="stub">{report ? `${report.bundles.length} bundles` : 'No scan has finished yet.'}</p>;
}
