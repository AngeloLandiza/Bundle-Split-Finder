import type { ReactNode } from 'react';
import { useApp } from '../api/hooks';
import { plural } from '../lib/format';
import { words } from '../lib/platform';
import { Button } from './Button';
import { PairingNotices } from './PairingNotice';
import { ScanNotices } from './ScanNotices';
import { Notice } from './States';
import { Toolbar } from './Toolbar';
import { useUi } from './ui';
import './Page.css';

/**
 * The banners under the toolbar for the whole app: the agent offline, Chrome closed or not connected, a
 * missing SerpApi key, the searches at their reserve. One sentence each, with the one action that fixes it.
 */
export function AppNotices({ inset = false, scan = false }: { inset?: boolean; /** Today and Deals: also the banners for a scan that left pages unread and for an outdated Chrome helper. */ scan?: boolean }) {
  const { state, online, offlineSentence, refreshState, pairing } = useApp();
  const ui = useUi();
  const out: ReactNode[] = [];
  if (online && pairing.requests.length > 0) out.push(<PairingNotices key="pairing" />);
  if (!online) {
    out.push(
      <Notice key="offline" tone="attention" title="The agent is not running." action={<Button size="sm" onClick={refreshState}>Try again</Button>}>
        {offlineSentence ?? `Open Split Finder from the ${words.trayPlace} to start it.`} What is on screen is from before it stopped.
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
        <Notice key="pair" tone="attention" title="Chrome is not connected." action={<Button size="sm" onClick={ui.openSetup}>Connect Chrome</Button>}>
          Scans need it to read Home Depot pages.
        </Notice>,
      );
    }
    if (!state.keys.serpapi) {
      out.push(
        <Notice key="key" tone="attention" title="No SerpApi key." action={<Button size="sm" onClick={ui.openSetup}>Add key</Button>}>
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
  if (scan && online && state) out.push(<ScanNotices key="scan" />);
  if (out.length === 0) return null;
  return <div className={`notices${inset ? ' inset-notices' : ''}`}>{out}</div>;
}

/**
 * A screen: its toolbar in the title bar, the app's banners, then the body. `grouped` sets the body on
 * the grouped ground with group boxes (Today, Activity, Settings); otherwise the body is the content
 * ground and fills the window (Deals, Review).
 */
export function Page({
  title,
  sub,
  actions,
  search,
  viewOptions,
  inspector = false,
  grouped = false,
  scanNotices = false,
  children,
  bodyClass,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  search?: ReactNode;
  viewOptions?: ReactNode;
  inspector?: boolean;
  grouped?: boolean;
  /** Today and Deals show the scan-problem and outdated-helper banners. */
  scanNotices?: boolean;
  children: ReactNode;
  bodyClass?: string;
}) {
  return (
    <div className="page">
      <Toolbar title={title} sub={sub} actions={actions} search={search} viewOptions={viewOptions} inspector={inspector} />
      <AppNotices scan={scanNotices} />
      <div className={`page-body${grouped ? ' page-body-grouped' : ' page-body-fill'}${bodyClass ? ` ${bodyClass}` : ''}`}>{children}</div>
    </div>
  );
}
