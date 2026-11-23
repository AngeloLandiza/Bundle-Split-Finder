import { Fragment, useEffect, type ReactNode } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { ActivityError, AutopilotEntry, OwnerAnswer, Run } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { Fold } from '../components/Fold';
import { Glyph } from '../components/Glyph';
import { Section } from '../components/Layout';
import { Page } from '../components/Page';
import { EmptyState, LoadError, LoadingState } from '../components/States';
import { SourceLink } from '../components/Source';
import { Tag } from '../components/Tag';
import { byDay, clock, linkPieces, runWords } from '../lib/activity';
import { count, money, plural, usdSpend, when } from '../lib/format';
import { KIND_LABEL } from './reviewModel';
import './Activity.css';

/** What the agent did: errors to act on, Autopilot's answers with Undo, and every run with its spend. */
export function ActivityScreen() {
  const { navigate } = useApp();
  const [res, reload] = useResource(() => api.activity(), [], ['activity', 'review']);
  // Autopilot is a setting the owner changes in Settings, in another window: ask again when this window is next in front.
  const [prefs, reloadPrefs] = useResource(() => api.settings(), []);
  useEffect(() => {
    window.addEventListener('focus', reloadPrefs);
    return () => window.removeEventListener('focus', reloadPrefs);
  }, [reloadPrefs]);
  const autopilot = prefs.data?.autopilot ?? null;
  const toSettings = <LinkButton onClick={() => navigate({ screen: 'settings', id: 'ai' })}>Settings › AI</LinkButton>;
  const d = res.data;
  const sub = d ? (
    <>
      This month: <span className="fig">{count(d.month.searches)}</span> searches · <span className="fig">{count(d.month.keepaTokens)}</span> Keepa tokens · <span className="fig">{usdSpend(d.month.aiUsd)}</span> AI
    </>
  ) : undefined;
  return (
    <Page title="Activity" sub={sub} grouped>
      <div className="activity">
        {res.status === 'loading' ? <LoadingState label="Loading activity" /> : null}
        {res.status === 'error' && !d ? <LoadError error={res.error} onRetry={reload} /> : null}
        {d && d.errors.length ? (
          <Section label="Needs attention" count={d.errors.length}>
            <ul className="rows">
              {d.errors.map((e) => (
                <ErrorRow key={e.id} e={e} />
              ))}
            </ul>
          </Section>
        ) : null}
        {d ? (
          <Section label="Your answers" count={d.answers.length} flush={d.answers.length === 0}>
            {d.answers.length === 0 ? (
              <EmptyState compact title="No answers saved yet" cause="An answer you save in Review is listed here, newest first, with an Undo that opens the question again." />
            ) : (
              <DayRows items={d.answers} at={(a) => a.at} row={(a) => <OwnerAnswerRow key={a.id} a={a} />} />
            )}
          </Section>
        ) : null}
        {d ? (
          <Section
            label="Autopilot applied"
            count={d.autopilot.length}
            flush={d.autopilot.length === 0}
            note={autopilot === false && d.autopilot.length > 0 ? <>Autopilot is off now. Verified AI answers wait in Review for your approval. Turn it on in {toSettings}.</> : undefined}
          >
            {d.autopilot.length === 0 ? (
              autopilot === false ? (
                <EmptyState compact title="Autopilot is off" cause={<>Verified AI answers wait in Review for your approval. Turn it on in {toSettings}.</>} />
              ) : autopilot === true ? (
                <EmptyState compact title="Autopilot has not applied anything yet" cause="After each scan it applies AI answers that the code verified against the page. Everything else waits in Review." />
              ) : (
                <EmptyState compact title="Nothing applied by Autopilot" cause="Answers it applies are listed here with an Undo. Everything it does not apply waits in Review." />
              )
            ) : (
              <DayRows items={d.autopilot} at={(a) => a.at} row={(a) => <AutopilotRow key={a.id} a={a} />} />
            )}
          </Section>
        ) : null}
        {d ? (
          <Section label="Runs" count={d.runs.length} flush>
            {d.runs.length === 0 ? (
              <EmptyState compact title="No runs yet" cause="Scans, lookups and AI runs are listed here with what each one spent." />
            ) : (
              <DayRows items={d.runs} at={(r) => r.startedAt} row={(r) => <RunRow key={r.id} r={r} />} />
            )}
          </Section>
        ) : null}
      </div>
    </Page>
  );
}

function ErrorRow({ e }: { e: ActivityError }) {
  const retry = useAction(api.retry);
  return (
    <li className="arow arow-attention">
      <span className="arow-time">{when(e.at)}</span>
      <div className="arow-main">
        <p className="arow-problem">
          <Glyph name="warning" size={14} className="arow-glyph" />
          <span>{e.sentence}</span>
        </p>
        {retry.error ? <p className="arow-sub arow-error" role="alert">{retry.error}</p> : null}
      </div>
      {e.retry ? (
        <Button size="sm" busy={retry.busy} busyLabel="Starting…" onClick={() => void retry.run(e.id)} cost={e.retry.searches ? plural(e.retry.searches, 'search', 'searches') : e.retry.usd ? `about ${money(e.retry.usd)}` : undefined}>
          {e.retry.label}
        </Button>
      ) : null}
    </li>
  );
}

