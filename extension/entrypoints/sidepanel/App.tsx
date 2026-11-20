import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { realWorker, UNREACHABLE, useAppState, type WorkerApi } from '../../lib/pageClient';
import type { AppState, PanelReport, Request } from '../../lib/messages';
import { DealsTab } from './DealsTab';
import { Detail } from './Detail';
import { FirstRun } from './FirstRun';
import { Header } from './Header';
import { hourlyBlockTitle } from './hourlyBlock';
import { Notice } from './Notice';
import { ProgressRow } from './ProgressRow';
import { ReviewTab } from './ReviewTab';
import { StatusBar } from './StatusBar';
import { ThisPageTab, useActiveTab } from './ThisPageTab';
import { Tabs, type TabId } from './Tabs';
import { useSort } from './sort';
import './sidepanel.css';

export interface AppProps {
  api?: WorkerApi;
  /** Opens the settings page. */
  openSettings?: () => void;
  now?: () => number;
}

const defaultOpenSettings = () => {
  void browser.runtime.openOptionsPage();
};

export function App({ api = realWorker, openSettings = defaultOpenSettings, now = Date.now }: AppProps) {
  const { state, error: loadError } = useAppState(api);
  const [report, setReport] = useState<PanelReport | null>(null);
  const [tab, setTab] = useState<TabId>('deals');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const activeTab = useActiveTab(api);
  // The tab Detail was opened from, so Back returns there and says its name.
  const [openedFrom, setOpenedFrom] = useState<TabId>('deals');
  const [sort, setSort] = useSort();
  const [clock, setClock] = useState(now);
  // Two slots, so a report refresh cannot wipe a refused scan's sentence. The report's is cleared by its next success.
  const [scanError, setScanError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  // Stop was pressed and the scan has not ended: the button reads Stopping… and cannot be pressed twice.
  const [stopping, setStopping] = useState(false);
  // Whether a scan is running now, read when a stop reply comes back late.
  const runningNow = useRef(false);

  // A refused Scan now or Stop belongs to the moment it was refused in: it goes when a scan starts or ends, when
  // a Look up or Verify on this panel ends, and on the scan control's next success.
  // A scan or, step 12, Ask AI about all: both have a Stop and a progress row, and never run together.
  const asking = state?.askAll != null;
  const running = state === null ? null : state.scanRunning || asking;
  const [seenRunning, setSeenRunning] = useState(running);
  if (seenRunning !== running) {
    setSeenRunning(running);
    setScanError(null);
    setStopping(false);
  }
  runningNow.current = running === true;
  const askingNow = useRef(false);
  askingNow.current = asking;
  const paidEnded = useCallback(() => setScanError(null), []);

  // The report is read on mount and after every state change. The last one stays on screen while the next loads.
  useEffect(() => {
    if (!state) return;
    let live = true;
    api
      .send<PanelReport>({ type: 'getReport' })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) setReport(reply.data);
        setReportError(reply.ok ? null : reply.error);
      })
      .catch(() => {
        if (live) setReportError(UNREACHABLE);
      });
    return () => {
      live = false;
    };
  }, [api, state]);

  // The chip opened the panel on This page: the worker keeps that for the tab until the panel takes it, here when the panel
  // starts, and again when it hears of a click while already open. The listener is set before the first take.
  useEffect(() => {
    const tabs = api.tabs;
    if (!tabs) return;
    let live = true;
    const take = async (named?: number) => {
      const id = (await tabs.active())?.id;
      // The answer is for one tab: only the panel showing that tab takes it.
      if (id === undefined || (named !== undefined && named !== id)) return;
      const reply = await api.send<boolean>({ type: 'takeShowThisPage', tabId: id });
      if (live && reply.ok && reply.data === true) {
        setOpenKey(null);
        setTab('this-page');
      }
    };
    const stop = tabs.onShowThisPage((id) => void take(id).catch(() => {}));
    void take().catch(() => {});
    return () => {
      live = false;
      stop();
    };
  }, [api]);

  useEffect(() => {
    const id = setInterval(() => setClock(now()), 30_000);
    return () => clearInterval(id);
  }, [now]);

  // When Detail closes, focus goes back to the link of the row that was opened. The row is on screen again by
  // this effect, because the report on screen is kept while Detail is open.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (openKey !== null) {
      opened.current = openKey;
      return;
    }
    const key = opened.current;
    opened.current = null;
    if (key === null) return;
    const link = [...document.querySelectorAll<HTMLElement>('[data-key]')].find((el) => el.dataset.key === key);
    // The row is gone (it left the report, or another tab is shown): focus goes to the Deals tab, not <body>.
    (link ?? document.querySelector<HTMLElement>('nav[aria-label="Views"] button'))?.focus();
  }, [openKey]);

  useEffect(() => {
    if (openKey === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openKey]);

  if (!state) {
    return <div className="panel">{loadError ? <p className="load-error">{loadError}</p> : null}</div>;
  }

  const send = (type: 'scanNow') => () => {
    const request: Request = { type };
    api
      .send(request)
      .then((reply) => setScanError(reply.ok ? null : reply.error))
      .catch(() => setScanError(UNREACHABLE));
  };

  const stop = () => {
    if (stopping) return;
    setStopping(true);
    api
      .send({ type: askingNow.current ? 'stopAskAll' : 'stopScan' })
      .then((reply) => {
        if (!reply.ok) setStopping(false);
        // A failure that comes after the scan ended no longer applies.
        if (!reply.ok && !runningNow.current) return;
        setScanError(reply.ok ? null : reply.error);
      })
      .catch(() => {
        setStopping(false);
        if (runningNow.current) setScanError(UNREACHABLE);
      });
  };

  if (!state.hasKey) {
    return (
      <div className="panel">
        <Header scanRunning={false} noKey onScan={send('scanNow')} onStop={stop} onSettings={openSettings} />
        <main className="panel-body">
          <FirstRun state={state} api={api} openSettings={openSettings} />
        </main>
      </div>
    );
  }

  if (openKey !== null) {
    return (
      <div className="panel">
        <Detail api={api} report={report} state={state} bundleKey={openKey} backLabel={openedFrom === 'this-page' ? 'This page' : 'Deals'} onBack={() => setOpenKey(null)} onPaidEnd={paidEnded} />
      </div>
    );
  }

  return (
    <div className="panel">
      <Header
        scanRunning={state.scanRunning || asking}
        stopping={stopping || state.askAll?.stopping === true}
        noKey={false}
        scanBlockedTitle={hourlyBlockTitle(state, clock)}
        onScan={send('scanNow')}
        onStop={stop}
        onSettings={openSettings}
      />
      <Tabs
        active={tab}
        dealCount={report?.bundles.length ?? 0}
        reviewCount={(report?.review.length ?? 0) + (report?.ebayQuestions?.length ?? 0)}
        onChange={setTab}
      />
      {state.scanRunning ? <ProgressRow job={state.lastJob} rates={state.rates} /> : state.askAll ? <ProgressRow job={null} rates={state.rates} askAll={state.askAll} /> : null}
      <Notice state={state} api={api} error={scanError ?? reportError} />
      <main className="panel-body">
        {tab === 'deals' ? (
          <DealsTab
            api={api}
            report={report}
            state={state}
            sort={sort}
            onSort={setSort}
            onOpen={(key) => {
              setOpenedFrom('deals');
              setOpenKey(key);
            }}
            onPaidEnd={paidEnded}
          />
        ) : tab === 'this-page' ? (
          <ThisPageTab
            api={api}
            report={report}
            state={state}
            tab={activeTab}
            onOpenDetail={(key) => {
              setOpenedFrom('this-page');
              setOpenKey(key);
            }}
          />
        ) : (
          <ReviewTab api={api} report={report} state={state} />
        )}
      </main>
      <StatusBar state={state} now={clock} />
    </div>
  );
}
