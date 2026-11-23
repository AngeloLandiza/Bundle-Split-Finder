import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from './components/AppHeader';
import { DetailView } from './views/DetailView';
import { DealsView } from './views/DealsView';
import { HomeView } from './views/HomeView';
import { ReviewView } from './views/ReviewView';
import { FooterMeters } from './views/FooterMeters';
import { SettingsView } from './views/SettingsView';
import { api } from './api';

type Tab = 'home' | 'deals' | 'review' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [keySet, setKeySet] = useState(false);
  const [searchesPerScan, setSearchesPerScan] = useState(5);
  const [helperReady, setHelperReady] = useState(false);
  const [scanRunning, setScanRunning] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);

  const refreshStatus = useCallback(() => {
    void api.settings().then((s) => {
      if (!s.ok) return;
      setKeySet(s.serpApiKeySet === true);
      setSearchesPerScan(s.settings?.searchesPerScan ?? 5);
    });
    void api.setup().then((s) => setHelperReady(s.extensionReady === true));
    void fetch('/api/state')
      .then((r) => r.json())
      .then((body) => {
        const st = body as { ok?: boolean; scanRunning?: boolean };
        if (st.ok) setScanRunning(st.scanRunning === true);
      })
      .catch(() => {});
    void api.review().then((r) => {
      if (!r.ok) {
        setReviewCount(0);
        return;
      }
      setReviewCount((r.questions?.length ?? 0) + (r.ebayQuestions?.length ?? 0));
    });
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = window.setInterval(refreshStatus, 30_000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const scanNow = () => {
    void api.scanStart().then(() => refreshStatus());
  };

  const onSettings = () => setTab('settings');

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'home', label: 'Home' },
    { id: 'deals', label: 'Deals' },
    { id: 'review', label: 'Review', count: reviewCount },
  ];

  return (
    <div className="app">
      <AppHeader
        noKey={!keySet}
        scanRunning={scanRunning}
        searchesPerScan={searchesPerScan}
        helperReady={helperReady}
        onScan={scanNow}
        onSettings={onSettings}
      />
      {tab === 'settings' ? null : (
        <nav className="tabs" aria-label="Views">
          {tabs.map((t) => (
            <button key={t.id} type="button" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? (
                <span className="tab-tag" aria-label={`${t.count} open`}>
                  {t.count}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      )}
      <main className="main">
        {tab === 'home' ? (
          <HomeView keySet={keySet} onOpenSettings={onSettings} onScan={scanNow} />
        ) : null}
        {tab === 'deals' && detailKey ? <DetailView bundleKey={detailKey} onBack={() => setDetailKey(null)} /> : null}
        {tab === 'deals' && !detailKey ? (
          <DealsView
            onOpen={(key) => {
              setDetailKey(key);
            }}
          />
        ) : null}
        {tab === 'review' ? <ReviewView /> : null}
        {tab === 'settings' ? (
          <SettingsView onDone={() => {
            refreshStatus();
            setTab('home');
          }} />
        ) : null}
      </main>
      <FooterMeters />
      <p className="copy-muted" style={{ padding: '0 16px 12px', margin: 0 }}>
        Profit and ROI are estimates, not your real Amazon fees.
      </p>
    </div>
  );
}