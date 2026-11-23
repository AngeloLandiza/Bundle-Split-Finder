import { useState, type ReactNode } from 'react';
import { api, useApp, useResource } from '../api/hooks';
import { count } from '../lib/format';
import { modLabel, type Screen } from '../lib/keys';
import { isMac as mac, isWindows, words as systemWords } from '../lib/platform';
import type { Route } from '../lib/route';
import { setupProgress } from '../lib/setup';
import { sidebarStatus } from '../lib/sidebarStatus';
import { BOUGHT_LABEL, BOUGHT_VIEW, DEAL_VIEWS, VIEW_LABEL, viewCounts, type DealView, type ListView } from '../lib/views';
import { Glyph, type GlyphName } from './Glyph';
import { ProgressBar, Spinner } from './States';
import { Count } from './Tag';
import { useUi } from './ui';
import './Sidebar.css';


const VIEW_GLYPH: Record<DealView, GlyphName> = {
  'buy-now': 'trend-up',
  all: 'tray',
  confirmed: 'seal',
  'needs-answer': 'question',
  waiting: 'clock',
  'missing-price': 'tag',
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
  // Outcomes: how many purchases he recorded (the list is his records, not a view of the rows).
  const [bought] = useResource(() => api.outcomes(), [], ['deals']);
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
  const go = (screen: Screen, view?: ListView) => onGo({ screen, id: null, ...(view && view !== 'all' ? { view } : {}) });
  const on = (screen: Screen, view?: ListView) => route.screen === screen && (screen !== 'deals' || (route.view ?? 'all') === (view ?? 'all'));
  // The count is what needs him; the questions the app is still checking are said in its label, not added to it.
  const review = state?.counts.review ?? 0;
  const working = state?.counts.reviewWorking ?? 0;

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
          <Item
            glyph="check"
            label={BOUGHT_LABEL}
            current={on('deals', BOUGHT_VIEW)}
            onClick={() => go('deals', BOUGHT_VIEW)}
            end={bought.data ? <span className="source-count fig">{count(bought.data.purchases.length)}</span> : null}
          />
        </Group>
        <Group title="Agent" collapsed={collapsed.includes('agent')} onToggle={() => toggle('agent')}>
          <Item
            glyph="checklist"
            label="Review"
            current={on('review')}
            onClick={() => go('review')}
            shortcut={modLabel('3', mac)}
            end={review > 0 ? <Count n={review} attention label={`${review} open${working ? `, ${working} more being checked` : ''}`} /> : null}
          />
          <Item glyph="activity" label="Activity" current={on('activity')} onClick={() => go('activity')} shortcut={modLabel('4', mac)} />
          {isWindows ? null : <Item glyph="gear" label="Settings" current={on('settings')} onClick={() => go('settings')} shortcut={modLabel('5', mac)} />}
        </Group>
      </div>
      <SidebarStatus />
      {/* Microsoft's NavigationView pins Settings last, at the bottom of the pane; a Mac keeps it in its group. */}
      {isWindows ? (
        <ul className="source-list sidebar-settings">
          <Item glyph="gear" label="Settings" current={on('settings')} onClick={() => go('settings')} shortcut={modLabel('5', mac)} />
        </ul>
      ) : null}
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

/**
 * The foot of the sidebar: four lines at most (lib/sidebarStatus.ts), and setup while it is open. The state, when the
 * scan is, what is left to spend, and one problem that goes to where it is fixed. The rest is in Today's Agent card.
 */
function SidebarStatus() {
  const { state, online, navigate } = useApp();
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
  const { agent } = state;
  const v = sidebarStatus(state);
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
          {v.running ? <Spinner size={12} /> : null}
          <span className="sb-strong">{v.state}</span>
        </p>
        {v.running && agent.pipeline ? <ProgressBar value={agent.pipeline.fraction} label={agent.pipeline.labels?.bar ?? 'Scan progress'} valueText={agent.pipeline.ariaValueText} /> : null}
        {v.when ? <p className="sb-row sb-quiet">{v.when}</p> : null}
        <p className="sb-row sb-quiet" title={v.usageFull}>{v.usage}</p>
        {v.problem ? (
          <button type="button" className="sb-warn" onClick={() => navigate(v.problem!.to)} title={`Open ${systemWords.preferences} to fix it`}>
            <Glyph name="warning" size={12} />
            <span>{v.problem.text}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
