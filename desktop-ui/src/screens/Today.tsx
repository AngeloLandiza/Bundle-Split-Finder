import type { ReactNode } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import { isWorking, type AppState, type DealRow, type ReviewQuestion } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { Roi, RoiRangeLine, RowProfit, useEstimateWords } from '../components/Figure';
import { Glyph } from '../components/Glyph';
import { Section } from '../components/Layout';
import { Page } from '../components/Page';
import { ScorecardRows } from '../components/Scorecard';
import { EmptyState, LoadError, LoadingState, Meter } from '../components/States';
import { StatusLine } from '../components/StatusLine';
import { Tag } from '../components/Tag';
import { acrossWords, perKeySplit } from '../lib/keyEntries';
import { feeLookupWords, keepaWords, rejectedKeys, rejectedKeysWords } from '../lib/keyStatus';
import { count, money, percentOff, plural, usdSpend, when } from '../lib/format';
import { isBeforeFulfillment } from '../lib/order';
import { rowState } from '../lib/reviewBrief';
import { SCREEN_KEYS } from '../lib/notices';
import { bestDeals, buyNowDeals, dealVerdict, estimatesBeforeFulfillment } from '../lib/today';
import { scorecard } from '../lib/scorecard';
import type { DealView } from '../lib/views';
import { KIND_LABEL, workingNote } from './reviewModel';
import './Today.css';

const TOP = 5;

/** The dashboard, in the order he acts: the best deals with their one-line verdict, what needs him, then what the agent is doing. */
export function TodayScreen() {
  // The estimate sentence, with what it leaves out while sales tax or inbound shipping is unanswered.
  const estimate = useEstimateWords();
  const { state, online } = useApp();
  const [deals, reloadDeals] = useResource(() => api.deals(), [], ['deals']);
  const [review, reloadReview] = useResource(() => api.review(), [], ['review']);

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const best = bestDeals(deals.data?.rows ?? []);
  const early = estimatesBeforeFulfillment(deals.data?.rows ?? []);
  // The last scan's verdicts lead when there are any; otherwise the best estimates (a loss is never a best deal).
  const buy = buyNowDeals(deals.data?.rows ?? []);
  return (
    <Page title="Today" sub={date} grouped scanNotices keys={SCREEN_KEYS.today}>
      <div className="today">
        <div className="today-grid">
          <div className="today-main">
            {buy.length > 0 ? (
              <DealsBlock
                label="Worth buying now"
                view="buy-now"
                actionLabel="Open the list"
                res={deals}
                rows={buy}
                note={`${estimate} A scan judged each bundle against your numbers and Keepa’s monthly sales.`}
                onRetry={reloadDeals}
              />
            ) : best.length === 0 && early.length > 0 ? (
              <DealsBlock
                label="Estimates before fulfillment"
                view="all"
                actionLabel={deals.data ? `All ${count(deals.data.rows.length)} deals` : 'All deals'}
                res={deals}
                rows={early}
                note={`No estimate counts every fee yet, so none is called best. These leave out Amazon’s fulfillment fee for some parts, which can only lower them; Keepa is asked next. ${estimate}`}
                onRetry={reloadDeals}
              />
            ) : (
              <DealsBlock
                label="Best deals"
                view="all"
                actionLabel={deals.data ? `All ${count(deals.data.rows.length)} deals` : 'All deals'}
                res={deals}
                rows={best}
                note={`Nothing is marked Buy now yet, so these are the best estimates. ${estimate}`}
                onRetry={reloadDeals}
              />
            )}
            <NeedsYou res={review} onRetry={reloadReview} />
            <ScorecardBlock rows={deals.data?.rows ?? null} review={review.data?.questions ?? null} />
          </div>
          <div className="today-side">{state ? <AgentBlock state={state} /> : <Section label="Agent">{online ? <LoadingState label="Loading the agent" compact /> : <EmptyState title="The agent is not running" compact />}</Section>}</div>
        </div>
      </div>
    </Page>
  );
}

