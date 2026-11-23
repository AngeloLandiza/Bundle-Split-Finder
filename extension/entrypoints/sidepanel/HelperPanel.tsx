// The side panel while this browser is paired with the Split Finder app (step 13, Decision 1): a slim helper. The app is the place
// to work; this panel shows what the app knows about the Home Depot bundle open in the tab, lets the owner answer its open
// questions (the app applies them), and says whether the link is alive. Nothing here scans, spends or holds a key.
//
// Everything on this panel is read from the app: GET /api/deals (to find the bundle by its Home Depot item id), GET /api/deals/:id,
// GET /api/review, and POST /api/review/:id/answer. Profit is the app's estimate and says so.

import { useCallback, useEffect, useState } from 'react';
import type { DealDetail, DealRow, ReviewAnswer as ApiAnswer, ReviewQuestion as ApiQuestion, ReviewResponse, DealsResponse } from '@core/api/contract';
import type { ReviewAnswer } from '@core/scan/types';
import { WAITING_PAGE, WAITING_PAGE_TEXT } from '@core/scan/matchState';
import type { AgentApi } from '../../lib/agentApi';
import type { AgentLink } from '../../lib/agentLink';
import { AgentConnect } from '../../lib/AgentConnect';
import type { AgentLinkActions } from '../../lib/useAgentLink';
import { money, profit, roi } from '../../lib/format';
import { type ActiveTab, type WorkerApi } from '../../lib/pageClient';
import { EbayQuestion } from './EbayQuestion';
import { ReviewQuestion } from './ReviewQuestion';
import { itemIdOfUrl, useActiveTab } from './ThisPageTab';
import './Detail.css';
import './ReviewTab.css';
import './HelperPanel.css';

export const NO_PAGE = 'Open a Home Depot bundle page to see what the app knows about it.';
export const NOT_IN_APP =
  "This bundle is not in the app's deals yet. This panel cannot ask the app to look up one page: open Split Finder and scan, then come back.";
export const OPEN_APP_TEXT = 'To work on deals, open Split Finder from your Dock or Start menu. A panel in the browser cannot open the app for you.';
const SENT = 'Answer sent to the app. It applies it in a moment.';
const REFRESH_MS = 30_000;

/** The item id of a Home Depot product address, or null for anything else (another site, a search page). */
export function homeDepotItemId(tab: ActiveTab | null): string | null {
  if (tab?.url == null) return null;
  try {
    const host = new URL(tab.url).hostname;
    if (host !== 'www.homedepot.com' && host !== 'homedepot.com') return null;
  } catch {
    return null;
  }
  return itemIdOfUrl(tab.url);
}

/** The contract's answer: the panel's question form adds a signature the app does not take. */
export function apiAnswer(a: ReviewAnswer): ApiAnswer {
  if ('choice' in a) return { choice: a.choice };
  if ('none' in a) return { none: true };
  return { parts: a.parts };
}

type Load =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; row: DealRow | null; detail: DealDetail | null; mine: ApiQuestion[]; others: number };

/** What the app knows of the bundle whose Home Depot item id is `itemId` (null: no bundle page is open), and its open questions. */
function useBundle(agent: AgentApi, itemId: string | null, refresh: number): Load {
  // The answer is kept with the page it was for, so a new page never shows the last one's bundle while it loads.
  const [got, setGot] = useState<{ itemId: string | null; load: Load } | null>(null);
  const setLoad = (load: Load) => setGot({ itemId, load });
  useEffect(() => {
    let live = true;
    (async () => {
      const [deals, review] = await Promise.all([
        itemId === null ? Promise.resolve(null) : agent.get<DealsResponse>('/api/deals'),
        agent.get<ReviewResponse>('/api/review'),
      ]);
      if (!live) return;
      const failed = [deals, review].find((r) => r !== null && !r.ok);
      if (failed && !failed.ok) {
        // An app that no longer knows this browser is the link's business: the panel changes when the link does.
        setLoad({ phase: 'error', message: failed.message });
        return;
      }
      const row = deals !== null && deals.ok ? (deals.data.rows.find((r) => r.bundle.itemId === itemId) ?? null) : null;
      const questions = review.ok ? review.data.questions : [];
      let detail: DealDetail | null = null;
      if (row !== null) {
        const d = await agent.get<DealDetail>(`/api/deals/${encodeURIComponent(row.id)}`);
        if (!live) return;
        // A row with no detail (the app has only its audit line) still shows what the row says.
        if (d.ok) detail = d.data;
        else if (d.kind !== 'refused') {
          setLoad({ phase: 'error', message: d.message });
          return;
        }
      }
      const mine = row === null ? [] : questions.filter((q) => q.bundleId === row.id);
      setLoad({ phase: 'ready', row, detail, mine, others: questions.length - mine.length });
    })().catch(() => {
      if (live) setLoad({ phase: 'error', message: 'Something went wrong reading from the app.' });
    });
    return () => {
      live = false;
    };
  }, [agent, itemId, refresh]);
  return got !== null && got.itemId === itemId ? got.load : { phase: 'loading' };
}

export interface HelperPanelProps {
  /** For the active tab only. */
  api: WorkerApi;
  agent: AgentApi;
  link: Extract<AgentLink, { status: 'paired' }>;
  actions: AgentLinkActions;
  now?: () => number;
  /** Opens the settings page, where the same Disconnect is. */
  openSettings?: () => void;
}

