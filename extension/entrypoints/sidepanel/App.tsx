import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { realWorker, useAppState, type WorkerApi } from '../../lib/pageClient';
import type { PanelReport } from '../../lib/messages';
import { DealsTab } from './DealsTab';
import { Detail } from './Detail';
import { FirstRun } from './FirstRun';
import { Header } from './Header';
import { Notice } from './Notice';
import { ProgressRow } from './ProgressRow';
import { ReviewTab } from './ReviewTab';
import { StatusBar } from './StatusBar';
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
  const { state, error } = useAppState(api);
  const [report, setReport] = useState<PanelReport | null>(null);
  const [tab, setTab] = useState<TabId>('deals');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [sort, setSort] = useSort();
  const [clock, setClock] = useState(now);

  // The report is read on mount and after every state change. The last one stays on screen while the next loads.
  useEffect(() => {
    if (!state) return;
    let live = true;
    api
      .send<PanelReport>({ type: 'getReport' })
      .then((reply) => {
        if (live && reply.ok) setReport(reply.data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, state]);

  useEffect(() => {
    const id = setInterval(() => setClock(now()), 30_000);
    return () => clearInterval(id);
  }, [now]);

  useEffect(() => {
    if (openKey === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openKey]);

  if (!state) {
    return <div className="panel">{error ? <p className="load-error">{error}</p> : null}</div>;
  }

  const send = (type: 'scanNow' | 'stopScan') => () => {
    void api.send({ type }).catch(() => {});
  };

  if (!state.hasKey) {
    return (
      <div className="panel">
        <Header scanRunning={false} noKey onScan={send('scanNow')} onStop={send('stopScan')} onSettings={openSettings} />
        <main className="panel-body">
          <FirstRun state={state} />
        </main>
      </div>
    );
  }

  if (openKey !== null) {
    return (
      <div className="panel">
        <Detail report={report} state={state} bundleKey={openKey} onBack={() => setOpenKey(null)} />
      </div>
    );
  }

  return (
    <div className="panel">
      <Header
        scanRunning={state.scanRunning}
        noKey={false}
        onScan={send('scanNow')}
        onStop={send('stopScan')}
        onSettings={openSettings}
      />
      <Notice state={state} />
      <Tabs
        active={tab}
        dealCount={report?.bundles.length ?? 0}
        reviewCount={report?.review.length ?? 0}
        onChange={setTab}
      />
      {state.scanRunning ? <ProgressRow job={state.lastJob} /> : null}
      <main className="panel-body">
        {tab === 'deals' ? (
          <DealsTab report={report} state={state} sort={sort} onSort={setSort} onOpen={setOpenKey} />
        ) : (
          <ReviewTab report={report} state={state} />
        )}
      </main>
      <StatusBar state={state} now={clock} />
    </div>
  );
}
