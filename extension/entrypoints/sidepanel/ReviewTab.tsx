import { useEffect, useRef, useState } from 'react';
import { verifiedRows } from '@core/assist/approve';
import { askQueueOf } from '@core/assist/askAll';
import { liveSuggestion } from '@core/assist/stored';
import { askAllCostLabel } from '@core/assist/cost';
import { DEFAULT_CLAUDE_JUDGE_MODEL } from '@core/judge/claude';
import { reviewSignature } from '@core/scan/answers';
import type { EbayQuestion as EbayQ, ReviewAnswer, ReviewItem } from '@core/scan/types';
import type { AppState, PanelReport } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { AcceptSuggested, suggestedOf, useAcceptAll } from './AcceptSuggested';
import { EbayQuestion, type EbayChoice } from './EbayQuestion';
import { AiSuggestionsSection, ApproveResultLine, useApproveAll } from './AiSuggestions';
import { AskAllButton, AskAllRow, askAllSentence } from './AskAll';
import { ReviewQuestion } from './ReviewQuestion';
import { useQuestionAi } from './useQuestionAi';
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
 *
 * Step 12: a question whose AI suggestion the code verified leaves the list and is a row of "AI suggestions" above it, which Approve all
 * can approve together. Every other question, with or without an unverified suggestion, stays in the list.
 */
