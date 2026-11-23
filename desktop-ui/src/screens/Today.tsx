import type { ReactNode } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { AppState, DealRow, ReviewQuestion } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { Profit, Roi, RoiRangeLine } from '../components/Figure';
import { Glyph } from '../components/Glyph';
import { Section } from '../components/Layout';
import { Page } from '../components/Page';
import { EmptyState, LoadError, LoadingState, Meter } from '../components/States';
import { StatusLine } from '../components/StatusLine';
import { Tag } from '../components/Tag';
import { count, money, percentOff, plural, profit, usdSpend, when } from '../lib/format';
import { bestDeals, buyNowDeals } from '../lib/today';
import type { DealView } from '../lib/views';
import { KIND_LABEL } from './reviewModel';
import './Today.css';

const TOP = 5;

/** The dashboard: four figures, what needs him, the best deals, and what the agent is doing. */
export function TodayScreen() {
  const { state, online } = useApp();
  const [deals, reloadDeals] = useResource(() => api.deals(), [], ['deals']);
  const [review, reloadReview] = useResource(() => api.review(), [], ['review']);

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const best = bestDeals(deals.data?.rows ?? []);
  // The last scan's verdicts lead when there are any; otherwise the best estimates (a loss is never a best deal).
  const buy = buyNowDeals(deals.data?.rows ?? []);
  return (
    <Page title="Today" sub={date} grouped>
      <div className="today">
        <Figures state={state} deals={deals.data?.rows ?? null} best={best[0] ?? null} questions={review.data?.questions.length ?? null} />
        <div className="today-grid">
          <div className="today-main">
            <NeedsYou res={review} onRetry={reloadReview} />
            {buy.length > 0 ? (
              <DealsBlock
                label="Worth buying now"
                view="buy-now"
                actionLabel="Open the list"
                res={deals}
                rows={buy}
                note="Profit and ROI are estimates from your fee settings, not your real Amazon fees. A scan judged each bundle against your numbers and Keepa’s monthly sales."
                onRetry={reloadDeals}
              />
            ) : (
              <DealsBlock label="Best deals" view="all" actionLabel="All deals" res={deals} rows={best} note="Profit and ROI are estimates from your fee settings, not your real Amazon fees." onRetry={reloadDeals} />
            )}
          </div>
          <div className="today-side">{state ? <AgentBlock state={state} /> : <Section label="Agent">{online ? <LoadingState label="Loading the agent" compact /> : <EmptyState title="The agent is not running" compact />}</Section>}</div>
        </div>
      </div>
    </Page>
  );
}

/** Four large figures across the top, each a fact the owner can act on. The profit says it is an estimate. */
function Figures({ state, deals, best, questions }: { state: AppState | null; deals: DealRow[] | null; best: DealRow | null; questions: number | null }) {
  const { navigate } = useApp();
  const left = state?.budget.serpLeft ?? null;
  return (
    <dl className="figures">
      <Figure label="Open questions" onClick={() => navigate({ screen: 'review', id: null })} value={questions === null ? '—' : count(questions)} note={questions ? 'Waiting in Review' : 'Nothing needs you'} />
      <Figure
        label="Best estimated profit"
        onClick={best ? () => navigate({ screen: 'deals', id: best.id }) : undefined}
        value={best?.profit != null ? profit(best.profit) : '—'}
        tone={best?.profit != null ? (best.profit < 0 ? 'loss' : 'profit') : undefined}
        note={best ? <span className="code">{best.model}</span> : 'No estimate yet'}
      />
      <Figure label="Bundles found" onClick={() => navigate({ screen: 'deals', id: null })} value={deals === null ? '—' : count(deals.length)} note={state?.counts.newDeals ? `${plural(state.counts.newDeals, 'new one', 'new ones')} since the last scan` : 'From the last scan'} />
      <Figure label="Searches left" value={left === null ? '—' : count(left)} note={state?.budget.serpMonthly ? `of ${count(state.budget.serpMonthly)} this month` : 'Not checked yet'} />
    </dl>
  );
}

function Figure({ label, value, note, tone, onClick }: { label: string; value: string; note: ReactNode; tone?: 'profit' | 'loss'; onClick?: () => void }) {
  const body = (
    <>
      <dt className="figure-label">{label}</dt>
      <dd className={`t-figure${tone ? ` ${tone}` : ''}`}>{value}</dd>
      <dd className="figure-note">{note}</dd>
    </>
  );
  return onClick ? (
    <button type="button" className="figure figure-link" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="figure">{body}</div>
  );
}

