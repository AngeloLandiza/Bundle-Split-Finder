import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { ReviewAnswer, ReviewQuestion } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { useMenu } from '../components/ContextMenu';
import { SearchField, TextField } from '../components/Fields';
import { InspectorSplit, Kbd } from '../components/Layout';
import { Page } from '../components/Page';
import type { RowMenu } from '../components/Table';
import { Quote, SourceLink } from '../components/Source';
import { ConfirmInline, EmptyState, LoadError, LoadingState, Notice } from '../components/States';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { money, plural } from '../lib/format';
import { copyText, openPage } from '../lib/actions';
import { isMenuKey, pressOf, reviewKey } from '../lib/keys';
import { questionMenu, type QuestionMenuId } from '../lib/menus';
import { KIND_LABEL, groupQuestions, parseTyped, preselected, typedFromSuggestion } from './reviewModel';
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
  const afterAnswer = () => {
    const i = current ? ordered.indexOf(current) : -1;
    const next = ordered[i + 1] ?? ordered[i - 1];
    if (next) navigate({ screen: 'review', id: next.id });
  };

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

  const sub = res.data ? (all.length ? `${plural(all.length, 'open question', 'open questions')} · answers apply at once` : 'No open questions') : undefined;

  const list = (
    <div className="review">
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
          <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>1</Kbd>–<Kbd>9</Kbd> choose · <Kbd>↩</Kbd> save · <Kbd>A</Kbd> ask AI
        </p>
      ) : null}
    </div>
  );

  return (
    <Page
      title="Review"
      sub={sub}
      inspector
      search={all.length ? <SearchField label="Search questions" placeholder="Bundle or model" value={query} onChange={setQuery} /> : null}
      actions={
        askable.length >= 2 && state?.keys.anthropic ? (
          <Button variant="toolbar" busy={askAll.busy || asking} busyLabel="Asking AI…" onClick={() => void askAll.run()} cost={`about ${money(Math.ceil(askCost))}`}>
            Ask AI about all {askable.length}
          </Button>
        ) : null
      }
    >
      <InspectorSplit
        main={list}
        min={440}
        label="Question"
        empty="No question selected"
        inspector={
          current ? (
            <Question
              key={current.id}
              q={current}
              hasAi={Boolean(state?.keys.anthropic || state?.keys.openai)}
              onMove={move}
              onDone={afterAnswer}
              onEscape={() => setConfirming(null)}
              onOpenDeal={current.bundle.id ? () => navigate({ screen: 'deals', id: current.bundle.id }) : null}
            />
          ) : null
        }
      />
    </Page>
  );
}