/**
 * The scorecard: what he recorded against what was estimated (lib/scorecard.ts). It reads the agent's own records and says nothing
 * it cannot back: with no purchases it says so and what to do.
 */
function ScorecardBlock({ rows, review }: { rows: DealRow[] | null; review: ReviewQuestion[] | null }) {
  const { state, navigate } = useApp();
  const [out, reloadOut] = useResource(() => api.outcomes(), [], ['deals', 'activity']);
  const [act] = useResource(() => api.activity(), [], ['activity']);
  const questions = review ? { open: review.filter((q) => !isWorking(q.followUp)).length, working: review.filter((q) => isWorking(q.followUp)).length } : null;
  const card = out.data ? scorecard({ outcomes: out.data, rows, questions, month: act.data ? { searches: act.data.month.searches, aiUsd: act.data.month.aiUsd } : null, aiCapUsd: state?.budget.aiCapUsd ?? null }) : null;
  return (
    <Section
      label="Scorecard"
      action={out.data && out.data.purchases.length ? <LinkButton onClick={() => navigate({ screen: 'deals', id: null, view: 'bought' })}>Open Bought</LinkButton> : null}
      note="Realised figures are what you recorded. Estimates come from your fee settings, not your real Amazon fees."
    >
      {out.status === 'loading' ? <LoadingState compact /> : null}
      {out.status === 'error' && !out.data ? <LoadError error={out.error} onRetry={reloadOut} /> : null}
      {card ? <ScorecardRows card={card} action={<Button onClick={() => navigate({ screen: 'deals', id: null, view: 'buy-now' })}>Open the deals</Button>} /> : null}
    </Section>
  );
}

