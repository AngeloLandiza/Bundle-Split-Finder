import { useCallback, useEffect, useRef, useState } from 'react';
import { validateSettings, type ExtensionSettings } from '@core/settings';
import { AlertsSection, DataSection, FeesSection, WhatToScanSection } from './OtherSections';
import { KeySection } from './KeySection';
import { ScanningSection } from './ScanningSection';
import { useAppState } from './useAppState';
import { realWorker, type WorkerApi } from './worker';

const DEFAULT_PLAN_PER_MONTH = 250;

export function SettingsPage({ api = realWorker }: { api?: WorkerApi }) {
  const { state, loading, error, save } = useAppState(api);
  const [draft, setDraft] = useState<ExtensionSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastSaved = useRef<string | null>(null);

  // The draft starts from the stored settings once, then belongs to the page.
  if (state && !draft) setDraft(state.settings);

  const problems = draft ? validateSettings(draft) : {};
  const invalid = Object.keys(problems).length > 0;

  useEffect(() => {
    if (!draft || invalid) return;
    const json = JSON.stringify(draft);
    if (lastSaved.current === null) {
      lastSaved.current = json; // what the worker already has
      return;
    }
    if (json === lastSaved.current) return;
    lastSaved.current = json;
    void save(draft).then(setSaveError);
  }, [draft, invalid, save]);

  const change = useCallback((patch: Partial<ExtensionSettings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);

  const status = invalid
    ? 'Not saved. Fix the fields marked below.'
    : saveError
      ? `Not saved. ${saveError}`
      : 'Changes save as you make them';

  return (
    <div className="page">
      <header className="top">
        <div className="top-inner">
          <div className="brand">
            <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
            </svg>
            <span className="brand-name">Split Finder</span>
            <span className="brand-page">Settings</span>
          </div>
          <span className="save-status" role="status" data-testid="save-status" data-problem={invalid || saveError ? 'true' : undefined}>
            {status}
          </span>
        </div>
      </header>
      <main className="main">
        {loading && !state ? <p className="note">Loading your settings.</p> : null}
        {error && !state ? <p className="note">{error}</p> : null}
        {state && draft ? (
          <>
            <KeySection api={api} state={state} />
            <ScanningSection
              draft={draft}
              problems={problems}
              planPerMonth={state.account?.searchesPerMonth ?? DEFAULT_PLAN_PER_MONTH}
              onChange={change}
            />
            <WhatToScanSection draft={draft} problems={problems} onChange={change} />
            <FeesSection draft={draft} problems={problems} onChange={change} />
            <AlertsSection draft={draft} problems={problems} onChange={change} />
            <DataSection api={api} />
          </>
        ) : null}
      </main>
    </div>
  );
}
