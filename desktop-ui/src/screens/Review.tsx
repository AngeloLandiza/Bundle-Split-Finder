import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { ReviewAnswer, ReviewQuestion } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { useMenu } from '../components/ContextMenu';
import { SearchField, TextField } from '../components/Fields';
import { InspectorSplit, Kbd } from '../components/Layout';
import { Page } from '../components/Page';
import type { RowMenu } from '../components/Table';
import { SourceLink } from '../components/Source';
import { ConfirmInline, EmptyState, LoadError, LoadingState, Notice, ScanStrip } from '../components/States';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { money, plural } from '../lib/format';
import { scanStrip } from '../lib/scanSteps';
import { copyText, openPage } from '../lib/actions';
import { AI_FOOTNOTE, aiIntroDismissed, dismissAiIntro } from '../lib/aiIntro';
import { isMenuKey, pressOf, reviewKey } from '../lib/keys';
import { formatShortcut, isMac } from '../lib/platform';
import { questionMenu, type QuestionMenuId } from '../lib/menus';
import { SCREEN_KEYS } from '../lib/notices';
import { briefFor, rowState } from '../lib/reviewBrief';
import { DecisionCard, Details } from './ReviewCard';
import { KIND_LABEL, SAVED_ROW_MS, groupQuestions, parseTyped, preselected, rowChip, saveHint, typedFromSuggestion } from './reviewModel';
import './Review.css';

const NONE = '__none';
const TYPED = '__typed';