function NeedsYou({ res, onRetry }: { res: ReturnType<typeof useResource<{ questions: ReviewQuestion[] }>>[0]; onRetry: () => void }) {
  const { navigate } = useApp();
  const questions = (res.data?.questions ?? []).filter((q) => !isWorking(q.followUp));
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
                  <span className="nav-sub">{q.bundle.brand} · {KIND_LABEL[q.kind]}</span>
                </span>
                {q.suggestion?.status === 'verified' ? <Tag tone="verified">{rowState(q)}</Tag> : <span className="nav-state">{rowState(q)}</span>}
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
  // Nov 23: a bundle missing a price has no estimate (never a part at $0): its own view says what each part needs.
  const missing = res.data?.rows.filter((r) => r.profit === null && r.incomplete).length ?? 0;
  const early = res.data?.rows.filter((r) => !r.needsAnswer && r.profit !== null && isBeforeFulfillment(r)).length ?? 0;
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
          cause={
            losing > 0
              ? `No bundle’s estimate is above zero yet. Losing money lists the ones that are below${early > 0 ? `; ${early === 1 ? 'one is' : `${early} are`} still before fulfillment, so a fee can only lower ${early === 1 ? 'it' : 'them'}` : ''}.`
              : missing > 0
                ? `${missing === 1 ? 'One bundle is' : `${missing} bundles are`} missing a price: an estimate needs every part priced.`
                : res.data.rows.length
                  ? 'Every bundle found so far is waiting for a lookup or an answer.'
                  : 'The agent has not found a discounted bundle yet. The next scan looks again.'
          }
          action={
            losing > 0 ? (
              <Button onClick={() => navigate({ screen: 'deals', id: null, view: 'losing' })}>Show losing money</Button>
            ) : missing > 0 ? (
              <Button onClick={() => navigate({ screen: 'deals', id: null, view: 'missing-price' })}>Show missing a price</Button>
            ) : res.data.rows.length ? (
              <Button onClick={() => navigate({ screen: 'deals', id: null, view: 'waiting' })}>See what is waiting</Button>
            ) : null
          }
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
                      {r.buyNow ? <Tag tone="buy">Buy now</Tag> : null}
                      {r.title}
                    </span>
                    <span className="nav-sub">
                      {r.brand} · {r.setItems !== undefined ? <>Set · {r.setItems} items</> : <span className="code">{r.model}</span>}
                      {percentOff(r.off) ? ` · ${percentOff(r.off)}` : ''}
                    </span>
                    {dealVerdict(r) ? (
                      <span className="nav-verdict" title={dealVerdict(r)?.full}>
                        {dealVerdict(r)?.text}
                      </span>
                    ) : null}
                  </span>
                  <span className="fig deal-grid-fig muted">{r.price !== null ? money(r.price) : '—'}</span>
                  <span className="deal-grid-fig">
                    <RowProfit value={r.profit ?? 0} before={r.beforeFulfillment} />
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
  const keepa = keepaWords(state);
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
        {/* While a scan runs the steps above say where it is; the last one's problems are not news now. */}
        {running ? null : (
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
        )}
        <Fact label="Next scan">
          {scheduleWords(state)}
          {state.agent.nextScanNote && state.agent.status !== 'paused' ? <span className="fact-sub">{state.agent.nextScanNote}</span> : null}
        </Fact>
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
                {budget.serpLeft !== null && budget.serpLeft <= budget.serpReserve ? (
                  <>
                    All held in reserve (your reserve is <span className="fig">{count(budget.serpReserve)}</span>)
                  </>
                ) : (
                  <>
                    <span className="fig">{count(budget.serpReserve)}</span> held in reserve
                  </>
                )}
              </span>
              {budget.serpMonthly ? <Meter value={budget.serpLeft} max={budget.serpMonthly} label="Searches left this month" /> : null}
              {/* Key stacking: the totals above, each key's share under them. */}
              {perKeySplit(state, 'serpapi') ? <span className="fact-sub">{acrossWords(state, 'serpapi')}: {perKeySplit(state, 'serpapi')}</span> : null}
              <span className="fact-sub">
                <LinkButton onClick={() => navigate({ screen: 'costs', id: null })}>Limits and forecast in Costs</LinkButton>
              </span>
            </>
          )}
        </Fact>
        {keepa ? (
          <Fact label="Keepa">
            <span>{keepa.replace(/^Keepa /, '')}</span>
            {perKeySplit(state, 'keepa') ? <span className="fact-sub">{acrossWords(state, 'keepa')}: {perKeySplit(state, 'keepa')}</span> : null}
            {agent.drip ? (
              <span className="fact-sub">
                {agent.drip.waiting > 0 ? (
                  <>
                    <span className="fig">{count(agent.drip.waiting)}</span> parts wait for a lookup{agent.drip.active && agent.drip.nextAt ? `; next ${when(agent.drip.nextAt)}` : ''}
                  </>
                ) : (
                  'No parts wait for a lookup'
                )}
                {feeLookupWords(agent.drip) ? ` · ${feeLookupWords(agent.drip)}` : ''}
              </span>
            ) : null}
          </Fact>
        ) : null}
        {agent.keepCurrent ? (
          <Fact label="Watched deals">
            <span>
              <span className="fig">{count(agent.keepCurrent.buyNow + agent.keepCurrent.watched)}</span> kept current
              {agent.keepCurrent.pagesWaiting + agent.keepCurrent.pullsWaiting > 0 ? <span className="attention-text"> · some prices wait</span> : null}
            </span>
            <span className="fact-sub">{agent.keepCurrent.sentence}</span>
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
          <span className="fact-sub">
            <LinkButton onClick={() => navigate({ screen: 'costs', id: null })}>What it costs</LinkButton>
          </span>
        </Fact>
        {rejectedKeys(state).length > 0 ? (
          <Fact label="Keys">
            <span className="attention-text">{rejectedKeysWords(state)}</span>
            {rejectedKeys(state).map((k) => (
              <span key={k} className="fact-sub">
                {state.keyProblems?.[k]}
              </span>
            ))}
            <span className="fact-sub">
              <LinkButton onClick={() => navigate({ screen: 'settings', id: 'keys' })}>Fix in Settings › Keys</LinkButton>
            </span>
          </Fact>
        ) : null}
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
