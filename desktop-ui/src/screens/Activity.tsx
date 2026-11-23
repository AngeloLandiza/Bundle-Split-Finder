import { api, useAction, useApp, useResource } from '../api/hooks';
import type { ActivityError, AutopilotEntry, Run } from '../api/types';
import { Button } from '../components/Button';
import { Section } from '../components/Layout';
import { Page } from '../components/Page';
import { Quote } from '../components/Source';
import { EmptyState, LoadError, SkeletonRows } from '../components/States';
import { Tag } from '../components/Tag';
import { count, money, plural, usdSpend, when } from '../lib/format';
import { KIND_LABEL } from './reviewModel';
import '../components/Table.css';
import './Activity.css';

const KIND: Record<Run['kind'], string> = { scan: 'Scan', ask_all: 'Ask AI about all', lookup: 'Look up', verify: 'Verify' };
const RESULT: Record<Run['result'], string> = { finished: 'Finished', stopped: 'Stopped', limit: 'Stopped at the limit', failed: 'Failed', running: 'Running' };

/** What the agent did: errors to act on, Autopilot's answers with Undo, and every run with its spend. */
export function ActivityScreen() {
  const [res, reload] = useResource(() => api.activity(), [], ['activity', 'review']);
  const d = res.data;
  const sub = d ? (
    <>
      This month: <span className="fig">{count(d.month.searches)}</span> searches · <span className="fig">{count(d.month.keepaTokens)}</span> Keepa tokens · <span className="fig">{usdSpend(d.month.aiUsd)}</span> AI
    </>
  ) : undefined;
  return (
    <Page title="Activity" sub={sub}>
      <div className="activity">
        {res.status === 'loading' ? <SkeletonRows rows={8} columns={4} label="Loading activity" /> : null}
        {res.status === 'error' && !d ? <LoadError error={res.error} onRetry={reload} /> : null}
        {d && d.errors.length ? (
          <Section label="Needs attention" count={d.errors.length}>
            <ul className="alist">
              {d.errors.map((e) => (
                <ErrorRow key={e.id} e={e} />
              ))}
            </ul>
          </Section>
        ) : null}
        {d ? (
          <Section label="Autopilot" count={d.autopilot.length} flush={d.autopilot.length === 0}>
            {d.autopilot.length === 0 ? (
              <EmptyState title="Autopilot has not applied anything yet." cause="After each scan it applies AI answers that the code verified against the page. Everything else waits in Review." />
            ) : (
              <ul className="alist">
                {d.autopilot.map((a) => (
                  <AutopilotRow key={a.id} a={a} />
                ))}
              </ul>
            )}
          </Section>
        ) : null}
        {d ? (
          <Section label="Runs" count={d.runs.length} flush>
            {d.runs.length === 0 ? (
              <EmptyState title="No runs yet." cause="Scans, lookups and AI runs are listed here with what each one spent." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Runs, newest first</caption>
                  <colgroup>
                    <col className="col-time" />
                    <col className="col-what" />
                    <col className="col-fig" />
                    <col className="col-fig" />
                    <col className="col-fig" />
                    <col className="col-result" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col" className="th-left">
                        Started
                      </th>
                      <th scope="col" className="th-left">
                        Run
                      </th>
                      <th scope="col" className="th-right">
                        Searches
                      </th>
                      <th scope="col" className="th-right">
                        Keepa
                      </th>
                      <th scope="col" className="th-right">
                        AI
                      </th>
                      <th scope="col" className="th-left">
                        Result
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.runs.map((r) => (
                      <tr key={r.id}>
                        <td className="cell-small">{when(r.startedAt)}</td>
                        <td>
                          <span className="run-what">
                            {KIND[r.kind]}
                            <span className="muted"> · {r.trigger === 'schedule' ? 'scheduled' : 'by you'}</span>
                          </span>
                          <span className="run-summary">{r.summary}</span>
                        </td>
                        <td className="td-right fig cell-small">{count(r.searches)}</td>
                        <td className="td-right fig cell-small">{count(r.keepaTokens)}</td>
                        <td className="td-right fig cell-small">{r.aiUsd ? money(r.aiUsd) : '—'}</td>
                        <td className="cell-small">{r.result === 'finished' ? RESULT[r.result] : <strong>{RESULT[r.result]}</strong>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
    <li className="arow">
      <span className="arow-time">{when(e.at)}</span>
      <div className="arow-main">
        <p>{e.sentence}</p>
        {retry.error ? <p role="alert">{retry.error}</p> : null}
      </div>
      {e.retry ? (
        <Button size="sm" busy={retry.busy} busyLabel="Starting…" onClick={() => void retry.run(e.id)} cost={e.retry.searches ? plural(e.retry.searches, 'search', 'searches') : e.retry.usd ? `about ${money(e.retry.usd)}` : undefined}>
          {e.retry.label}
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
      <span className="arow-time">{when(a.at)}</span>
      <div className="arow-main">
        <p className="arow-title">
          <a
            href={`#/deals/${encodeURIComponent(a.bundle.id)}`}
            onClick={(ev) => {
              ev.preventDefault();
              navigate({ screen: 'deals', id: a.bundle.id });
            }}
          >
            {a.bundle.title}
          </a>
        </p>
        <p className="arow-sub">
          {KIND_LABEL[a.kind]} · <span className="fig">{a.bundle.model}</span> · applied <span className="fig arow-answer">{a.answer}</span>
        </p>
        {a.quote ? <Quote quote={a.quote} clamp /> : null}
        {a.undone ? <p className="arow-sub">Undone. The question is back in Review.</p> : null}
        {undo.error ? <p role="alert">{undo.error}</p> : null}
      </div>
      {a.undone ? (
        <Tag>Undone</Tag>
      ) : (
        <Button size="sm" busy={undo.busy} busyLabel="Undoing…" onClick={() => void undo.run(a.id)}>
          Undo
        </Button>
      )}
    </li>
  );
}
