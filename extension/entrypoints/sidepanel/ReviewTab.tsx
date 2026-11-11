import { useEffect, useRef, useState } from 'react';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewAnswer, ReviewItem } from '@core/scan/types';
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
  // Questions put off with Not now, in the order they were put off. Panel session only, never stored.
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [focusNext, setFocusNext] = useState(false);
  const emptyRef = useRef<HTMLParagraphElement>(null);

  const keyOf = (r: ReviewItem) => `${r.id}|${reviewSignature(r)}`;
  const byAge = report ? [...report.review].sort((a, b) => a.openedAt - b.openedAt).filter((r) => !done.has(keyOf(r))) : [];
  // Questions not yet put off come first, oldest first; those put off come back after them, in the order they were put off.
  const later = skipped.map((k) => byAge.find((r) => keyOf(r) === k)).filter((r): r is ReviewItem => r !== undefined);
  const open = [...byAge.filter((r) => !skipped.includes(keyOf(r))), ...later];
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

  // Sends nothing. With one question open there is nowhere to go, so it stays.
  const notNow = () => {
    if (open.length < 2) return;
    const k = keyOf(item);
    setSkipped((s) => [...s.filter((x) => x !== k), k]);
    setFocusNext(true);
  };

  return (
    <section className="review" aria-label="Review">
      <p className="review-count figure" aria-live="polite">
        {done.size + 1} of {total}
      </p>
      <ReviewQuestion
        key={keyOf(item)}
        item={item}
        scanRunning={state.scanRunning}
        focusHeading={focusNext}
        onSave={save}
        onNotNow={notNow}
      />
    </section>
  );
}