/** Open questions in the content, grouped AI verified then Needs you; the chosen one in the inspector. */
export function ReviewScreen({ openId }: { openId: string | null }) {
  const { navigate, state } = useApp();
  const ui = useUi();
  const [res, reload] = useResource(() => api.review(), [], ['review']);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Only applied answers are counted as approved; the ones the agent would not apply say why.
  const approveIds = useCallback(async (ids: string[]) => {
    const r = await api.approve(ids);
    setNotice(r.skipped.length ? `Approved ${r.approved}. Not applied: ${r.skipped.map((x) => x.reason).join(' ')}` : `Approved ${plural(r.approved, 'answer', 'answers')}.`);
  }, []);
  const approve = useAction(approveIds);
  const askAll = useAction(api.askAll);

  const all = res.data?.questions ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((x) => `${x.bundle.title} ${x.bundle.model} ${x.subject} ${x.prompt}`.toLowerCase().includes(q)) : all;
  }, [all, query]);
  const groups = groupQuestions(shown);
  const ordered = [...groups.verified, ...groups.needsYou];
  const current = ordered.find((q) => q.id === openId) ?? ordered[0] ?? null;

  const select = (q: ReviewQuestion | undefined) => {
    if (!q) return;
    ui.setInspectorShown(true);
    navigate({ screen: 'review', id: q.id });
  };
  const move = (step: number) => {
    const i = current ? ordered.indexOf(current) : -1;
    select(ordered[Math.max(0, Math.min(ordered.length - 1, i + step))]);
  };
  // Saved: the next question opens with its choice focused, the list follows, and what was saved stays said until the next save.
  const [saved, setSaved] = useState<{ said: string; answerId: string | null } | null>(null);
  const [focusChoice, setFocusChoice] = useState(false);
  const afterSave = (said: string, answerId: string | null) => {
    const i = current ? ordered.indexOf(current) : -1;
    const next = ordered[i + 1] ?? ordered[i - 1];
    setSaved({ said, answerId });
    setFocusChoice(true);
    if (next) navigate({ screen: 'review', id: next.id });
  };
  const hasNext = current ? ordered.indexOf(current) < ordered.length - 1 : false;

  const clearSaved = useCallback(() => setSaved(null), []);
  // Undo of the answer just saved: the question is open in Review again and selected; the row says so and goes.
  const undoSaved = useCallback(
    async (answerId: string) => {
      const r = await api.undoAnswer(answerId);
      setSaved(null);
      setNotice('Undone. The question is back in the list.');
      navigate({ screen: 'review', id: r.questionId });
    },
    [navigate],
  );
  const undo = useAction(undoSaved);
  // Cmd/Ctrl+Z takes back the answer in the row (never one he can no longer see), except in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      if (reviewKey(pressOf(e))?.type !== 'undo' || !saved?.answerId || undo.busy) return;
      e.preventDefault();
      void undo.run(saved.answerId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The right-click menu of a question row (design.md, Context menus).
  const [menuError, setMenuError] = useState<string | null>(null);
  const hasAi = Boolean(state?.keys.anthropic || state?.keys.openai);
  const menuOf = (q: ReviewQuestion): RowMenu => ({
    label: q.bundle.title,
    items: questionMenu(q, { hasAi, asking: state?.agent.status === 'asking' }),
    onPick: (id) => {
      setMenuError(null);
      const fail = (e: unknown) => setMenuError(e instanceof Error ? e.message : 'That did not work. Try again.');
      switch (id as QuestionMenuId) {
        case 'ask':
          api.ask(q.id).catch(fail);
          return;
        case 'approve':
          void approveIds([q.id]).catch(fail);
          return;
        case 'open-deal':
          if (q.bundle.id) navigate({ screen: 'deals', id: q.bundle.id });
          return;
        case 'open-hd':
          if (!openPage(q.bundle.link)) setMenuError('Home Depot’s page could not be opened.');
          return;
        case 'copy-question':
          void copyText(q.prompt).then((ok) => (ok ? setNotice('Copied the question.') : setMenuError('Could not copy. Select the question by hand.')));
          return;
      }
    },
  });

  const askable = all.filter((q) => q.askCostUsd !== null && q.suggestion === null);
  const askCost = askable.reduce((s, q) => s + (q.askCostUsd ?? 0), 0);
  const asking = state?.agent.status === 'asking';
  const scanLine = state ? scanStrip(state.agent) : null;

  const sub = res.data ? (all.length ? `${plural(all.length, 'open question', 'open questions')} · answers apply at once` : 'No open questions') : undefined;

  const list = (
    <div className="review">
      {scanLine ? <ScanStrip text={scanLine} /> : null}
      {saved ? <SavedRow saved={saved} busy={undo.busy} error={undo.error} onUndo={(id) => void undo.run(id)} onGone={clearSaved} /> : null}
      {askAll.error || approve.error || menuError || notice ? (
        <Notice tone={askAll.error || approve.error || menuError ? 'attention' : 'quiet'}>{askAll.error ?? approve.error ?? menuError ?? notice}</Notice>
      ) : null}
      <div className="list-scroll">
        {res.status === 'loading' ? <LoadingState label="Loading questions" /> : null}
        {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={reload} /> : null}
        {res.data && all.length === 0 ? (
          <EmptyState
            title="Nothing to review"
            cause={state?.counts.autopilotApplied ? `Autopilot applied ${plural(state.counts.autopilotApplied, 'answer', 'answers')} after the last scan; check them in Activity. New questions come with the next scan.` : 'Every split and match the agent found is certain. New questions come with the next scan.'}
            action={state?.counts.autopilotApplied ? <Button onClick={() => navigate({ screen: 'activity', id: null })}>Open Activity</Button> : null}
          />
        ) : null}
        {all.length > 0 && shown.length === 0 ? <EmptyState title="No question matches" cause={`No question has “${query}” in its bundle or model.`} action={<Button onClick={() => setQuery('')}>Clear the search</Button>} /> : null}
        {groups.verified.length ? (
          <section className="qgroup" aria-labelledby="qgroup-verified">
            <div className="qgroup-head">
              <h2 id="qgroup-verified">
                AI verified <span className="fig muted">{groups.verified.length}</span>
              </h2>
              {confirming ? (
                <ConfirmInline
                  question={
                    <>
                      Approve <span className="fig">{confirming.length}</span> AI {confirming.length === 1 ? 'answer' : 'answers'}?
                    </>
                  }
                  confirmLabel="Approve"
                  busy={approve.busy}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => void approve.run(confirming).then(() => setConfirming(null))}
                />
              ) : (
                <LinkButton onClick={() => setConfirming(groups.verified.map((q) => q.id))}>
                  Approve all <span className="fig">{groups.verified.length}</span>
                </LinkButton>
              )}
            </div>
            <QuestionList questions={groups.verified} current={current} onSelect={select} menuOf={menuOf} />
          </section>
        ) : null}
        {groups.needsYou.length ? (
          <section className="qgroup" aria-labelledby="qgroup-you">
            <div className="qgroup-head">
              <h2 id="qgroup-you">
                Needs you <span className="fig muted">{groups.needsYou.length}</span>
              </h2>
            </div>
            <QuestionList questions={groups.needsYou} current={current} onSelect={select} menuOf={menuOf} />
          </section>
        ) : null}
      </div>
      {all.length > 0 ? (
        <p className="status-bar review-keys">
          <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>1</Kbd>–<Kbd>9</Kbd> choose · <Kbd>↩</Kbd> {saveHint({ hasAnswer: true, hasNext }).replace('↩ ', '')} · <Kbd>A</Kbd> ask AI
        </p>
      ) : null}
    </div>
  );

  return (
    <Page
      title="Review"
      sub={sub}
      inspector
      keys={SCREEN_KEYS.review}
      search={all.length ? <SearchField label="Search questions" placeholder="Bundle or model" value={query} onChange={setQuery} /> : null}
      actions={
        // While the AI runs the toolbar's own status and Stop are the one indicator; this button is not shown a second time.
        askable.length >= 2 && state?.keys.anthropic && !asking ? (
          <Button variant="toolbar" busy={askAll.busy} busyLabel="Starting…" onClick={() => void askAll.run()} cost={`about ${money(Math.ceil(askCost))}`}>
            Ask AI about all {askable.length}
          </Button>
        ) : null
      }
    >
      <InspectorSplit
        main={list}
        min={420}
        label="Question"
        empty="No question selected"
        inspector={
          current ? (
            <Question
              key={current.id}
              q={current}
              hasAi={Boolean(state?.keys.anthropic || state?.keys.openai)}
              hasNext={hasNext}
              focusChoice={focusChoice}
              onMove={move}
              onSaved={afterSave}
              onEscape={() => setConfirming(null)}
              onOpenDeal={current.bundle.id ? () => navigate({ screen: 'deals', id: current.bundle.id }) : null}
            />
          ) : null
        }
      />
    </Page>
  );
}

