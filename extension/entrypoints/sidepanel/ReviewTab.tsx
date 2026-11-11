import { useState } from 'react';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewAnswer } from '@core/scan/types';
import type { AppState, PanelReport } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { ReviewQuestion } from './ReviewQuestion';
import './ReviewTab.css';

export interface ReviewTabProps {
  api: WorkerApi;
  report: PanelReport | null;
  state: AppState;
}

/** Oldest question first, one at a time. An answered one is hidden at once, before the report reloads. */
export function ReviewTab({ report, state, api }: ReviewTabProps) {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  if (!report) return <p className="review-empty">No scan has finished yet.</p>;

  const open = [...report.review].sort((a, b) => a.openedAt - b.openedAt).filter((r) => !done.has(r.id));
  const item = open[0];
  if (!item) return <p className="review-empty">Nothing needs your answer.</p>;
  const total = done.size + open.length;

  const save = async (answer: ReviewAnswer): Promise<string | null> => {
    try {
      const reply = await api.send({ type: 'answerReview', id: item.id, answer });
      if (!reply.ok) return reply.error;
    } catch {
      return UNREACHABLE;
    }
    setDone((d) => new Set(d).add(item.id));
    return null;
  };

  return (
    <section className="review" aria-label="Review">
      <p className="review-count fig">
        {done.size + 1} of {total}
      </p>
      <ReviewQuestion key={`${item.id}|${reviewSignature(item)}`} item={item} scanRunning={state.scanRunning} onSave={save} />
    </section>
  );
}
