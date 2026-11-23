import type { ReactNode } from 'react';
import { useApp } from '../api/hooks';
import { plural } from '../lib/format';
import { Button } from './Button';
import { PageHeader } from './Layout';
import { PairingNotices } from './PairingNotice';
import { Notice } from './States';
import './Page.css';

/**
 * The bands that describe the whole app, under every page header: the agent offline, Chrome
 * closed or not connected, a missing SerpApi key, the searches at their reserve. One sentence
 * each, with the one action that fixes it.
 */
export function AppNotices() {
  const { state, online, offlineSentence, refreshState, navigate, pairing } = useApp();
  const out: ReactNode[] = [];
  if (online && pairing.requests.length > 0) out.push(<PairingNotices key="pairing" />);
  if (!online) {
    out.push(
      <Notice key="offline" title="The agent is not running." action={<Button size="sm" onClick={refreshState}>Retry</Button>}>
        {offlineSentence ?? 'Open Split Finder from the menu bar to start it.'} What is on screen is from before it stopped.
      </Notice>,
    );
  } else if (state) {
    const h = state.helper;
    if (h.paired && !h.connected) {
      out.push(
        <Notice key="chrome" title="Chrome is closed — Home Depot pages wait.">
          {h.jobsWaiting > 0 ? `${plural(h.jobsWaiting, 'page waits', 'pages wait')} to be read; they run when Chrome opens.` : 'Scans read Home Depot pages in Chrome; open it and the agent carries on.'}
        </Notice>,
      );
    } else if (!h.paired && pairing.requests.length === 0) {
      out.push(
        <Notice key="pair" tone="attention" title="Chrome is not connected." action={<Button size="sm" onClick={() => navigate({ screen: 'settings', id: 'chrome' })}>Connect Chrome</Button>}>
          Scans need it to read Home Depot pages.
        </Notice>,
      );
    }
    if (!state.keys.serpapi) {
      out.push(
        <Notice key="key" tone="attention" title="No SerpApi key." action={<Button size="sm" onClick={() => navigate({ screen: 'settings', id: 'keys' })}>Add key</Button>}>
          Scans and lookups need it.
        </Notice>,
      );
    } else if (state.budget.serpLeft !== null && state.budget.serpLeft <= state.budget.serpReserve) {
      out.push(
        <Notice key="limit" tone="attention" title="Searches are at your reserve.">
          {state.agent.lastScan?.result === 'limit' && state.agent.lastScan.message
            ? state.agent.lastScan.message
            : `${plural(state.budget.serpLeft, 'search', 'searches')} left, all held in reserve. Scheduled scans wait; lookups you start come out of the reserve.`}
        </Notice>,
      );
    }
  }
  if (out.length === 0) return null;
  return <div className="notices">{out}</div>;
}

/** A screen: its header, the app notices, then the body. */
export function Page({ title, sub, actions, children, bodyClass }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; bodyClass?: string }) {
  return (
    <div className="page view-enter">
      <PageHeader title={title} sub={sub} actions={actions} />
      <AppNotices />
      <div className={`page-body${bodyClass ? ` ${bodyClass}` : ''}`}>{children}</div>
    </div>
  );
}
