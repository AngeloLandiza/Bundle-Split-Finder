import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext, api, type AppContextValue, type PairingValue } from './api/hooks';
import { ApiError, type AgentEvent, type AppState, type PendingPairRequest } from './api/types';
import { CommandPalette } from './components/CommandPalette';
import { BogoSheet, type BogoTarget } from './components/BogoSheet';
import { ConfirmPriceSheet, type ConfirmTarget } from './components/ConfirmPriceSheet';
import { MenuProvider } from './components/ContextMenu';
import { ShortcutsSheet } from './components/ShortcutsSheet';
import { Sidebar } from './components/Sidebar';
import { INSPECTOR_DEFAULT, UiContext, clampInspector, type UiValue } from './components/ui';
import { applyLook, onLookChange, readLook, saveLook, shellChrome, type Look } from './lib/appearance';
import { globalKey, pressOf, windowsKey } from './lib/keys';
import { tabForSettingsId } from './lib/prefs';
import { DEFAULT_ROUTE, hashOf, parseRoute, type Route } from './lib/route';
import { isMac, isWindows } from './lib/platform';
import { openPreferences } from './lib/shell';
import { ActivityScreen } from './screens/Activity';
import { DealsScreen } from './screens/Deals';
import { ReviewScreen } from './screens/Review';
import { TodayScreen } from './screens/Today';
import { WelcomeSheet } from './screens/Welcome';
import './shell.css';

declare global {
  interface WindowEventMap {
    'split-finder:navigate': CustomEvent<{ route: string }>;
    'split-finder:find': CustomEvent;
    'split-finder:inspector': CustomEvent;
    'split-finder:setup': CustomEvent;
    'split-finder:palette': CustomEvent;
    'split-finder:shortcuts': CustomEvent;
  }
}

const FIRST_RUN_SKIPPED = 'splitFinder.firstRunSkipped';
const INSPECTOR_KEY = 'splitFinder.inspector';

function readSkipped(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_SKIPPED) === '1';
  } catch {
    return false;
  }
}

function readInspector(): { shown: boolean; width: number } {
  try {
    const v = JSON.parse(localStorage.getItem(INSPECTOR_KEY) ?? 'null') as { shown?: unknown; width?: unknown } | null;
    return { shown: v?.shown !== false, width: typeof v?.width === 'number' ? clampInspector(v.width) : INSPECTOR_DEFAULT };
  } catch {
    return { shown: true, width: INSPECTOR_DEFAULT };
  }
}

/** Focus the current screen's search field (Cmd/Ctrl+F, or the shell's split-finder:find). */
function focusFind() {
  const el = document.querySelector<HTMLInputElement>('[data-find]');
  el?.focus();
  el?.select();
}