function NeedsYou({ res, onRetry }: { res: ReturnType<typeof useResource<{ questions: ReviewQuestion[] }>>[0]; onRetry: () => void }) {
  const { navigate } = useApp();
  const questions = res.data?.questions ?? [];
  const verified = questions.filter((q) => q.suggestion?.status === 'verified');
  // AI-verified first: one press approves them; then the ones that need his judgement, oldest first.
  const ordered = [...verified, ...questions.filter((q) => q.suggestion?.status !== 'verified').sort((a, b) => a.openedAt.localeCompare(b.openedAt))];
  return (
    <Section
      label="Needs you"
      count={res.data ? questions.length : undefined}
      action={questions.length ? <LinkButton onClick={() => navigate({ screen: 'review', id: null })}>Open Review</LinkButton> : null}
      note={questions.length > TOP ? `And ${plural(questions.length - TOP, 'more question', 'more questions')} in Review.` : undefined}
    >
      {res.status === 'loading' ? <LoadingState compact /> : null}
      {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={onRetry} /> : null}
      {res.data && questions.length === 0 ? <EmptyState compact title="Nothing needs you" cause="No open questions. The agent asks only when a split or match is not certain; new ones come with each scan." /> : null}
      {questions.length > 0 ? (
        <ul className="rows">
          {ordered.slice(0, TOP).map((q) => (
            <li key={q.id}>
              <button type="button" className="nav-row" onClick={() => navigate({ screen: 'review', id: q.id })}>
                <span className="nav-main">
                  <span className="nav-title">{q.prompt}</span>
                  <span className="nav-sub">
                    {q.bundle.brand} · <span className="code">{q.bundle.model}</span> · {KIND_LABEL[q.kind]}
                  </span>
                </span>
                {q.suggestion?.status === 'verified' ? <Tag tone="verified">AI verified</Tag> : <Tag tone="attention">Needs you</Tag>}
                <Glyph name="chevron-right" size={12} className="nav-chevron" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function DealsBlock({ label, view, actionLabel, res, rows, note, onRetry }: { label: string; view: DealView; actionLabel: string; res: ReturnType<typeof useResource<{ rows: DealRow[] }>>[0]; rows: DealRow[]; note: string; onRetry: () => void }) {
  const { navigate } = useApp();
  const losing = res.data?.rows.filter((r) => !r.needsAnswer && r.profit !== null && r.profit < 0).length ?? 0;
  return (
    <Section
      label={label}
      count={res.data ? Math.min(TOP, rows.length) : undefined}
      action={rows.length ? <LinkButton onClick={() => navigate({ screen: 'deals', id: null, view })}>{actionLabel}</LinkButton> : null}
      note={rows.length ? note : undefined}
    >
      {res.status === 'loading' ? <LoadingState compact /> : null}
      {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={onRetry} /> : null}
      {res.data && rows.length === 0 ? (
        <EmptyState
          compact
          title="No deals with an estimate yet"
          cause={losing > 0 ? 'No bundle’s estimate is above zero yet. Losing money lists the ones that are below.' : res.data.rows.length ? 'Every bundle found so far is waiting for a lookup or an answer.' : 'The agent has not found a discounted bundle yet. The next scan looks again.'}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <div className="deal-grid deal-grid-head" aria-hidden="true">
            <span>Bundle</span>
            <span>Price</span>
            <span>Est. profit</span>
            <span>ROI</span>
          </div>
          <ul className="rows">
            {rows.slice(0, TOP).map((r) => (
              <li key={r.id}>
                <button type="button" className="nav-row deal-grid" onClick={() => navigate({ screen: 'deals', id: r.id })}>
                  <span className="nav-main">
                    <span className="nav-title" title={r.title}>
                      {r.title}
                    </span>
                    <span className="nav-sub">
                      {r.brand} · <span className="code">{r.model}</span>
                      {percentOff(r.off) ? ` · ${percentOff(r.off)}` : ''}
                    </span>
                  </span>
                  <span className="fig deal-grid-fig muted">{r.price !== null ? money(r.price) : '—'}</span>
                  <span className="deal-grid-fig">
                    <Profit value={r.profit ?? 0} />
                  </span>
                  <span className="deal-grid-fig deal-grid-roi">
                    <Roi value={r.roi ?? 0} />
                    <RoiRangeLine range={r.roiRange} bare />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

const RESULT: Record<string, string> = { finished: 'finished', stopped: 'stopped', limit: 'stopped at the limit', failed: 'failed' };

function scheduleWords(state: AppState): string {
  if (state.agent.status === 'paused') return 'Paused';
  return state.agent.nextScanAt ? when(state.agent.nextScanAt) : 'When you press Scan now';
}

function AgentBlock({ state }: { state: AppState }) {
  const { navigate, refreshState, online } = useApp();
  const pause = useAction(api.pause);
  const resume = useAction(api.resume);
  const { agent, budget, helper, counts } = state;
  const last = agent.lastScan;
  const paused = agent.status === 'paused';
  const running = agent.status === 'scanning' || agent.status === 'asking';
  return (
    <Section
      label="Agent"
      action={
        paused ? (
          <Button variant="primary" size="sm" busy={resume.busy} busyLabel="Resuming…" disabled={!online} onClick={() => void resume.run().then(refreshState)}>
            Resume
          </Button>
        ) : (
          <Button size="sm" busy={pause.busy} busyLabel="Pausing…" disabled={!online} onClick={() => void pause.run().then(refreshState)}>
            {running ? 'Stop and pause' : 'Pause'}
          </Button>
        )
      }
    >
      <div className="agent-status">
        <StatusLine agent={agent} />
        {pause.error || resume.error ? (
          <p className="agent-error" role="alert">
            {pause.error ?? resume.error}
          </p>
        ) : null}
      </div>
      <dl className="facts">
        <Fact label="Last scan">
          {last ? (
            <>
              {when(last.at)} · {RESULT[last.result]}
              <span className="fact-sub">
                {plural(last.newDeals, 'new deal', 'new deals')} · <span className="fig">{last.searches}</span> {last.searches === 1 ? 'search' : 'searches'}
              </span>
              {last.message ? <span className="fact-sub">{last.message}</span> : null}
            </>
          ) : (
            'None yet'
          )}
        </Fact>
        <Fact label="Next scan">{scheduleWords(state)}</Fact>
        <Fact label="Searches left">
          {budget.serpLeft === null ? (
            'Not checked yet'
          ) : (
            <>
              <span>
                <span className="fig">{count(budget.serpLeft)}</span>
                {budget.serpMonthly ? (
                  <>
                    {' '}
                    of <span className="fig">{count(budget.serpMonthly)}</span>
                  </>
                ) : null}
              </span>
              <span className="fact-sub">
                <span className="fig">{count(budget.serpReserve)}</span> held in reserve
              </span>
              {budget.serpMonthly ? <Meter value={budget.serpLeft} max={budget.serpMonthly} label="Searches left this month" /> : null}
            </>
          )}
        </Fact>
        {budget.keepaTokens !== null ? (
          <Fact label="Keepa tokens">
            <span className="fig">{count(budget.keepaTokens)}</span>
          </Fact>
        ) : null}
        <Fact label="AI this month">
          <span>
            <span className="fig">{usdSpend(budget.aiSpentUsd)}</span>
            {budget.aiCapUsd !== null ? (
              <>
                {' '}
                of <span className="fig">{money(budget.aiCapUsd)}</span>
              </>
            ) : null}
          </span>
          {budget.aiCapUsd ? <Meter value={budget.aiSpentUsd} max={budget.aiCapUsd} label="AI spend against the monthly cap" /> : null}
        </Fact>
        <Fact label="Chrome">{helper.connected ? 'Connected' : helper.paired ? `Closed${helper.lastSeenAt ? `, last seen ${when(helper.lastSeenAt)}` : ''}` : 'Not connected'}</Fact>
      </dl>
      {counts.autopilotApplied > 0 ? (
        <p className="agent-autopilot">
          Autopilot applied {plural(counts.autopilotApplied, 'answer', 'answers')} after the last scan. <LinkButton onClick={() => navigate({ screen: 'activity', id: null })}>Check them in Activity</LinkButton>
        </p>
      ) : null}
    </Section>
  );
}

/** A label at the start and its value at the end, as a System Settings row. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