/**
 * "Saved · what · Undo", at the top of the list for SAVED_ROW_MS: inline, not a toast. It stays while the pointer or
 * focus is on it or Undo has failed (its sentence is there to read), and Cmd/Ctrl+Z does what its button does.
 */
function SavedRow({ saved, busy, error, onUndo, onGone }: { saved: { said: string; answerId: string | null }; busy: boolean; error: string | null; onUndo: (id: string) => void; onGone: () => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || busy || error) return;
    const t = window.setTimeout(onGone, SAVED_ROW_MS);
    return () => window.clearTimeout(t);
    // The row restarts its eight seconds for each new save, and while it is held, busy or in error it does not run.
  }, [saved, held, busy, error, onGone]);
  return (
    <div className="review-saved" role="status" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <span className="review-saved-text">Saved · {saved.said}</span>
      {saved.answerId ? (
        <>
          {error ? <span className="review-saved-error">{error}</span> : null}
          <button type="button" className="link-btn" disabled={busy} onClick={() => onUndo(saved.answerId!)}>
            {busy ? 'Undoing…' : 'Undo'}
          </button>
          <Kbd>{formatShortcut(['mod', 'Z'], isMac)}</Kbd>
        </>
      ) : null}
    </div>
  );
}

function QuestionList({ questions, current, onSelect, menuOf }: { questions: ReviewQuestion[]; current: ReviewQuestion | null; onSelect: (q: ReviewQuestion) => void; menuOf: (q: ReviewQuestion) => RowMenu }) {
  const ctx = useMenu();
  const list = useRef<HTMLUListElement>(null);
  // The list follows the open question, so moving on with the keyboard never leaves it out of sight.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current?.id]);
  return (
    <ul className="qlist" ref={list}>
      {questions.map((q) => (
        <li key={q.id}>
          <button
            type="button"
            className="qitem"
            aria-current={q.id === current?.id || undefined}
            onClick={() => onSelect(q)}
            onContextMenu={(e) => ctx.openFrom(e, menuOf(q))}
            onKeyDown={(e) => {
              if (isMenuKey({ key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey })) ctx.openFrom(e, menuOf(q));
            }}
          >
            <span className="qitem-main">
              <span className="qitem-title code" title={q.bundle.title}>
                {q.bundle.model}
              </span>
              <span className="qitem-sub">
                {q.bundle.brand} · {KIND_LABEL[q.kind]}
              </span>
            </span>
            <RowState q={q} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a list row says: two to four words from the card's state ("Suggested: 2 parts", "AI could not tell", "Needs a
 * listing"), never a title. A green Verified tag only for an answer the code checked, so "Approve all" has something to
 * point at; the rest is quiet words. The card in the pane says why.
 */
function RowState({ q }: { q: ReviewQuestion }) {
  const text = rowState(q);
  if (rowChip(q.suggestion) === 'verified') return <Tag tone="verified">{text}</Tag>;
  return <span className="qitem-ai">{text}</span>;
}

function Question({
  q,
  hasAi,
  hasNext,
  focusChoice,
  onMove,
  onSaved,
  onEscape,
  onOpenDeal,
}: {
  q: ReviewQuestion;
  hasAi: boolean;
  hasNext: boolean;
  /** Focus goes to the selected choice: he just saved the one before and the keyboard follows. */
  focusChoice: boolean;
  onMove: (step: number) => void;
  onSaved: (said: string, answerId: string | null) => void;
  onEscape: () => void;
  onOpenDeal: (() => void) | null;
}) {
  const pre = preselected(q);
  const typedStart = typedFromSuggestion(q);
  const [choice, setChoice] = useState<string | null>(pre ?? (typedStart ? TYPED : null));
  const [typed, setTyped] = useState(typedStart);
  // The agent's id for the answer just saved, which the row above the list undoes by.
  const answerId = useRef<string | null>(null);
  const saveAnswer = useCallback(async (...args: Parameters<typeof api.answer>) => {
    answerId.current = (await api.answer(...args)).answerId;
  }, []);
  const save = useAction(saveAnswer);
  const ask = useAction(api.ask);
  const form = useRef<HTMLFormElement>(null);
  // The question as the owner first saw it. An event may bring a changed question (a scan moved the choices) while he
  // reads; his half-typed answer stays, but it is not sent against choices he has not seen: the agent would refuse it
  // too. He is told, and can look at the question as it is now.
  const [seen, setSeen] = useState(q.seen);
  const changed = q.seen !== seen;
  const s = q.suggestion;
  const [intro, setIntro] = useState(() => !aiIntroDismissed());
  // The saved answer is the AI's when it is the choice it named (or the parts it typed): its outcome is tracked either way.
  const fromAi = s !== null && ((pre !== null && choice === pre) || (typedStart !== '' && choice === TYPED && typed === typedStart));

  const answerOf = (): { answer: ReviewAnswer; said: string } | null => {
    if (!choice) return null;
    if (q.kind === 'ebay') return { answer: { ebay: choice === 'yes' ? 'yes' : 'no' }, said: choice === 'yes' ? 'Yes' : 'No' };
    if (choice === NONE) return { answer: { none: true }, said: 'None of these' };
    if (choice === TYPED) {
      const parts = parseTyped(typed);
      return parts.length ? { answer: { parts }, said: parts.join(' + ') } : null;
    }
    return { answer: { choiceId: choice }, said: q.choices.find((c) => c.id === choice)?.label ?? 'the answer' };
  };
  const submit = () => {
    const a = answerOf();
    if (!a || save.busy || changed) return;
    void save.run(q.id, a.answer, { fromSuggestion: fromAi, seen }).then((ok) => ok && onSaved(`${q.bundle.model}: ${a.said}`, answerId.current));
  };

  const optionIds = [...q.choices.map((c) => c.id), ...(q.allowNone ? [NONE] : []), ...(q.allowTyped ? [TYPED] : [])];

  // After a save the next question opens with its selected choice focused, so Enter again saves it.
  useEffect(() => {
    if (!focusChoice) return;
    const root = form.current;
    (root?.querySelector<HTMLInputElement>('input:checked') ?? root?.querySelector<HTMLInputElement>('input'))?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const a = reviewKey(pressOf(e));
      if (!a) return;
      if (a.type === 'next' || a.type === 'prev') {
        e.preventDefault();
        onMove(a.type === 'next' ? 1 : -1);
      } else if (a.type === 'choose') {
        const id = optionIds[a.index];
        if (id) {
          e.preventDefault();
          setChoice(id);
          form.current?.querySelector<HTMLInputElement>(`input[value="${CSS.escape(id)}"]`)?.focus();
        }
      } else if (a.type === 'save') {
        e.preventDefault();
        submit();
      } else if (a.type === 'ask') {
        if (hasAi && q.askCostUsd !== null && !ask.busy) {
          e.preventDefault();
          void ask.run(q.id);
        }
      } else if (a.type === 'close') {
        onEscape();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const brief = briefFor(q);
  const cardId = `card-${q.id}`;
  const suggestedMark = (id: string) => (pre === id && s ? <span className="choice-suggested">Suggested</span> : null);

  return (
    <article className="question view-enter" aria-labelledby={`q-${q.id}`}>
      <div className="question-body">
        <header className="question-head">
          <h2 className="question-prompt" id={`q-${q.id}`}>
            {brief.ask}
          </h2>
          <p className="question-bundle" title={`${q.bundle.brand} ${q.bundle.model} · ${q.bundle.title}`}>
            <span className="code">{q.bundle.model}</span> · {q.bundle.title}
          </p>
          <p className="question-links">
            <SourceLink source={{ label: 'Home Depot page', url: q.bundle.link }} />
            {onOpenDeal ? <LinkButton onClick={onOpenDeal}>Open the deal</LinkButton> : null}
          </p>
        </header>

        {changed ? (
          <Notice
            tone="attention"
            title="This question changed while you were reading."
            action={
              <Button
                size="sm"
                onClick={() => {
                  setSeen(q.seen);
                  setChoice(preselected(q));
                }}
              >
                Show it as it is now
              </Button>
            }
          >
            A scan moved its choices, so your pick may mean something else.
          </Notice>
        ) : null}

        <div className="card-wrap">
          <DecisionCard brief={brief} id={cardId} fromAi={s !== null} />
          {s && intro ? (
            <p className="ai-footnote" role="note">
              <span>{AI_FOOTNOTE}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  dismissAiIntro();
                  setIntro(false);
                }}
              >
                Got it
              </button>
            </p>
          ) : null}
        </div>

        <form
          ref={form}
          id={`form-${q.id}`}
          className="question-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset className="choices">
            <legend className="question-section-title">Your answer</legend>
            <div className="choice-box">
              {q.choices.map((c, i) => (
                <div key={c.id} className="choice-item">
                  <label className={`choice${choice === c.id ? ' choice-on' : ''}`}>
                    <input type="radio" name={`a-${q.id}`} value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} aria-describedby={pre === c.id ? cardId : undefined} />
                    <span className="choice-text">
                      <span className={c.models.length && !c.asin ? 'code choice-label' : 'choice-label'} title={c.label}>
                        {c.label}
                      </span>
                      {c.asin ? (
                        <span className="choice-sub">
                          <span className="code">{c.asin}</span> {c.source ? <SourceLink source={c.source} /> : null}
                        </span>
                      ) : null}
                    </span>
                    {suggestedMark(c.id)}
                    <Kbd>{i + 1}</Kbd>
                  </label>
                </div>
              ))}
              {q.allowNone ? (
                <div className="choice-item">
                  <label className={`choice${choice === NONE ? ' choice-on' : ''}`}>
                    <input type="radio" name={`a-${q.id}`} value={NONE} checked={choice === NONE} onChange={() => setChoice(NONE)} />
                    <span className="choice-text">
                      <span className="choice-label">None of these</span>
                    </span>
                    <Kbd>{q.choices.length + 1}</Kbd>
                  </label>
                </div>
              ) : null}
              {q.allowTyped ? (
                <div className="choice-item">
                  <label className={`choice${choice === TYPED ? ' choice-on' : ''}`}>
                    <input type="radio" name={`a-${q.id}`} value={TYPED} checked={choice === TYPED} onChange={() => setChoice(TYPED)} aria-describedby={typedStart && s ? cardId : undefined} />
                    <span className="choice-text">
                      <span className="choice-label">Enter the parts</span>
                      {typedStart ? <span className="choice-sub">Filled in from the AI suggestion</span> : null}
                    </span>
                    {typedStart && s ? <span className="choice-suggested">Suggested</span> : null}
                    <Kbd>{q.choices.length + (q.allowNone ? 2 : 1)}</Kbd>
                  </label>
                </div>
              ) : null}
            </div>
            {q.allowTyped && choice === TYPED ? (
              <TextField label="Models, separated by commas" value={typed} onChange={(e) => setTyped(e.target.value)} mono placeholder="DCF921B, DCD708B" autoFocus={!typedStart} />
            ) : null}
          </fieldset>
        </form>

        <Details q={q} s={s} />
      </div>

      <footer className="question-actions">
        {save.error || ask.error ? (
          <span className="question-error" role="alert">
            {save.error ?? ask.error}
          </span>
        ) : (
          <span className="question-meta">{!answerOf() ? <span>{saveHint({ hasAnswer: false, hasNext })}</span> : null}</span>
        )}
        {hasAi && q.kind !== 'ebay' && !s ? (
          <Button busy={ask.busy} busyLabel="Asking…" onClick={() => void ask.run(q.id)} cost={q.askCostUsd !== null ? `about ${money(q.askCostUsd)}` : undefined}>
            Ask AI
          </Button>
        ) : null}
        <Button type="submit" form={`form-${q.id}`} variant="primary" busy={save.busy} busyLabel="Saving…" disabled={!answerOf() || changed}>
          {hasNext ? 'Save and next' : 'Save answer'}
        </Button>
      </footer>
    </article>
  );
}
