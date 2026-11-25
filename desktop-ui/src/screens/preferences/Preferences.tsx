// The Preferences window (docs/design.md, Desktop app > Preferences): a toolbar of tabs in the title bar, one
// pane under it, every change saved as it is made. It is the same UI bundle as the dashboard, loaded by the
// shell into its own window at #/preferences/<tab>; it keeps its own link to the agent.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext, api, useApp } from '../../api/hooks';
import { useAgentLink } from '../../api/link';
import { ApiError, type AppSettings, type SettingsPatch } from '../../api/types';
import { Glyph } from '../../components/Glyph';
import { ErrorState, LoadingState, Notice } from '../../components/States';
import { applyLook, onLookChange, readLook, saveLook, shellChrome, type Look } from '../../lib/appearance';
import { mergePatch } from '../../lib/patch';
import { PREF_TABS, TAB_GLYPH, TAB_LABEL, nextTab, parsePrefsTab, prefsHash, toAppearanceSetting, windowHeight, type PrefTab } from '../../lib/prefs';
import { agentDownHint } from '../../lib/agentDown';
import { words } from '../../lib/platform';
import { inShell, invokeShell } from '../../lib/shell';
import { PrefsContext, type PrefsValue } from './form';
import { AdvancedPane } from './Advanced';
import { AiPane } from './Ai';
import { ChromePane } from './Chrome';
import { DataPane } from './Data';
import { GeneralPane } from './General';
import { KeysPane } from './Keys';
import { NotificationsPane } from './Notifications';
import { ScanningPane } from './Scanning';
import './Preferences.css';

const PANES: Record<PrefTab, () => React.ReactNode> = {
  general: () => <GeneralPane />,
  scanning: () => <ScanningPane />,
  keys: () => <KeysPane />,
  ai: () => <AiPane />,
  notifications: () => <NotificationsPane />,
  chrome: () => <ChromePane />,
  data: () => <DataPane />,
  advanced: () => <AdvancedPane />,
};

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; text: string };

export function PreferencesApp() {
  const link = useAgentLink();
  return (
    <AppContext.Provider value={link}>
      <PreferencesWindow />
    </AppContext.Provider>
  );
}

