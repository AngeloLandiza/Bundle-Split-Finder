import { api, useAction, useApp, useResource } from '../api/hooks';
import type { AppState, DealRow, ReviewQuestion } from '../api/types';
import { Button } from '../components/Button';
import { EstimateNote, Profit, Roi, RoiRangeLine } from '../components/Figure';
import { Section } from '../components/Layout';
import { Page } from '../components/Page';
import { EmptyState, LoadError, Meter, SkeletonRows } from '../components/States';
import { StatusLine } from '../components/StatusLine';
import { Tag } from '../components/Tag';
import { count, money, percentOff, plural, usdSpend, when } from '../lib/format';
import { KIND_LABEL } from './reviewModel';
import './Today.css';

const TOP = 5;

/** The landing screen: what needs him, the best deals, and what the agent is doing. */
export function TodayScreen() {
  const { state, online } = useApp();
  const [deals, reloadDeals] = useResource(() => api.deals(), [], ['deals']);
  const [review, reloadReview] = useResource(() => api.review(), [], ['review']);

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <Page title="Today" sub={date}>
      <div className="today">
        <div className="today-agent">{state ? <AgentBlock state={state} /> : online ? <SkeletonRows rows={4} label="Loading the agent" /> : <Section label="The agent" flush><p className="load-offline">The agent is not running.</p></Section>}</div>
        <div className="today-main">
          <NeedsYou res={review} onRetry={reloadReview} />
          <BestDeals res={deals} onRetry={reloadDeals} />
        </div>
      </div>
    </Page>
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
      label="Needs your answer"
      count={res.data ? questions.length : undefined}
      action={
        questions.length ? (
          <Button variant="quiet" size="sm" onClick={() => navigate({ screen: 'review', id: null })}>
            Open Review
          </Button>
        ) : null
      }
      flush={!res.data || questions.length === 0}
    >
      {res.status === 'loading' ? <SkeletonRows rows={3} columns={2} /> : null}
      {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={onRetry} /> : null}
      {res.data && questions.length === 0 ? (
        <EmptyState title="Nothing needs you." cause="Every open question was answered or applied by Autopilot. New ones come with the next scan." />
      ) : null}
      {questions.length > 0 ? (
        <ul className="list">
          {ordered.slice(0, TOP).map((q) => (
            <li key={q.id}>
              <a
                className="list-row"
                href={`#/review/${encodeURIComponent(q.id)}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ screen: 'review', id: q.id });
                }}
              >
                <span className="list-main">
                  <span className="list-title">{q.prompt}</span>
                  <span className="list-sub">
                    {q.bundle.brand} · <span className="fig">{q.bundle.model}</span> · {KIND_LABEL[q.kind]}
                  </span>
                </span>
                <span className="list-end">{q.suggestion?.status === 'verified' ? <Tag tone="verified">AI verified</Tag> : <Tag tone="attention">Needs you</Tag>}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {questions.length > TOP ? (
        <p className="list-more">
          And {plural(questions.length - TOP, 'more question', 'more questions')} in Review.
        </p>
      ) : null}
    </Section>
  );
}

function BestDeals({ res, onRetry }: { res: ReturnType<typeof useResource<{ rows: DealRow[] }>>[0]; onRetry: () => void }) {
  const { navigate } = useApp();
  const rows = (res.data?.rows ?? []).filter((r) => r.profit !== null && !r.needsAnswer).sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));
  return (
    <Section
      label="Best deals"
      count={res.data ? Math.min(TOP, rows.length) : undefined}
      action={
        rows.length ? (
          <Button variant="quiet" size="sm" onClick={() => navigate({ screen: 'deals', id: null })}>
            All deals
          </Button>
        ) : null
      }
      flush={!res.data || rows.length === 0}
    >
      {res.status === 'loading' ? <SkeletonRows rows={5} columns={3} /> : null}
      {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={onRetry} /> : null}
      {res.data && rows.length === 0 ? (
        <EmptyState
          title="No deals with an estimate yet."
          cause={res.data.rows.length ? 'Every bundle found so far is waiting for a lookup or an answer.' : 'The agent has not found a discounted bundle yet. The next scan looks again.'}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <div className="list-head" aria-hidden="true">
            <span>Bundle</span>
            <span>Est. profit</span>
            <span>ROI</span>
          </div>
          <ul className="list">
            {rows.slice(0, TOP).map((r) => (
              <li key={r.id}>
                <a
                  className="list-row list-row-deal"
                  href={`#/deals/${encodeURIComponent(r.id)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate({ screen: 'deals', id: r.id });
                  }}
                >
                  <span className="list-main">
                    <span className="list-title" title={r.title}>
                      {r.title}
                    </span>
                    <span className="list-sub">
                      {r.brand} · <span className="fig">{r.model}</span>
                      {r.price !== null ? (
                        <>
                          {' · '}
                          <span className="fig">{money(r.price)}</span>
                        </>
                      ) : null}
                      {percentOff(r.off) ? ` · ${percentOff(r.off)}` : ''}
                    </span>
                  </span>
                  <span className="list-fig">
                    <Profit value={r.profit ?? 0} />
                  </span>
                  <span className="list-fig list-roi">
                    <Roi value={r.roi ?? 0} />
                    <RoiRangeLine range={r.roiRange} bare />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {rows.length > 0 ? <EstimateNote /> : null}
    </Section>
  );
}

const RESULT: Record<string, string> = { finished: 'finished', stopped: 'stopped', limit: 'stopped at the limit', failed: 'failed' };

function scheduleWords(state: AppState): string {
  if (state.agent.status === 'paused') return 'Paused';
  return state.agent.nextScanAt ? when(state.agent.nextScanAt) : 'Only when you press Scan now';
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
    <Section label="The agent" flush>
      <div className="agent">
        <StatusLine agent={agent} />
        <div className="agent-actions">
          {paused ? (
            <Button variant="primary" size="sm" busy={resume.busy} busyLabel="Resuming…" disabled={!online} onClick={() => void resume.run().then(refreshState)}>
              Resume
            </Button>
          ) : (
            <Button size="sm" busy={pause.busy} busyLabel="Pausing…" disabled={!online} onClick={() => void pause.run().then(refreshState)}>
              {running ? 'Stop and pause' : 'Pause'}
            </Button>
          )}
          {pause.error || resume.error ? (
            <span className="agent-error" role="alert">
              {pause.error ?? resume.error}
            </span>
          ) : null}
        </div>
        <dl className="facts">
          <div>
            <dt>Last scan</dt>
            <dd>
              {last ? (
                <>
                  {when(last.at)} · {RESULT[last.result]} · {plural(last.newDeals, 'new deal', 'new deals')} · <span className="fig">{last.searches}</span> {last.searches === 1 ? 'search' : 'searches'}
                </>
              ) : (
                'None yet'
              )}
            </dd>
          </div>
          {last?.message ? (
            <div>
              <dt className="sr-only">Why</dt>
              <dd className="facts-note">{last.message}</dd>
            </div>
          ) : null}
          <div>
            <dt>Next scan</dt>
            <dd>{scheduleWords(state)}</dd>
          </div>
          <div>
            <dt>Searches left</dt>
            <dd className="facts-meter">
              <span>
                <span className="fig">{count(budget.serpLeft)}</span> of <span className="fig">{count(budget.serpMonthly)}</span>, <span className="fig">{count(budget.serpReserve)}</span> in reserve
              </span>
              <Meter value={budget.serpLeft} max={budget.serpMonthly} label="Searches left this month" />
            </dd>
          </div>
          {budget.keepaTokens !== null ? (
            <div>
              <dt>Keepa tokens</dt>
              <dd className="fig">{count(budget.keepaTokens)}</dd>
            </div>
          ) : null}
          <div>
            <dt>AI this month</dt>
            <dd className="facts-meter">
              <span>
                <span className="fig">{usdSpend(budget.aiSpentUsd)}</span>
                {budget.aiCapUsd !== null ? (
                  <>
                    {' '}
                    of <span className="fig">{money(budget.aiCapUsd)}</span> cap
                  </>
                ) : null}
              </span>
              {budget.aiCapUsd ? <Meter value={budget.aiSpentUsd} max={budget.aiCapUsd} label="AI spend against the monthly cap" /> : null}
            </dd>
          </div>
          <div>
            <dt>Chrome</dt>
            <dd>{helper.connected ? 'Connected' : helper.paired ? `Closed${helper.lastSeenAt ? `, last seen ${when(helper.lastSeenAt)}` : ''}` : 'Not connected'}</dd>
          </div>
        </dl>
        {counts.autopilotApplied > 0 ? (
          <p className="agent-autopilot">
            Autopilot applied {plural(counts.autopilotApplied, 'answer', 'answers')} after the last scan.{' '}
            <a
              href="#/activity"
              onClick={(e) => {
                e.preventDefault();
                navigate({ screen: 'activity', id: null });
              }}
            >
              Check them in Activity
            </a>
          </p>
        ) : null}
      </div>
    </Section>
  );
}