export function HelperPanel({ api, agent, link, actions, now = Date.now, openSettings }: HelperPanelProps) {
  const tab = useActiveTab(api);
  const itemId = homeDepotItemId(tab);
  const [refresh, setRefresh] = useState(0);
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const load = useBundle(agent, itemId, refresh);

  // The app's data moves on its own (a scan ends, an answer is applied): read it again now and then, and when the tab changes.
  useEffect(() => {
    const id = setInterval(() => setRefresh((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const answer = useCallback(
    async (id: string, body: { answer: ApiAnswer; fromSuggestion?: boolean }): Promise<string | null> => {
      const reply = await agent.post(`/api/review/${encodeURIComponent(id)}/answer`, body);
      if (!reply.ok) return reply.message;
      setSent((s) => new Set(s).add(id));
      setRefresh((n) => n + 1);
      return null;
    },
    [agent],
  );

  return (
    <div className="panel helper">
      <header className="header">
        <div className="brand">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
          </svg>
          <span className="brand-name">Split Finder</span>
        </div>
        {openSettings ? (
          <button type="button" className="helper-link" onClick={openSettings}>
            Settings
          </button>
        ) : null}
      </header>
      <main className="panel-body helper-body">
        <section className="helper-section" aria-labelledby="helper-page">
          <h2 id="helper-page" className="helper-label">
            This page
          </h2>
          {itemId === null ? (
            <p className="helper-text">{NO_PAGE}</p>
          ) : load.phase === 'loading' ? (
            <p className="helper-text">Reading from the app.</p>
          ) : load.phase === 'error' ? (
            <p className="helper-text" role="alert">
              {load.message}
            </p>
          ) : load.row === null ? (
            <p className="helper-text">{NOT_IN_APP}</p>
          ) : (
            <Bundle row={load.row} detail={load.detail} />
          )}
        </section>

        {load.phase === 'ready' && itemId !== null && load.row !== null ? (
          <section className="helper-section" aria-labelledby="helper-questions">
            <h2 id="helper-questions" className="helper-label">
              Needs your answer · {load.mine.filter((q) => !sent.has(q.id)).length}
            </h2>
            {load.mine.length === 0 ? <p className="helper-text">Nothing about this bundle needs an answer.</p> : null}
            {load.mine.map((q) =>
              sent.has(q.id) ? (
                <p key={q.id} className="helper-text" role="status">
                  {SENT}
                </p>
              ) : (
                <Question key={q.id} q={q} onAnswer={answer} />
              ),
            )}
          </section>
        ) : null}

        {load.phase === 'ready' && load.others > 0 ? (
          <p className="helper-text helper-more">
            {load.others} {load.others === 1 ? 'more question waits' : 'more questions wait'} in the app.
          </p>
        ) : null}
      </main>
      <footer className="helper-foot">
        <AgentConnect link={link} actions={actions} compact now={now} />
        <p className="helper-text helper-open">{OPEN_APP_TEXT}</p>
      </footer>
    </div>
  );
}

function Bundle({ row, detail }: { row: DealRow; detail: DealDetail | null }) {
  const sources = detail?.sources ?? [];
  return (
    <div className="helper-bundle">
      <p className="helper-title">{row.bundle.title}</p>
      <p className="helper-ident">
        <span>{row.bundle.brand}</span>
        <span className="figure fig-sm">{row.bundle.model}</span>
      </p>
      <dl className="helper-facts">
        <div>
          <dt>Home Depot price</dt>
          <dd className="figure">{row.price === null ? 'Not seen' : money(row.price)}</dd>
        </div>
        {row.off !== null ? (
          <div>
            <dt>Off regular price</dt>
            <dd className="figure">{Math.round(row.off)}%</dd>
          </div>
        ) : null}
        {row.matchState !== null ? (
          <div>
            <dt>Parts</dt>
            <dd>{row.matchState === WAITING_PAGE ? WAITING_PAGE_TEXT : row.matchState}</dd>
          </div>
        ) : null}
        <div>
          <dt>Estimated profit</dt>
          <dd className="figure">{row.profit === null ? 'No estimate yet' : profit(row.profit)}</dd>
        </div>
        {row.roi !== null ? (
          <div>
            <dt>Estimated ROI</dt>
            <dd className="figure">{roi(row.roi)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="helper-text">{detail?.estimateBasis ?? 'Profit is an estimate from your fee settings, not your real Amazon fees.'}</p>
      {sources.length > 0 ? (
        <ul className="helper-sources" aria-label="Where these figures come from">
          {sources.map((s) => (
            <li key={`${s.source}:${s.url}`}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="helper-text">The parts, their prices and the ways to sell are in the app.</p>
    </div>
  );
}

function Question({ q, onAnswer }: { q: ApiQuestion; onAnswer: (id: string, body: { answer: ApiAnswer; fromSuggestion?: boolean }) => Promise<string | null> }) {
  if (q.item.kind === 'ebay') {
    return (
      <EbayQuestion
        question={q.item.question}
        scanRunning={false}
        onSave={(choice) => onAnswer(q.id, { answer: { ebay: choice } })}
      />
    );
  }
  return (
    <ReviewQuestion
      item={q.item.question}
      scanRunning={false}
      // The bundle's own title and model are shown above the questions.
      compact
      homeDepotLink={q.sources.find((s) => s.source === 'homedepot')?.url ?? null}
      onSave={(a, aiShown) => onAnswer(q.id, { answer: apiAnswer(a), ...(aiShown ? { fromSuggestion: true } : {}) })}
    />
  );
}
