import { useState, type ReactNode } from 'react';
import { api, useApp, useResource } from '../api/hooks';
import { agentWords } from './StatusLine';
import { count, when } from '../lib/format';
import { modLabel, type Screen } from '../lib/keys';
import { isMac as mac, words as systemWords } from '../lib/platform';
import type { Route } from '../lib/route';
import { setupProgress } from '../lib/setup';
import { DEAL_VIEWS, VIEW_LABEL, viewCounts, type DealView } from '../lib/views';
import { Glyph, type GlyphName } from './Glyph';
import { Meter, ProgressBar, Spinner } from './States';
import { Count } from './Tag';
import { useUi } from './ui';
import './Sidebar.css';


const VIEW_GLYPH: Record<DealView, GlyphName> = {
  'buy-now': 'trend-up',
  all: 'tray',
  confirmed: 'seal',
  'needs-answer': 'question',
  waiting: 'clock',
  losing: 'trend-down',
  watchlist: 'star',
};

const COLLAPSED_KEY = 'splitFinder.sidebarCollapsed';

function readCollapsed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The source list (design.md, Desktop app > Sidebar): Today; Deals and its saved views with counts;
 * Review with its badge, Activity and Settings; and at the foot what the agent is doing.
 */
export function Sidebar({ route, onGo }: { route: Route; onGo: (r: Route) => void }) {
  const { state } = useApp();
  const [deals] = useResource(() => api.deals(), [], ['deals']);
  const counts = deals.data ? viewCounts(deals.data.rows) : null;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (group: string) =>
    setCollapsed((cur) => {
      const next = cur.includes(group) ? cur.filter((g) => g !== group) : [...cur, group];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // this session only
      }
      return next;
    });
  const go = (screen: Screen, view?: DealView) => onGo({ screen, id: null, ...(view && view !== 'all' ? { view } : {}) });
  const on = (screen: Screen, view?: DealView) => route.screen === screen && (screen !== 'deals' || (route.view ?? 'all') === (view ?? 'all'));
  const review = state?.counts.review ?? 0;

  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="sidebar-titlebar" data-tauri-drag-region="" />
      <div className="sidebar-scroll" data-tauri-drag-region="">
        <ul className="source-list">
          <Item glyph="today" label="Today" current={on('today')} onClick={() => go('today')} shortcut={modLabel('1', mac)} />
        </ul>
        <Group title="Deals" collapsed={collapsed.includes('deals')} onToggle={() => toggle('deals')}>
          {DEAL_VIEWS.map((v) => (
            <Item
              key={v}
              glyph={VIEW_GLYPH[v]}
              label={VIEW_LABEL[v]}
              current={on('deals', v)}
              onClick={() => go('deals', v)}
              shortcut={v === 'all' ? modLabel('2', mac) : undefined}
              end={counts ? v === 'buy-now' && counts[v] > 0 ? <Count n={counts[v]} attention label={`${counts[v]} worth buying now`} /> : <span className="source-count fig">{count(counts[v])}</span> : null}
            />
          ))}
        </Group>
        <Group title="Agent" collapsed={collapsed.includes('agent')} onToggle={() => toggle('agent')}>
          <Item
            glyph="checklist"
            label="Review"
            current={on('review')}
            onClick={() => go('review')}
            shortcut={modLabel('3', mac)}
            end={review > 0 ? <Count n={review} attention label={`${review} open`} /> : null}
          />
          <Item glyph="activity" label="Activity" current={on('activity')} onClick={() => go('activity')} shortcut={modLabel('4', mac)} />
          <Item glyph="gear" label="Settings" current={on('settings')} onClick={() => go('settings')} shortcut={modLabel('5', mac)} />
        </Group>
      </div>
      <SidebarStatus />
    </nav>
  );
}

function Group({ title, collapsed, onToggle, children }: { title: string; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  const id = `sidebar-${title.toLowerCase()}`;
  return (
    <div className="source-group">
      <h2 className="source-head">
        <button type="button" className="source-head-btn" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}>
          <span>{title}</span>
          <Glyph name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} className="source-disclosure" />
        </button>
      </h2>
      {collapsed ? null : (
        <ul className="source-list" id={id}>
          {children}
        </ul>
      )}
    </div>
  );
}

function Item({ glyph, label, current, onClick, end, shortcut }: { glyph: GlyphName; label: string; current: boolean; onClick: () => void; end?: ReactNode; shortcut?: string }) {
  return (
    <li>
      <button type="button" className="source-item" aria-current={current ? 'page' : undefined} onClick={onClick} title={shortcut ? `${label} (${shortcut})` : label}>
        <Glyph name={glyph} className="source-glyph" />
        <span className="source-label">{label}</span>
        {end ? <span className="source-end">{end}</span> : null}
      </button>
    </li>
  );
}

/** The foot of the sidebar: the agent's state, the next scan, searches left, Chrome, and setup while it is open. */
function SidebarStatus() {
  const { state, online } = useApp();
  const ui = useUi();
  if (!state) {
    return (
      <div className="sidebar-foot">
        <div className="sb-status">
          <p className="sb-row">
            <span className="sb-strong">{online ? 'Connecting…' : 'Agent not running'}</span>
          </p>
          {online ? null : <p className="sb-row sb-quiet">Open Split Finder from the {systemWords.trayPlace}</p>}
        </div>
      </div>
    );
  }
  const { agent, budget, helper } = state;
  const running = agent.status === 'scanning' || agent.status === 'asking' || agent.status === 'stopping';
  const words = agentWords(agent);
  const setup = setupProgress(state);
  return (
    <div className="sidebar-foot">
      {!setup.complete ? (
        <button type="button" className="source-item setup-item" onClick={ui.openSetup}>
          <Glyph name="setup" className="source-glyph" />
          <span className="source-label">Finish setup</span>
          <span className="source-end source-count">
            <span>
              <span className="fig">{setup.done}</span> of <span className="fig">{setup.total}</span>
            </span>
          </span>
        </button>
      ) : null}
      <div className="sb-status" aria-live="polite">
        <p className="sb-row">
          {running ? <Spinner size={12} /> : null}
          <span className="sb-strong">{words.state}</span>
          {running && words.detail ? <span className="sb-detail">{words.detail}</span> : null}
        </p>
        {running && agent.pipeline ? <ProgressBar value={agent.pipeline.fraction} label={agent.pipeline.labels?.bar ?? 'Scan progress'} valueText={agent.pipeline.ariaValueText} /> : null}
        {!running ? (
          <p className="sb-row sb-quiet">
            {agent.status === 'paused' ? 'No scheduled scan until you resume' : agent.nextScanAt ? `Next scan ${when(agent.nextScanAt)}` : 'Scans when you press Scan now'}
          </p>
        ) : null}
        {budget.serpLeft === null ? (
          <p className="sb-row sb-quiet">Searches not checked yet</p>
        ) : (
          <div className="sb-meter">
            <p className="sb-row sb-quiet">
              <span>
                <span className="fig">{count(budget.serpLeft)}</span> {budget.serpLeft === 1 ? 'search' : 'searches'} left
              </span>
            </p>
            {budget.serpMonthly ? <Meter value={budget.serpLeft} max={budget.serpMonthly} label="Searches left this month" /> : null}
          </div>
        )}
        <p className="sb-row sb-quiet">{helper.connected ? 'Chrome connected' : helper.paired ? 'Chrome closed' : 'Chrome not connected'}</p>
      </div>
    </div>
  );
}
