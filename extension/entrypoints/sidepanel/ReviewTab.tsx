import type { AppState, PanelReport } from '../../lib/messages';

export interface ReviewTabProps {
  report: PanelReport | null;
  state: AppState;
}

// Stub: the review questions come in a later task.
export function ReviewTab({ report }: ReviewTabProps) {
  return <p className="stub">{report ? `${report.review.length} to review` : 'No scan has finished yet.'}</p>;
}