export function App() {
  const [route, setRoute] = useState<Route>(() => (typeof window !== 'undefined' ? parseRoute(window.location.hash) : DEFAULT_ROUTE));
  const [state, setState] = useState<AppState | null>(null);
  const [online, setOnline] = useState(true);
  const [offlineSentence, setOfflineSentence] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [bogoTarget, setBogoTarget] = useState<BogoTarget | null>(null);
  const sheetOpen = confirmTarget !== null || bogoTarget !== null;
  // Where focus was when the palette or a sheet opened, so closing it puts him back.
  const returnTo = useRef<HTMLElement | null>(null);
  const [look, setLookState] = useState<Look>(readLook);
  const [inspector, setInspector] = useState(readInspector);
  const listeners = useRef(new Map<AgentEvent['type'], Set<(e: AgentEvent) => void>>());
  const firstRunSeen = useRef(false);

  // The look on <html>; the shell's chrome; whether the window is key (selection is the accent only then).
  useEffect(() => applyLook(look), [look]);
  useEffect(() => onLookChange(setLookState), []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.chrome = shellChrome();
    const set = () => {
      if (document.hasFocus()) root.dataset.windowActive = '';
      else delete root.dataset.windowActive;
    };
    set();
    window.addEventListener('focus', set);
    window.addEventListener('blur', set);
    return () => {
      window.removeEventListener('focus', set);
      window.removeEventListener('blur', set);
    };
  }, []);

  // Settings is the Preferences window. Its route (from the shell, a link, Cmd+5) opens that window and leaves the
  // screen that was open where it was.
  const shownRoute = useRef<Route>(DEFAULT_ROUTE);
  useEffect(() => {
    if (route.screen !== 'settings') {
      shownRoute.current = route;
      return;
    }
    openPreferences(tabForSettingsId(route.id));
    window.location.hash = hashOf(shownRoute.current);
  }, [route]);

  const navigate = useCallback((r: Route) => {
    const next = hashOf(r);
    if (window.location.hash === next) setRoute(r);
    else window.location.hash = next;
  }, []);

  const setInspectorShown = useCallback((shown: boolean) => {
    setInspector((cur) => {
      const next = { ...cur, shown };
      try {
        localStorage.setItem(INSPECTOR_KEY, JSON.stringify(next));
      } catch {
        // this session only
      }
      return next;
    });
  }, []);

  // Routes by hash; the shell sets the hash and also fires split-finder:navigate. Its menus send find,
  // inspector and setup the same way.
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    const onNav = (e: CustomEvent<{ route: string }>) => {
      window.location.hash = hashOf(parseRoute(e.detail?.route ?? ''));
    };
    const onFind = () => focusFind();
    const onInspector = () => setInspector((cur) => ({ ...cur, shown: !cur.shown }));
    const onSetup = () => setSetupOpen(true);
    // The Help menu's items toggle, like the keys they show; the shell's menu takes the key, so one of the two arrives.
    const onPalette = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: isMac, ctrlKey: !isMac, bubbles: true }));
    const onShortcuts = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: isMac, ctrlKey: !isMac, bubbles: true }));
    window.addEventListener('hashchange', onHash);
    window.addEventListener('split-finder:navigate', onNav);
    window.addEventListener('split-finder:find', onFind);
    window.addEventListener('split-finder:inspector', onInspector);
    window.addEventListener('split-finder:setup', onSetup);
    window.addEventListener('split-finder:palette', onPalette);
    window.addEventListener('split-finder:shortcuts', onShortcuts);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('split-finder:navigate', onNav);
      window.removeEventListener('split-finder:find', onFind);
      window.removeEventListener('split-finder:inspector', onInspector);
      window.removeEventListener('split-finder:setup', onSetup);
      window.removeEventListener('split-finder:palette', onPalette);
      window.removeEventListener('split-finder:shortcuts', onShortcuts);
    };
  }, []);

  const refreshState = useCallback(() => {
    api
      .state()
      .then((s) => {
        setState(s);
        setOnline(true);
        setOfflineSentence(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.kind !== 'offline') return;
        setOnline(false);
        setOfflineSentence(null);
      });
  }, []);

  // The welcome sheet opens by itself once, on the first run, unless he skipped it before.
  useEffect(() => {
    if (!state || firstRunSeen.current) return;
    firstRunSeen.current = true;
    if (state.firstRun && !readSkipped()) setSetupOpen(true);
  }, [state]);

  // Chrome's pairing requests: asked for on load, whenever the agent's state changes (a request is stored, answered or
  // expires into one), and on a slow poll for the expiry that raises no event. Kept as is when nothing changed.
  const [requests, setRequests] = useState<PendingPairRequest[]>([]);
  const [pairBusy, setPairBusy] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const refreshPairing = useCallback(() => {
    api
      .pairRequests()
      .then((next) => setRequests((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next)))
      .catch(() => {
        // Offline or not allowed: the offline banner already says so, and there is nothing to allow.
      });
  }, []);

  // State on load, then from the event stream (which reconnects with a growing wait by itself); a slow poll covers
  // a stream that is down. After a gap, every screen reloads, since events were missed.
  useEffect(() => {
    refreshState();
    refreshPairing();
    let wasDown = false;
    const off = api.subscribe(
      (e) => {
        if (e.type === 'state') {
          setState(e.state);
          setOnline(true);
          refreshPairing();
        }
        listeners.current.get(e.type)?.forEach((fn) => fn(e));
      },
      (status) => {
        if (status === 'live') {
          setOnline(true);
          if (wasDown) {
            refreshState();
            refreshPairing();
            for (const type of ['deals', 'review', 'activity'] as const) listeners.current.get(type)?.forEach((fn) => fn({ type }));
          }
          wasDown = false;
        } else {
          wasDown = true;
          refreshState();
        }
      },
    );
    const poll = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refreshState();
      refreshPairing();
    }, 15_000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [refreshState, refreshPairing]);

  const pairing = useMemo<PairingValue>(
    () => ({
      requests,
      busyId: pairBusy,
      error: pairError,
      decide: async (requestId, allow) => {
        setPairBusy(requestId);
        setPairError(null);
        try {
          await api.decidePairing(requestId, allow);
          setRequests((cur) => cur.filter((r) => r.requestId !== requestId));
          refreshState();
        } catch (e) {
          setPairError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
          refreshPairing();
        } finally {
          setPairBusy(null);
        }
      },
    }),
    [requests, pairBusy, pairError, refreshState, refreshPairing],
  );

  const on = useCallback<AppContextValue['on']>((type, fn) => {
    const set = listeners.current.get(type) ?? new Set();
    set.add(fn);
    listeners.current.set(type, set);
    return () => set.delete(fn);
  }, []);

  const openOver = useCallback((open: () => void) => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    open();
  }, []);
  const closeOver = useCallback((close: () => void) => {
    close();
    // After the layer has gone (the window is no longer inert), back to where he was.
    requestAnimationFrame(() => returnTo.current?.isConnected && returnTo.current.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isWindows) {
        const w = windowsKey(pressOf(e));
        if (w) {
          e.preventDefault();
          if (setupOpen || paletteOpen || shortcutsOpen || sheetOpen) return;
          if (w.type === 'settings') openPreferences();
          else if (w.type === 'refresh') refreshState();
          else if (state?.keys.serpapi && state.agent.status !== 'scanning') void api.scan();
          return;
        }
      }
      if (setupOpen) return;
      const a = globalKey(pressOf(e));
      if (!a) return;
      e.preventDefault();
      // The palette and the shortcuts sheet toggle with their own keys; the other layers keep the rest of the keys quiet.
      if (a.type === 'palette') {
        if (paletteOpen) closeOver(() => setPaletteOpen(false));
        else if (!shortcutsOpen && !sheetOpen) openOver(() => setPaletteOpen(true));
        return;
      }
      if (a.type === 'shortcuts') {
        if (shortcutsOpen) closeOver(() => setShortcutsOpen(false));
        else if (!paletteOpen && !sheetOpen) openOver(() => setShortcutsOpen(true));
        return;
      }
      if (paletteOpen || shortcutsOpen || sheetOpen) return;
      if (a.type === 'go') navigate({ screen: a.screen, id: null });
      else if (a.type === 'inspector') setInspector((cur) => ({ ...cur, shown: !cur.shown }));
      else focusFind();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, setupOpen, paletteOpen, shortcutsOpen, sheetOpen, openOver, closeOver, state, refreshState]);

  // Move focus to the screen's title on a screen change, so a screen reader hears where it is.
  useEffect(() => {
    document.querySelector<HTMLElement>('.page-title')?.focus({ preventScroll: true });
  }, [route.screen]);

  const ctx = useMemo<AppContextValue>(() => ({ state, online, offlineSentence, refreshState, navigate, on, pairing }), [state, online, offlineSentence, refreshState, navigate, on, pairing]);
  const ui = useMemo<UiValue>(
    () => ({
      inspectorShown: inspector.shown,
      setInspectorShown,
      inspectorWidth: inspector.width,
      setInspectorWidth: (width) =>
        setInspector((cur) => {
          const next = { ...cur, width: clampInspector(width) };
          try {
            localStorage.setItem(INSPECTOR_KEY, JSON.stringify(next));
          } catch {
            // this session only
          }
          return next;
        }),
      look,
      setLook: (next) => {
        setLookState(next);
        saveLook(next);
      },
      openSetup: () => setSetupOpen(true),
      openPalette: () => openOver(() => setPaletteOpen(true)),
      openShortcuts: () => openOver(() => setShortcutsOpen(true)),
      openConfirmPrice: (target) => openOver(() => setConfirmTarget(target)),
      openBogo: (target) => openOver(() => setBogoTarget(target)),
    }),
    [inspector, setInspectorShown, look, openOver],
  );

  const closeSetup = () => {
    try {
      localStorage.setItem(FIRST_RUN_SKIPPED, '1');
    } catch {
      // this session only
    }
    setSetupOpen(false);
  };

  return (
    <AppContext.Provider value={ctx}>
      <UiContext.Provider value={ui}>
        <MenuProvider>
          <div className="window" inert={setupOpen || paletteOpen || shortcutsOpen || sheetOpen}>
            <Sidebar route={route} onGo={navigate} />
            <main className="window-content">
              {route.screen === 'today' ? <TodayScreen /> : null}
              {route.screen === 'deals' ? <DealsScreen openId={route.id} view={route.view ?? 'all'} /> : null}
              {route.screen === 'review' ? <ReviewScreen openId={route.id} /> : null}
              {route.screen === 'activity' ? <ActivityScreen /> : null}
            </main>
          </div>
          {setupOpen ? <WelcomeSheet onClose={closeSetup} /> : null}
          {paletteOpen ? <CommandPalette onClose={() => closeOver(() => setPaletteOpen(false))} /> : null}
          {shortcutsOpen ? <ShortcutsSheet onClose={() => closeOver(() => setShortcutsOpen(false))} /> : null}
          {confirmTarget ? <ConfirmPriceSheet target={confirmTarget} onClose={() => closeOver(() => setConfirmTarget(null))} /> : null}
          {bogoTarget ? <BogoSheet target={bogoTarget} onClose={() => closeOver(() => setBogoTarget(null))} /> : null}
        </MenuProvider>
      </UiContext.Provider>
    </AppContext.Provider>
  );
}
