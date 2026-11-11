import { useEffect, useRef, useState } from 'react';
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

/**
 * Oldest question first, one at a time. An answered one is hidden at once, before the report reloads.
 * It is remembered by id and signature, so a question a later scan reopens with other choices is shown again.
 */
export function ReviewTab({ report, state, api }: ReviewTabProps) {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [focusNext, setFocusNext] = useState(false);
  const emptyRef = useRef<HTMLParagraphElement>(null);

  const open = report ? [...report.review].sort((a, b) => a.openedAt - b.openedAt).filter((r) => !done.has(`${r.id}|${reviewSignature(r)}`)) : [];
  const item = open[0];

  // After an answer the form is gone: focus goes to the next question's heading (ReviewQuestion), or here.
  // Keyed on the number answered, so a report reload never takes focus.
  useEffect(() => {
    if (done.size > 0 && emptyRef.current) emptyRef.current.focus();
  }, [done.size]);
  // The next question takes focus once, right after Save answer; a remount for another reason does not.
  useEffect(() => {
    if (focusNext) setFocusNext(false);
  }, [focusNext]);

  if (!report) return <p className="review-empty">No scan has finished yet.</p>;
  if (!item) {
    return (
      <p className="review-empty" ref={emptyRef} tabIndex={-1}>
        Nothing needs your answer.
      </p>
    );
  }
  const total = done.size + open.length;

  const save = async (answer: ReviewAnswer): Promise<string | null> => {
    try {
      const reply = await api.send({ type: 'answerReview', id: item.id, answer });
      if (!reply.ok) return reply.error;
    } catch {
      return UNREACHABLE;
    }
    setDone((d) => new Set(d).add(`${item.id}|${answer.seen}`));
    setFocusNext(true);
    return null;
  };

  return (
    <section className="review" aria-label="Review">
      <p className="review-count figure" aria-live="polite">
        {done.size + 1} of {total}
      </p>
      <ReviewQuestion
        key={`${item.id}|${reviewSignature(item)}`}
        item={item}
        scanRunning={state.scanRunning}
        focusHeading={focusNext}
        onSave={save}
      />
    </section>
  );
}
