import { useEffect, useRef, useState } from 'react';
import { askCostLabel } from '@core/assist/cost';
import { DEFAULT_CLAUDE_JUDGE_MODEL } from '@core/judge/claude';
import { liveSuggestion, type StoredSuggestion } from '@core/assist/stored';
import { reviewSignature } from '@core/scan/answers';
import type { EbayQuestion as EbayQ, ReviewAnswer, ReviewItem } from '@core/scan/types';
import type { AppState, PanelReport } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { AcceptSuggested, suggestedOf, useAcceptAll } from './AcceptSuggested';
import { EbayQuestion, type EbayChoice } from './EbayQuestion';
import { notSuggestedSentence } from './AiSuggestion';
import { ReviewQuestion } from './ReviewQuestion';
import './ReviewTab.css';

/** One open question: a review item, or (step 10) an eBay listing question. They are answered one at a time, oldest first, as one list. */
type Entry = { key: string; openedAt: number } & ({ review: ReviewItem } | { ebay: EbayQ });

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
  // Questions put off with Skip for now, in the order they were put off. Panel session only, never stored.
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  // Keys put off since the count last went round.
  const [pass, setPass] = useState<readonly string[]>([]);
  const [focusNext, setFocusNext] = useState(false);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  // Step 11, Ask AI: the question being asked about, what the last ask said when it gave nothing, and the suggestions asked for in this panel.
  const [asking, setAsking] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<{ id: string; text: string } | null>(null);
  const [got, setGot] = useState<Readonly<Record<string, StoredSuggestion>>>({});

  const keyOf = (r: ReviewItem) => `${r.id}|${reviewSignature(r)}`;
  const ebayKeyOf = (q: EbayQ) => `ebay:${q.id}`;
  const entries: Entry[] = report
    ? [
        ...report.review.map((r): Entry => ({ key: keyOf(r), openedAt: r.openedAt, review: r })),
        ...(report.ebayQuestions ?? []).map((q): Entry => ({ key: ebayKeyOf(q), openedAt: q.openedAt, ebay: q })),
      ]
    : [];
  const byAge = entries.sort((a, b) => a.openedAt - b.openedAt).filter((e) => !done.has(e.key));
  // Questions not yet put off come first, oldest first; those put off come back after them, in the order they were put off.
  const later = skipped.map((k) => byAge.find((e) => e.key === k)).filter((e): e is Entry => e !== undefined);
  const open = [...byAge.filter((e) => !skipped.includes(e.key)), ...later];
  const entry = open[0];
  const item = entry && 'review' in entry ? entry.review : undefined;

  // Accept all: the questions that offer one reading, answered in one press. Each one answered is hidden like a single answer.
  const acceptAll = useAcceptAll(api, (r, seen) => setDone((d) => new Set(d).add(`${r.id}|${seen}`)));
  const suggested = suggestedOf(open.flatMap((e) => ('review' in e ? [e.review] : [])));
  // The same link the question's own "Open on Home Depot" uses: the report row's, never one built from the model.
  const homeDepotLinkOf = (r: ReviewItem): string | null => (r.kind === 'split' ? (report?.bundles.find((b) => b.key === r.subject)?.link ?? null) : null);
  // A result sentence about the questions as they were goes stale when a scan starts.
  const clearResult = acceptAll.clear;
  useEffect(() => {
    if (state.scanRunning) clearResult();
  }, [state.scanRunning]); // eslint-disable-line react-hooks/exhaustive-deps
  const accept = (
    <AcceptSuggested
      items={suggested}
      run={acceptAll.run}
      result={acceptAll.result}
      focusedId={acceptAll.focusedId}
      scanRunning={state.scanRunning}
      onAccept={() => void acceptAll.accept(suggested)}
      linkOf={homeDepotLinkOf}
    />
  );

  // After an answer the form is gone: focus goes to the next question's heading (ReviewQuestion), or here.
  // Keyed on the number answered, so a report reload never takes focus.
  // Not when an Accept all has just ended in the same render: its result sentence takes focus then.
  const resultSeen = useRef(0);
  useEffect(() => {
    const fresh = (acceptAll.result?.id ?? 0) !== resultSeen.current;
    if (done.size > 0 && emptyRef.current && !fresh) emptyRef.current.focus();
  }, [done.size]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    resultSeen.current = acceptAll.result?.id ?? 0;
  }, [acceptAll.result?.id]);
  // The next question takes focus once, right after Save answer; a remount for another reason does not.
  useEffect(() => {
    if (focusNext) setFocusNext(false);
  }, [focusNext]);

  // The button exists only with an Anthropic key saved; its price is the Settings model's.
  const hasAi = state.ebay?.hasAnthropicKey === true;
  const aiCost = askCostLabel(state.ebay?.judgeModel ?? DEFAULT_CLAUDE_JUDGE_MODEL);
  /** Only a suggestion made for the question as it reads now: one for other choices is not shown, whatever the panel holds. */
  const suggestionFor = (r: ReviewItem): StoredSuggestion | null => {
    const mine = got[r.id];
    return liveSuggestion([...(mine ? [mine] : []), ...(report?.aiSuggestions ?? [])], r) ?? null;
  };
  const ask = async (r: ReviewItem): Promise<void> => {
    if (asking !== null) return;
    setAsking(r.id);
    setAiNotice(null);
    try {
      const reply = await api.send<StoredSuggestion>({ type: 'askAi', questionId: r.id });
      if (!reply.ok) setAiNotice({ id: r.id, text: reply.error });
      else if (reply.data.suggestion.status === 'not_suggested') setAiNotice({ id: r.id, text: notSuggestedSentence(reply.data.suggestion) });
      else setGot((g) => ({ ...g, [r.id]: reply.data }));
    } catch {
      setAiNotice({ id: r.id, text: UNREACHABLE });
    } finally {
      setAsking(null);
    }
  };

  if (!report) return <p className="review-empty">No scan has finished yet.</p>;
  if (!entry) {
    return (
      <>
        {/* Only the result sentence can be here: the block needs two questions. */}
        {accept}
        <p className="review-empty" ref={emptyRef} tabIndex={-1}>
          Nothing needs your answer.
        </p>
      </>
    );
  }
  // The badge's number: every question still open.
  const total = open.length;
  // Questions already passed over in this round come before the one shown; at the start of a new round, none.
  const ahead = pass.includes(entry.key) ? 0 : open.filter((e) => e !== entry && pass.includes(e.key)).length;

  const save = async (answer: ReviewAnswer, aiShown = false): Promise<string | null> => {
    if (!item) return null;
    try {
      // `aiSuggestion` only says a suggestion was on screen: the answer is the owner's, and it is saved as any answer is.
      const reply = await api.send({ type: 'answerReview', id: item.id, answer, ...(aiShown ? { aiSuggestion: true as const } : {}) });
      if (!reply.ok) return reply.error;
    } catch {
      return UNREACHABLE;
    }
    setDone((d) => new Set(d).add(`${item.id}|${answer.seen}`));
    setFocusNext(true);
    return null;
  };

  const saveEbay = async (answer: EbayChoice): Promise<string | null> => {
    if (!entry || !('ebay' in entry)) return null;
    const q = entry.ebay;
    try {
      const reply = await api.send({ type: 'answerEbay', key: q.key, itemId: q.itemId, answer });
      if (!reply.ok) return reply.error;
    } catch {
      return UNREACHABLE;
    }
    setDone((d) => new Set(d).add(entry.key));
    setFocusNext(true);
    return null;
  };

  // Sends nothing. With one question open there is nowhere to go, so it stays.
  const notNow = () => {
    if (open.length < 2) return;
    const k = entry.key;
    // The question shown being in `pass` means every open one was put off: the count goes round, starting here.
    setPass((p) => (p.includes(k) ? [k] : [...p, k]));
    setSkipped((s) => [...s.filter((x) => x !== k), k]);
    setFocusNext(true);
  };

  return (
    <section className="review" aria-label="Review">
      {accept}
      <p className="review-count figure" aria-live="polite">
        {ahead + 1} of {total}
      </p>
      {item ? (
        <ReviewQuestion
          key={entry.key}
          item={item}
          homeDepotLink={homeDepotLinkOf(item)}
          scanRunning={state.scanRunning}
          focusHeading={focusNext}
          onSave={save}
          onNotNow={notNow}
          ai={hasAi ? { cost: aiCost, suggestion: suggestionFor(item), asking: asking === item.id, notice: aiNotice?.id === item.id ? aiNotice.text : null, onAsk: () => void ask(item) } : undefined}
        />
      ) : 'ebay' in entry ? (
        <EbayQuestion key={entry.key} question={entry.ebay} scanRunning={state.scanRunning} focusHeading={focusNext} onSave={saveEbay} onNotNow={notNow} />
      ) : null}
    </section>
  );
}