function PreferencesWindow() {
  const { online } = useApp();
  const [tab, setTab] = useState<PrefTab>(() => parsePrefsTab(window.location.hash));
  const [look, setLookState] = useState<Look>(readLook);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // The look on <html>, and the same look when the dashboard's window changes it.
  useEffect(() => applyLook(look), [look]);
  useEffect(() => onLookChange(setLookState), []);
  useEffect(() => {
    document.documentElement.dataset.window = 'preferences';
    document.documentElement.dataset.chrome = shellChrome();
    document.title = 'Settings';
  }, []);

  // The tab follows the address: the shell sets it when the window is opened again on another tab.
  useEffect(() => {
    const onHash = () => setTab(parsePrefsTab(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const goTo = useCallback((next: PrefTab) => {
    if (window.location.hash !== prefsHash(next)) window.location.hash = prefsHash(next);
    else setTab(next);
  }, []);

  // ---- loading and saving
  const settingsRef = useRef<AppSettings | null>(null);
  settingsRef.current = settings;
  const pending = useRef<{ patch: SettingsPatch; thens: ((saved: AppSettings) => void)[] }>({ patch: {}, thens: [] });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(e instanceof ApiError ? e : new ApiError('server', 'Something went wrong. Try again.')));
  }, []);
  useEffect(load, [load]);
  // Back in front after being closed to the menu bar: read what the agent holds now, unless a save is waiting.
  useEffect(() => {
    const onFocus = () => {
      if (!timer.current) load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const update = useCallback<PrefsValue['update']>(
    (patch, o) => {
      const cur = settingsRef.current;
      if (!cur) return;
      setSettings(mergePatch(cur as object, patch as object) as AppSettings);
      pending.current.patch = mergePatch(pending.current.patch, patch);
      if (o?.then) pending.current.thens.push(o.then);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const { patch: send, thens } = pending.current;
        pending.current = { patch: {}, thens: [] };
        if (idle.current) clearTimeout(idle.current);
        setStatus({ kind: 'saving' });
        api
          .patchSettings(send)
          .then((saved) => {
            setStatus({ kind: 'saved' });
            // The agent sets the key and the trust of a pipeline whose model changed: show its answer, and only that,
            // so text still being typed is not put back.
            if (send.ai) {
              setSettings((cur) => {
                if (!cur) return cur;
                const ai = { ...cur.ai };
                for (const id of ['judge', 'assist', 'research'] as const) {
                  if (send.ai?.[id]) ai[id] = { ...ai[id], trusted: saved.ai[id].trusted, apiKeyRef: saved.ai[id].apiKeyRef };
                }
                return { ...cur, ai };
              });
            }
            idle.current = setTimeout(() => setStatus({ kind: 'idle' }), 2400);
            thens.forEach((fn) => fn(saved));
          })
          .catch((e: unknown) => {
            // What the agent refused is not saved: say so, and show what it holds.
            setStatus({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not save. Try again.' });
            load();
          });
      }, o?.delay ?? 0);
    },
    [load],
  );

  const setLook = useCallback(
    (next: Look) => {
      setLookState(next);
      saveLook(next);
      update({ appearance: toAppearanceSetting(next) });
    },
    [update],
  );

  const value = useMemo<PrefsValue | null>(() => (settings ? { settings, update, look, setLook, goTo } : null), [settings, update, look, setLook, goTo]);

  // ---- the window fits its pane (shell.rs set_preferences_height)
  const bar = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!inShell()) return;
    const fit = () => {
      if (!bar.current || !content.current) return;
      const h = windowHeight(bar.current.offsetHeight, content.current.offsetHeight);
      void invokeShell('set_preferences_height', { height: h }).catch(() => {
        // The window keeps the height it has.
      });
    };
    let frame = 0;
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const ro = new ResizeObserver(soon);
    if (content.current) ro.observe(content.current);
    soon();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const tabsRef = useRef<HTMLDivElement>(null);
  const onTabKey = (e: React.KeyboardEvent) => {
    const next = nextTab(tab, e.key);
    if (!next) return;
    e.preventDefault();
    goTo(next);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>(`#prefs-tab-${next}`)?.focus());
  };

  return (
    <PrefsContext.Provider value={value}>
      <div className="prefs">
        <header className="prefs-bar" ref={bar} data-tauri-drag-region="deep">
          <div className="prefs-titleband" data-tauri-drag-region="deep">
            <h1 className="prefs-title" data-tauri-drag-region="deep">
              {TAB_LABEL[tab]}
            </h1>
            <SavedIndicator status={status} />
          </div>
          <div className="prefs-tabs" role="tablist" aria-label="Settings" ref={tabsRef} onKeyDown={onTabKey}>
            {PREF_TABS.map((t) => (
              <button key={t} type="button" role="tab" id={`prefs-tab-${t}`} aria-selected={t === tab} aria-controls="prefs-pane" tabIndex={t === tab ? 0 : -1} className="prefs-tab" onClick={() => goTo(t)}>
                <Glyph name={TAB_GLYPH[t]} size={22} />
                <span>{TAB_LABEL[t]}</span>
              </button>
            ))}
          </div>
        </header>
        <main className="prefs-pane" id="prefs-pane" role="tabpanel" aria-labelledby={`prefs-tab-${tab}`}>
          <div className="prefs-content" ref={content}>
            {!online ? (
              <div className="inset-notices">
                <Notice tone="attention" title="The agent is not running.">
                  {agentDownHint(words)} Changes cannot be saved until it runs.
                </Notice>
              </div>
            ) : null}
            {status.kind === 'error' ? (
              <p className="prefs-error" role="alert">
                <Glyph name="warning" size={14} />
                <span>Not saved. {status.text}</span>
              </p>
            ) : null}
            {value ? PANES[tab]() : loadError ? <ErrorState sentence={loadError.message} onRetry={load} /> : <LoadingState label="Loading settings" />}
          </div>
        </main>
      </div>
    </PrefsContext.Provider>
  );
}

/** The quiet word in the title bar: Saving, then Saved with a check for a moment. Errors speak at the top of the pane. */
function SavedIndicator({ status }: { status: Status }) {
  return (
    <span className="prefs-saved" role="status" aria-live="polite">
      {status.kind === 'saving' ? <span>Saving…</span> : null}
      {status.kind === 'saved' ? (
        <>
          <Glyph name="check" size={12} />
          <span>Saved</span>
        </>
      ) : null}
    </span>
  );
}