/** An answer he saved: Undo opens the question again, or says why it cannot (a later scan or answer changed what it saved). */
function OwnerAnswerRow({ a }: { a: OwnerAnswer }) {
  const { navigate } = useApp();
  const undo = useAction(api.undoAnswer);
  return (
    <li className="arow">
      <span className="arow-time">{clock(a.at)}</span>
      <div className="arow-main">
        <p className="arow-title">{a.title}</p>
        <p className="arow-sub">
          You answered <span className="code arow-answer">{a.answer}</span>
        </p>
        {a.undone ? (
          <p className="arow-sub">
            Undone. The question is back in <LinkButton onClick={() => navigate({ screen: 'review', id: a.questionId })}>Review</LinkButton>.
          </p>
        ) : null}
        {!a.undone && !a.undoable ? <p className="arow-sub">A later scan or answer changed what this saved, so it cannot be undone from here.</p> : null}
        {undo.error ? <p className="arow-sub arow-error" role="alert">{undo.error}</p> : null}
      </div>
      {a.undone ? (
        <Tag>Undone</Tag>
      ) : a.undoable ? (
        <Button size="sm" busy={undo.busy} busyLabel="Undoing…" onClick={() => void undo.run(a.id)}>
          Undo
        </Button>
      ) : null}
    </li>
  );
}

function AutopilotRow({ a }: { a: AutopilotEntry }) {
  const { navigate } = useApp();
  const undo = useAction(api.undo);
  return (
    <li className="arow">
      <span className="arow-time">{clock(a.at)}</span>
      <div className="arow-main">
        <p className="arow-title">
          {a.bundleId ? (
            <a
              href={`#/deals/${encodeURIComponent(a.bundleId)}`}
              onClick={(ev) => {
                ev.preventDefault();
                navigate({ screen: 'deals', id: a.bundleId });
              }}
            >
              {a.title}
            </a>
          ) : (
            a.title
          )}
        </p>
        <p className="arow-sub">
          {KIND_LABEL[a.kind]}
          {a.model ? (
            <>
              {' · '}
              <span className="code">{a.model}</span>
            </>
          ) : null}
        </p>
        <p className="arow-sub">
          Autopilot applied <span className="code arow-answer">{a.applied}</span>
          {a.by ? <> · AI suggestion from <span className="code">{a.by}</span></> : null}
        </p>
        {a.verifiedBy.length ? (
          <Fold id={`checked-${a.id}`} title="What the code checked" aside={plural(a.verifiedBy.length, 'check', 'checks')} sub>
            <ul className="arow-checks">
              {a.verifiedBy.map((line, i) => (
                <li key={i}>
                  {linkPieces(line).map((p, k) => (p.url ? <SourceLink key={k} source={{ label: p.text, url: p.url }} /> : <span key={k}>{p.text}</span>))}
                </li>
              ))}
            </ul>
          </Fold>
        ) : null}
        {a.undone ? <p className="arow-sub">Undone. The question is back in Review.</p> : null}
        {!a.undone && !a.undoable ? <p className="arow-sub">You changed this answer since, so it cannot be undone from here.</p> : null}
        {undo.error ? <p className="arow-sub arow-error" role="alert">{undo.error}</p> : null}
      </div>
      {a.undone ? (
        <Tag>Undone</Tag>
      ) : a.undoable ? (
        <Button size="sm" busy={undo.busy} busyLabel="Undoing…" onClick={() => void undo.run(a.id)}>
          Undo
        </Button>
      ) : null}
    </li>
  );
}

/** Items newest first under a heading for each day, in one list: the heading is a row, not a box inside the box. */
function DayRows<T>({ items, at, row }: { items: T[]; at: (item: T) => string; row: (item: T) => ReactNode }) {
  return (
    <ul className="rows">
      {byDay(items, at).map((g) => (
        <Fragment key={g.key}>
          <li className="arow-day">
            <h3>{g.label}</h3>
          </li>
          {g.items.map((item) => row(item))}
        </Fragment>
      ))}
    </ul>
  );
}

/** A run as a sentence: what it was, how it ended, what it used; the agent's own words under it, a failure in its own colour. */
function RunRow({ r }: { r: Run }) {
  const w = runWords(r);
  const failedSteps = r.steps.filter((st) => st.state === 'failed' || st.state === 'skipped');
  return (
    <li className={w.problem ? 'arow arow-attention' : 'arow'}>
      <span className="arow-time">{clock(r.startedAt)}</span>
      <div className="arow-main">
        <p className="arow-title">
          {w.title} <span className={w.problem ? 'arow-outcome arow-outcome-bad' : 'arow-outcome'}>· {w.outcome.toLowerCase()}</span>
        </p>
        {r.summary ? <p className="arow-sub arow-say">{r.summary}</p> : null}
        {r.error && r.error !== r.summary ? <p className="arow-sub arow-error">{r.error}</p> : null}
        {failedSteps.map((st) => (
          <p key={st.label} className="arow-sub">
            {st.state === 'failed' ? 'Did not finish' : 'Skipped'}: {st.label}
            {st.figure ? ` · ${st.figure}` : ''}
          </p>
        ))}
        {w.spent ? <p className="arow-sub">{w.spent}.</p> : null}
      </div>
    </li>
  );
}
