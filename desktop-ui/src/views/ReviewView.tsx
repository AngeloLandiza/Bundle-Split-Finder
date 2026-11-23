import { approvalOf, verifiedRows, type VerifiedRow } from '@core/assist/approve';
import { askQueueOf, canAsk } from '@core/assist/askAll';
import { askAllCostLabel, questionCostLabel } from '@core/assist/cost';
import { liveSuggestion, type StoredSuggestion } from '@core/assist/stored';
import { DEFAULT_CLAUDE_JUDGE_MODEL } from '@core/judge/claude';
import type { ReviewAnswer, ReviewItem } from '@core/scan/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type EbayReviewQuestion, type ReviewQuestion } from '../api';

function queueAnswerFromReview(answer: ReviewAnswer) {
  if ('none' in answer && answer.none) return { none: true as const };
  if ('parts' in answer && answer.parts) return { parts: answer.parts };
  if ('choice' in answer) return { choice: answer.choice };
  return { none: true as const };
}

type QueueItem =
  | { kind: 'review'; openedAt: number; question: ReviewQuestion }
  | { kind: 'ebay'; openedAt: number; question: EbayReviewQuestion };

export function ReviewView() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [line, setLine] = useState('Loading review…');
  const [busy, setBusy] = useState(false);
  const [typedParts, setTypedParts] = useState('');
  const [aiSuggestions, setAiSuggestions] = useState<StoredSuggestion[]>([]);
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [askAiAllRunning, setAskAiAllRunning] = useState(false);
  const [judgeModel, setJudgeModel] = useState(DEFAULT_CLAUDE_JUDGE_MODEL);
  const [aiLine, setAiLine] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.review().then((r) => {
      const review = r.questions ?? [];
      const ebay = r.ebayQuestions ?? [];
      if (!r.ok || (!review.length && !ebay.length)) {
        setLine(r.message ?? 'No open review questions.');
        setQueue([]);
        return;
      }
      const merged: QueueItem[] = [
        ...review.map((q) => ({ kind: 'review' as const, openedAt: q.openedAt ?? 0, question: q })),
        ...ebay.map((q) => ({ kind: 'ebay' as const, openedAt: q.openedAt, question: q })),
      ].sort((a, b) => a.openedAt - b.openedAt);
      setLine(`${merged.length} open. Answers sync to the helper within a minute.`);
      setQueue(merged);
      setAiSuggestions(r.aiSuggestions ?? []);
    });
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    void api.settings().then((s) => {
      if (s.ok && s.ebaySettings?.judgeModel) setJudgeModel(s.ebaySettings.judgeModel);
      if (s.ok) setHasAnthropicKey((prev) => prev || s.anthropicKeySet === true);
    });
    const poll = () => {
      void fetch('/api/state')
        .then((r) => r.json())
        .then((body) => {
          const st = body as { ok?: boolean; hasAnthropicKey?: boolean; askAiAllRunning?: boolean };
          if (st.ok) {
            setHasAnthropicKey(st.hasAnthropicKey === true);
            setAskAiAllRunning(st.askAiAllRunning === true);
          }
        })
        .catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, 15_000);
    return () => window.clearInterval(id);
  }, []);

  const reviewItems = useMemo(
    () =>
      queue
        .filter((x): x is Extract<QueueItem, { kind: 'review' }> => x.kind === 'review')
        .map((x) => x.question as unknown as ReviewItem),
    [queue],
  );

  const askable = useMemo(() => askQueueOf(reviewItems, aiSuggestions), [reviewItems, aiSuggestions]);
  const verified = useMemo(() => verifiedRows(reviewItems, aiSuggestions), [reviewItems, aiSuggestions]);
  const askAllCost = useMemo(
    () => askAllCostLabel(askable.map((q) => q.kind), judgeModel),
    [askable, judgeModel],
  );

  const current = queue[0];

  const askOne = (questionId: string) => {
    setAiLine('Queued for the helper.');
    void api.askReview(questionId);
  };

  const askAll = () => {
    setAiLine('Queued Ask AI about all for the helper.');
    void api.askAllReview();
  };

  const approveAllVerified = (rows: readonly VerifiedRow[]) => {
    if (!rows.length) return;
    setBusy(true);
    setAiLine(null);
    void Promise.all(
      rows.map((row) => {
        const answer = queueAnswerFromReview(row.answer);
        return api.queueReview(row.item.id, answer, true);
      }),
    )
      .then(() => {
        setLine('Queued verified AI approvals for the helper.');
        setQueue((q) => q.filter((x) => !rows.some((r) => r.item.id === x.question.id)));
      })
      .finally(() => setBusy(false));
  };

  const aiToolbar =
    hasAnthropicKey && (askable.length > 0 || verified.length > 0 || askAiAllRunning) ? (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {askable.length >= 2 || askAiAllRunning ? (
          <button type="button" className="btn" disabled={busy || askAiAllRunning} onClick={askAll}>
            {askAiAllRunning ? 'Asking…' : `Ask AI about all ${askable.length}`}
            {askAllCost && !askAiAllRunning ? ` (${askAllCost})` : ''}
          </button>
        ) : null}
        {verified.length > 0 ? (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => approveAllVerified(verified)}>
            Approve all verified ({verified.length})
          </button>
        ) : null}
        {aiLine ? <span className="copy-muted">{aiLine}</span> : null}
      </div>
    ) : !hasAnthropicKey ? (
      <p className="copy-muted" style={{ marginTop: 8 }}>
        Add an Anthropic key in Settings to run Ask AI from the app.
      </p>
    ) : null;

  const answer = (
    id: string,
    answer: { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' },
    aiSuggestion?: boolean,
  ) => {
    setBusy(true);
    void api
      .queueReview(id, answer, aiSuggestion)
      .then((r) => {
        if (r.ok) {
          setQueue((q) => q.filter((x) => x.question.id !== id));
          setLine('Queued for the helper.');
          setTypedParts('');
        } else setLine('Could not queue answer.');
      })
      .finally(() => setBusy(false));
  };

  const ebayLine = useMemo(() => {
    if (!current || current.kind !== 'ebay') return null;
    const q = current.question;
    return `Is this eBay listing exactly ${q.model}, New, with the same contents?`;
  }, [current]);

  if (!current) {
    return (
      <section className="band">
        <p className="label">Review</p>
        <p className="copy-muted">{line}</p>
        {aiToolbar}
      </section>
    );
  }

  if (current.kind === 'ebay') {
    const q = current.question;
    return (
      <section className="band">
        <p className="label">Review</p>
        <p className="copy-muted">{line}</p>
        {aiToolbar}
        <div className="review-card" style={{ marginTop: 12 }}>
          <p style={{ fontWeight: 600, margin: '0 0 8px' }}>{ebayLine}</p>
          <div className="deal-sub">
            {q.brand} · <span className="mono">{q.model}</span> · eBay listing
          </div>
          <p className="copy-muted" style={{ marginTop: 8 }}>
            {q.title}
          </p>
          {q.price !== null ? (
            <p className="mono figure">
              ${q.price.toFixed(2)}
              {q.soldQuantity !== null ? ` · ${q.soldQuantity} sold` : ''}
            </p>
          ) : null}
          {q.url.startsWith('http') ? (
            <a className="firstrun-link" href={q.url} target="_blank" rel="noopener noreferrer">
              Open listing
            </a>
          ) : null}
          <ul className="copy-muted" style={{ margin: '12px 0', paddingLeft: 18 }}>
            {q.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => answer(q.id, { ebay: 'yes' })}>
              Yes — counts as reference
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => answer(q.id, { ebay: 'no' })}>
              No
            </button>
          </div>
        </div>
      </section>
    );
  }

  const q = current.question;
  const item = q as unknown as ReviewItem;
  const stored = liveSuggestion(aiSuggestions, item);
  const aiApproval = stored ? approvalOf(stored.suggestion, item) : null;
  const askCost = questionCostLabel(item.kind, judgeModel);
  const mayAsk = hasAnthropicKey && canAsk(item) && !stored;

  return (
    <section className="band">
      <p className="label">Review</p>
      <p className="copy-muted">{line}</p>
      {aiToolbar}
      <div className="review-card" style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 600 }}>{q.title ?? q.model}</div>
        <div className="deal-sub">
          {q.brand} · <span className="mono">{q.model}</span> · {q.kind}
        </div>
        <p className="copy-muted">{q.reason}</p>
        {mayAsk ? (
          <button type="button" className="btn btn-secondary" disabled={busy || askAiAllRunning} onClick={() => askOne(q.id)}>
            Ask AI{askCost ? ` (${askCost})` : ''}
          </button>
        ) : null}
        {aiApproval && stored?.suggestion.status === 'verified' ? (
          <div className="estimate" style={{ marginTop: 8 }}>
            <p className="copy-muted" style={{ margin: '0 0 8px' }}>
              AI suggestion (verified): {stored.suggestion.reason}
            </p>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => answer(q.id, queueAnswerFromReview(aiApproval), true)}
            >
              Approve AI suggestion
            </button>
          </div>
        ) : null}
        {q.kind === 'split'
          ? q.choices.length
            ? q.choices.map((parts, i) => (
                <button key={i} type="button" className="choice" disabled={busy} onClick={() => answer(q.id, { choice: i })}>
                  {parts.join(', ')}
                </button>
              ))
            : (
                <p className="copy-muted">No split choices yet — type parts below or open the helper panel for this bundle.</p>
              )
          : (q.candidates ?? []).length
            ? (q.candidates ?? []).map((c, i) => (
                <button key={c.asin} type="button" className="choice" disabled={busy} onClick={() => answer(q.id, { choice: i })}>
                  {c.title ?? c.asin}
                </button>
              ))
            : (
                <p className="copy-muted">No Amazon candidates on file — mark none or finish this match in the helper panel.</p>
              )}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => answer(q.id, { none: true })}>
          None of these
        </button>
        {q.kind === 'split' ? (
          <>
            <label className="copy-muted" htmlFor="parts">
              Or type parts (comma-separated)
            </label>
            <input
              id="parts"
              value={typedParts}
              onChange={(e) => setTypedParts(e.target.value)}
              style={{ width: '100%', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !typedParts.trim()}
              onClick={() =>
                answer(q.id, { parts: typedParts.split(',').map((p) => p.trim()).filter(Boolean) })
              }
            >
              Save typed parts
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}