function QuestionList({ questions, current, onSelect, menuOf }: { questions: ReviewQuestion[]; current: ReviewQuestion | null; onSelect: (q: ReviewQuestion) => void; menuOf: (q: ReviewQuestion) => RowMenu }) {
  const ctx = useMenu();
  return (
    <ul className="qlist">
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
              <span className="qitem-title" title={q.bundle.title}>
                {q.bundle.title}
              </span>
              <span className="qitem-sub">
                {KIND_LABEL[q.kind]} · <span className="code">{q.subject}</span>
              </span>
            </span>
            {q.suggestion?.status === 'verified' ? <Tag tone="verified">AI verified</Tag> : q.suggestion?.status === 'unverified' ? <Tag>AI unsure</Tag> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Question({ q, hasAi, onMove, onDone, onEscape, onOpenDeal }: { q: ReviewQuestion; hasAi: boolean; onMove: (step: number) => void; onDone: () => void; onEscape: () => void; onOpenDeal: (() => void) | null }) {
  const pre = preselected(q);
  const typedStart = typedFromSuggestion(q);
  const [choice, setChoice] = useState<string | null>(pre ?? (typedStart ? TYPED : null));
  const [typed, setTyped] = useState(typedStart);
  const save = useAction(api.answer);
  const ask = useAction(api.ask);
  const form = useRef<HTMLFormElement>(null);
  // The question as the owner first saw it. An event may bring a changed question (a scan moved the choices) while he
  // reads; his half-typed answer stays, but it is not sent against choices he has not seen: the agent would refuse it
  // too. He is told, and can look at the question as it is now.
  const [seen, setSeen] = useState(q.seen);
  const changed = q.seen !== seen;
  const s = q.suggestion;
  const aiAnswer = s?.status === 'verified' && ((pre !== null && choice === pre) || (typedStart !== '' && choice === TYPED && typed === typedStart));

  const answerOf = (): ReviewAnswer | null => {
    if (!choice) return null;
    if (q.kind === 'ebay') return { ebay: choice === 'yes' ? 'yes' : 'no' };
    if (choice === NONE) return { none: true };
    if (choice === TYPED) {
      const parts = parseTyped(typed);
      return parts.length ? { parts } : null;
    }
    return { choiceId: choice };
  };
  const submit = () => {
    const a = answerOf();
    if (!a || save.busy || changed) return;
    void save.run(q.id, a, { fromSuggestion: aiAnswer, seen }).then((ok) => ok && onDone());
  };

  const optionIds = [...q.choices.map((c) => c.id), ...(q.allowNone ? [NONE] : []), ...(q.allowTyped ? [TYPED] : [])];

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

  return (
    <article className="question view-enter" aria-labelledby={`q-${q.id}`}>
      <div className="question-body">
        <header className="question-head">
          <p className="question-kind">{KIND_LABEL[q.kind]}</p>
          <h2 className="question-prompt" id={`q-${q.id}`}>
            {q.prompt}
          </h2>
          <p className="question-bundle">
            {q.bundle.brand} · <span className="code">{q.bundle.model}</span> · {q.bundle.title}
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

        <section className="question-section">
          <h3 className="question-section-title">Why it is asked</h3>
          <p>{q.reason}</p>
          {q.evidence.map((ev, i) => (
            <Quote key={i} quote={ev} />
          ))}
        </section>

        {s ? (
          <section className={`ai${s.status === 'verified' ? ' ai-verified' : ' ai-unsure'}`} aria-label="AI suggestion">
            <div className="ai-head">
              <h3 className="question-section-title">{s.status === 'verified' ? 'AI suggestion' : s.status === 'unverified' ? 'AI suggestion, unverified' : 'AI could not tell'}</h3>
              {s.status === 'verified' ? <Tag tone="verified">Verified</Tag> : null}
            </div>
            {s.status === 'cannot_tell' ? (
              <p>
                AI could not tell from the page. <span className="muted">{s.reason}</span>
              </p>
            ) : (
              <>
                <p className={`ai-answer${s.status === 'verified' ? '' : ' ai-claimed'}${q.kind === 'split' ? ' code' : ''}`}>{s.answer}</p>
                {s.status === 'unverified' && s.reason ? <p className="muted">{s.reason} Choose yourself.</p> : null}
              </>
            )}
            {s.quotes.slice(0, 3).map((qt, i) => (
              <Quote key={i} quote={qt} />
            ))}
            <p className="ai-cost">
              Cost <span className="fig">{money(s.costUsd)}</span>
            </p>
          </section>
        ) : null}

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
                <label key={c.id} className={`choice${choice === c.id ? ' choice-on' : ''}`}>
                  <input type="radio" name={`a-${q.id}`} value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} />
                  <span className="choice-text">
                    <span className={c.models.length && !c.asin ? 'code choice-label' : 'choice-label'}>{c.label}</span>
                    {c.asin ? (
                      <span className="choice-sub">
                        <span className="code">{c.asin}</span> {c.source ? <SourceLink source={c.source} /> : null}
                      </span>
                    ) : null}
                  </span>
                  {pre === c.id ? <Tag tone="verified">AI</Tag> : null}
                  <Kbd>{i + 1}</Kbd>
                </label>
              ))}
              {q.allowNone ? (
                <label className={`choice${choice === NONE ? ' choice-on' : ''}`}>
                  <input type="radio" name={`a-${q.id}`} value={NONE} checked={choice === NONE} onChange={() => setChoice(NONE)} />
                  <span className="choice-text">
                    <span className="choice-label">None of these</span>
                  </span>
                  <Kbd>{q.choices.length + 1}</Kbd>
                </label>
              ) : null}
              {q.allowTyped ? (
                <label className={`choice${choice === TYPED ? ' choice-on' : ''}`}>
                  <input type="radio" name={`a-${q.id}`} value={TYPED} checked={choice === TYPED} onChange={() => setChoice(TYPED)} />
                  <span className="choice-text">
                    <span className="choice-label">Enter the parts</span>
                    {typedStart ? <span className="choice-sub">Filled in from the AI suggestion</span> : null}
                  </span>
                  <Kbd>{q.choices.length + (q.allowNone ? 2 : 1)}</Kbd>
                </label>
              ) : null}
            </div>
            {q.allowTyped && choice === TYPED ? (
              <TextField label="Models, separated by commas" value={typed} onChange={(e) => setTyped(e.target.value)} mono placeholder="DCF921B, DCD708B" autoFocus={!typedStart} />
            ) : null}
          </fieldset>
        </form>
      </div>

      <footer className="question-actions">
        {save.error || ask.error ? (
          <span className="question-error" role="alert">
            {save.error ?? ask.error}
          </span>
        ) : (
          <span className="question-spacer" />
        )}
        {hasAi && q.kind !== 'ebay' && !s ? (
          <Button busy={ask.busy} busyLabel="Asking…" onClick={() => void ask.run(q.id)} cost={q.askCostUsd !== null ? `about ${money(q.askCostUsd)}` : undefined}>
            Ask AI
          </Button>
        ) : null}
        <Button type="submit" form={`form-${q.id}`} variant="primary" busy={save.busy} busyLabel="Saving…" disabled={!answerOf() || changed}>
          {aiAnswer ? 'Approve' : 'Save answer'}
        </Button>
      </footer>
    </article>
  );
}
