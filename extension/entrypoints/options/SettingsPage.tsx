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
  const [saveError, setSaveError] = useState<string | null>(null);
  // What is shown and validated on every keystroke.
  const [draft, setDraft] = useState<ExtensionSettings | null>(null);
  // What may be saved: the draft as it was at the last blur, Enter or radio/checkbox change.
  const [committed, setCommitted] = useState<ExtensionSettings | null>(null);
  const draftRef = useRef<ExtensionSettings | null>(null);
  const lastSaved = useRef<string | null>(null);

  // The draft starts from the stored settings once, then belongs to the page.
  if (state && !draft) {
    draftRef.current = state.settings;
    lastSaved.current = JSON.stringify(state.settings);
    setDraft(state.settings);
  }

  const problems = draft ? validateSettings(draft) : {};
  const invalid = Object.keys(problems).length > 0;

  useEffect(() => {
    if (!committed || Object.keys(validateSettings(committed)).length > 0) return;
    const json = JSON.stringify(committed);
    if (json === lastSaved.current) return;
    lastSaved.current = json;
    void save(committed).then(setSaveError);
  }, [committed, save]);

  const change = useCallback((patch: Partial<ExtensionSettings>, commitNow = false) => {
    if (!draftRef.current) return;
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
    if (commitNow) setCommitted(draftRef.current);
  }, []);
  const commit = useCallback(() => setCommitted(draftRef.current), []);

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
            <h1 className="brand-page">Settings</h1>
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
              onChange={change} onCommit={commit}
            />
            <WhatToScanSection draft={draft} problems={problems} onChange={change} onCommit={commit} />
            <FeesSection draft={draft} problems={problems} onChange={change} onCommit={commit} />
            <AlertsSection draft={draft} problems={problems} onChange={change} onCommit={commit} />
            <DataSection api={api} />
          </>
        ) : null}
      </main>
    </div>
  );
}