export function ReviewTab({ report, state, api }: ReviewTabProps) {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  // Questions put off with Skip for now, in the order they were put off. Panel session only, never stored.
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  // Keys put off since the count last went round.
  const [pass, setPass] = useState<readonly string[]>([]);
  const [focusNext, setFocusNext] = useState(false);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const ai = useQuestionAi(api, report, state);
  // Step 12: the rows of "AI suggestions" that are open, what the last Ask AI about all press said when it was refused, and how many
  // row answers were saved (focus goes back to the tab when a row goes).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [askAllError, setAskAllError] = useState<string | null>(null);
  const [rowSaved, setRowSaved] = useState(0);
  // Ask AI about all was pressed here and its queue has not been seen running yet; and the batch result the owner has acted on since.
  const pressedAskAll = useRef(false);
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);

  const keyOf = (r: ReviewItem) => `${r.id}|${reviewSignature(r)}`;
  const ebayKeyOf = (q: EbayQ) => `ebay:${q.id}`;
  const entries: Entry[] = report
    ? [
        ...report.review.map((r): Entry => ({ key: keyOf(r), openedAt: r.openedAt, review: r })),
        ...(report.ebayQuestions ?? []).map((q): Entry => ({ key: ebayKeyOf(q), openedAt: q.openedAt, ebay: q })),
      ]
    : [];
  const byAge = entries.sort((a, b) => a.openedAt - b.openedAt).filter((e) => !done.has(e.key));
  const reviews = byAge.flatMap((e) => ('review' in e ? [e.review] : []));
  const { got, records, suggestionFor, aiFor, clear: clearSuggestion } = ai;
  // A question whose suggestion the code verified, and that Approve could save, is listed in "AI suggestions", not in the list below.
  // Except one the owner asked about on its own in this panel: they are looking at it, so its suggestion stays in the question, as it
  // did in step 11, until it is answered. After a reload it is a row like the rest.
  const askedHere = (r: ReviewItem): boolean => got[r.id] !== undefined && liveSuggestion([got[r.id]!], r) !== undefined;
  const rows = verifiedRows(reviews.filter((r) => !askedHere(r)), records);
  const inSection = new Set(rows.map((r) => r.item.id));
  const ordinary = byAge.filter((e) => !('review' in e) || !inSection.has(e.review.id));
  // Questions not yet put off come first, oldest first; those put off come back after them, in the order they were put off.
  const later = skipped.map((k) => ordinary.find((e) => e.key === k)).filter((e): e is Entry => e !== undefined);
  const open = [...ordinary.filter((e) => !skipped.includes(e.key)), ...later];
  const entry = open[0];
  const item = entry && 'review' in entry ? entry.review : undefined;

  // Accept all: the questions that offer one reading, answered in one press. Each one answered is hidden like a single answer.
  const acceptAll = useAcceptAll(api, (r, seen) => setDone((d) => new Set(d).add(`${r.id}|${seen}`)));
  // Not one the AI has made a suggestion for: Accept all never decides over what the AI said, so that one is answered on its own.
  const suggested = suggestedOf(open.flatMap((e) => ('review' in e ? [e.review] : []))).filter((r) => suggestionFor(r) === null);
  // The same link the question's own "Open on Home Depot" uses: the report row's, never one built from the model.
  const homeDepotLinkOf = (r: ReviewItem): string | null => (r.kind === 'split' ? (report?.bundles.find((b) => b.key === r.subject)?.link ?? null) : null);
  // Approve all: the answers the code verified, in one press after one question. Each answered row is hidden like a single answer.
  const approveAll = useApproveAll(api, (r, seen) => setDone((d) => new Set(d).add(`${r.id}|${seen}`)));
  // A result sentence about the questions as they were goes stale when a scan starts.
  const clearAccepted = acceptAll.clear;
  const clearApproved = approveAll.clear;
  useEffect(() => {
    if (state.scanRunning) {
      clearAccepted();
      clearApproved();
    }
  }, [state.scanRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // The buttons exist only with an Anthropic key saved; their price is the Settings model's.
  const hasAi = state.ebay?.hasAnthropicKey === true;
  const model = state.ebay?.judgeModel ?? DEFAULT_CLAUDE_JUDGE_MODEL;
  const queueRunning = state.askAll != null;
  // Ask AI about all: every open question that can be asked and has no suggestion yet (core/src/assist/askAll.ts).
  const askable = askQueueOf(reviews, records);
  const askAll = async (): Promise<void> => {
    setAskAllError(null);
    pressedAskAll.current = true;
    try {
      const reply = await api.send<{ queued: number }>({ type: 'askAiAll' });
      if (!reply.ok) {
        pressedAskAll.current = false;
        setAskAllError(reply.error);
      }
    } catch {
      pressedAskAll.current = false;
      setAskAllError(UNREACHABLE);
    }
  };
  // The button reads Asking… once the queue runs and is no longer the control: focus goes to the header's Stop (the queue's control, the
  // same button a scan has), so the next Tab continues from there. Only after the owner pressed Ask AI about all in this panel.
  useEffect(() => {
    if (queueRunning && pressedAskAll.current) {
      pressedAskAll.current = false;
      document.getElementById('scan-control')?.focus();
    }
  }, [queueRunning]);
  // With one question to ask there is its own button: "about all 1" would be the same button twice, so it takes two. Accept all's rule too.
  const askAllButton =
    hasAi && (askable.length >= 2 || queueRunning) ? (
      <AskAllButton count={askable.length} cost={askAllCostLabel(askable.map((q) => q.kind), model)} running={queueRunning} scanRunning={state.scanRunning} onAsk={() => void askAll()} />
    ) : null;
  // The sentence about how the last asking went belongs to the Ask AI row. It goes once the section shows the results, except when the
  // queue stopped on its own (a problem, or the spending cap): the section does not say why it holds fewer rows than were asked about.
  const last = state.askAllResult;
  const lastKey = last ? JSON.stringify(last) : null;
  const lastShown = last && !queueRunning && !state.scanRunning && (rows.length === 0 || last.problem !== null || last.overspent) ? askAllSentence(last) : null;
  const askAllNote = askAllError ?? (lastKey !== null && lastKey === dismissedResult ? null : lastShown);
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
  // The sentence describes a finished batch: once its suggestions are approved or any question is answered, it is not shown again.
  useEffect(() => {
    if ((approveAll.result !== null || done.size > 0) && lastKey !== null) setDismissedResult(lastKey);
  }, [approveAll.result?.id, done.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const askRow = <AskAllRow button={askAllButton} note={askAllNote} />;

  // After an answer the form is gone: focus goes to the next question's heading (ReviewQuestion), or here.
  // Keyed on the number answered, so a report reload never takes focus.
  // Not when an Accept all or Approve all has just ended in the same render: its result sentence takes focus then.
  const resultSeen = useRef(0);
  const approvedSeen = useRef(0);
  useEffect(() => {
    const fresh = (acceptAll.result?.id ?? 0) !== resultSeen.current || (approveAll.result?.id ?? 0) !== approvedSeen.current;
    if (done.size > 0 && emptyRef.current && !fresh) emptyRef.current.focus();
  }, [done.size]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    resultSeen.current = acceptAll.result?.id ?? 0;
  }, [acceptAll.result?.id]);
  useEffect(() => {
    approvedSeen.current = approveAll.result?.id ?? 0;
  }, [approveAll.result?.id]);
  // The next question takes focus once, right after Save answer; a remount for another reason does not.
  useEffect(() => {
    if (focusNext) setFocusNext(false);
  }, [focusNext]);
  // A row that was answered is gone: focus goes to the tab, so the next Tab is the next thing on it, not the top of the page.
  useEffect(() => {
    if (rowSaved > 0) sectionRef.current?.focus();
  }, [rowSaved]);

  if (!report) return <p className="review-empty">No scan has finished yet.</p>;
  if (!entry && rows.length === 0) {
    return (
      <>
        {/* Only the Ask AI row or a result sentence can be here: the Accept block needs two questions. */}
        {askRow}
        {accept}
        <ApproveResultLine result={approveAll.result} focusedId={approveAll.focusedId} />
        <p className="review-empty" ref={emptyRef} tabIndex={-1}>
          Nothing needs your answer.
        </p>
      </>
    );
  }
  // The badge's number: every question still in the list below "AI suggestions".
  const total = open.length;
  // Questions already passed over in this round come before the one shown; at the start of a new round, none.
  const ahead = entry && pass.includes(entry.key) ? 0 : open.filter((e) => e !== entry && pass.includes(e.key)).length;

  /** The owner's answer to a question of the list, or to a row of "AI suggestions" (`fromRow`). */
  const saveFor = (q: ReviewItem, fromRow: boolean) => async (answer: ReviewAnswer, aiShown = false): Promise<string | null> => {
    try {
      // `aiSuggestion` only says a suggestion was on screen: the answer is the owner's, and it is saved as any answer is.
      const reply = await api.send({ type: 'answerReview', id: q.id, answer, ...(aiShown ? { aiSuggestion: true as const } : {}) });
      if (!reply.ok) return reply.error;
    } catch {
      return UNREACHABLE;
    }
    setDone((d) => new Set(d).add(`${q.id}|${answer.seen}`));
    // The answer is saved: the suggestion shown for it is not kept in the panel.
    clearSuggestion(q.id);
    if (fromRow) setRowSaved((n) => n + 1);
    else setFocusNext(true);
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
    if (!entry || open.length < 2) return;
    const k = entry.key;
    // The question shown being in `pass` means every open one was put off: the count goes round, starting here.
    setPass((p) => (p.includes(k) ? [k] : [...p, k]));
    setSkipped((s) => [...s.filter((x) => x !== k), k]);
    setFocusNext(true);
  };

  const toggleRow = (id: string) =>
    setExpanded((x) => {
      const next = new Set(x);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="review" aria-label="Review" ref={sectionRef} tabIndex={-1}>
      {askRow}
      <ApproveResultLine result={approveAll.result} focusedId={approveAll.focusedId} />
      <AiSuggestionsSection
        rows={rows}
        approve={approveAll}
        scanRunning={state.scanRunning}
        expanded={expanded}
        onToggle={toggleRow}
        renderQuestion={(row) => (
          <ReviewQuestion
            key={`${row.item.id}|${reviewSignature(row.item)}`}
            item={row.item}
            homeDepotLink={homeDepotLinkOf(row.item)}
            scanRunning={state.scanRunning}
            onSave={saveFor(row.item, true)}
            ai={aiFor(row.item)}
          />
        )}
      />
      {accept}
      {entry ? (
        <>
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
              onSave={saveFor(item, false)}
              onNotNow={notNow}
              ai={aiFor(item)}
            />
          ) : 'ebay' in entry ? (
            <EbayQuestion key={entry.key} question={entry.ebay} scanRunning={state.scanRunning} focusHeading={focusNext} onSave={saveEbay} onNotNow={notNow} />
          ) : null}
        </>
      ) : (
        <p className="review-empty" ref={emptyRef} tabIndex={-1}>
          Nothing else needs your answer.
        </p>
      )}
    </section>
  );
}
