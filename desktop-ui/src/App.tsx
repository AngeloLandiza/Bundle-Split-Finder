import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext, api, useApp, type AppContextValue, type PairingValue } from './api/hooks';
import { ApiError, type AgentEvent, type AppState, type PendingPairRequest } from './api/types';
import { Button } from './components/Button';
import { Rail, type RailItem } from './components/Rail';
import { Meter } from './components/States';
import { StatusLine } from './components/StatusLine';
import { count, plural } from './lib/format';
import { globalKey, pressOf } from './lib/keys';
import { DEFAULT_ROUTE, hashOf, parseRoute, type Route } from './lib/route';
import { ActivityScreen } from './screens/Activity';
import { DealsScreen } from './screens/Deals';
import { FirstRun } from './screens/FirstRun';
import { ReviewScreen } from './screens/Review';
import { SettingsScreen } from './screens/Settings';
import { TodayScreen } from './screens/Today';
import './shell.css';

declare global {
  interface WindowEventMap {
    'split-finder:navigate': CustomEvent<{ route: string }>;
    'split-finder:find': CustomEvent;
  }
}

const FIRST_RUN_SKIPPED = 'splitFinder.firstRunSkipped';

function readSkipped(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_SKIPPED) === '1';
  } catch {
    return false;
  }
}

/** Focus the current screen's filter field (Cmd/Ctrl+F, or the shell's split-finder:find). */
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
  const [skipped, setSkipped] = useState(readSkipped);
  const listeners = useRef(new Map<AgentEvent['type'], Set<(e: AgentEvent) => void>>());

  // Routes by hash; the shell sets the hash and also fires split-finder:navigate.
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    const onNav = (e: CustomEvent<{ route: string }>) => {
      const r = parseRoute(e.detail?.route ?? '');
      window.location.hash = hashOf(r);
    };
    const onFind = () => focusFind();
    window.addEventListener('hashchange', onHash);
    window.addEventListener('split-finder:navigate', onNav);
    window.addEventListener('split-finder:find', onFind);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('split-finder:navigate', onNav);
      window.removeEventListener('split-finder:find', onFind);
    };
  }, []);

  const navigate = useCallback((r: Route) => {
    const next = hashOf(r);
    if (window.location.hash === next) setRoute(r);
    else window.location.hash = next;
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
        // Offline or not allowed: the offline band already says so, and there is nothing to allow.
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = globalKey(pressOf(e));
      if (!a) return;
      e.preventDefault();
      if (a.type === 'go') navigate({ screen: a.screen, id: null });
      else focusFind();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // Move focus to the page title on a screen change, so a screen reader hears where it is.
  useEffect(() => {
    document.querySelector<HTMLElement>('.page-title')?.focus({ preventScroll: true });
  }, [route.screen]);

  const ctx = useMemo<AppContextValue>(() => ({ state, online, offlineSentence, refreshState, navigate, on, pairing }), [state, online, offlineSentence, refreshState, navigate, on, pairing]);

  if (state?.firstRun && !skipped) {
    return (
      <AppContext.Provider value={ctx}>
        <FirstRun
          onSkip={() => {
            try {
              localStorage.setItem(FIRST_RUN_SKIPPED, '1');
            } catch {
              // session only
            }
            setSkipped(true);
          }}
        />
      </AppContext.Provider>
    );
  }

  const items: RailItem[] = [
    { screen: 'today', label: 'Today' },
    { screen: 'deals', label: 'Deals' },
    { screen: 'review', label: 'Review', count: state?.counts.review ?? 0, attention: true },
    { screen: 'activity', label: 'Activity' },
    { screen: 'settings', label: 'Settings' },
  ];

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <Rail items={items} current={route.screen} onGo={(screen) => navigate({ screen, id: null })} foot={<RailFoot />} />
        <main className="shell-main">
          {route.screen === 'today' ? <TodayScreen /> : null}
          {route.screen === 'deals' ? <DealsScreen openId={route.id} /> : null}
          {route.screen === 'review' ? <ReviewScreen openId={route.id} /> : null}
          {route.screen === 'activity' ? <ActivityScreen /> : null}
          {route.screen === 'settings' ? <SettingsScreen focus={route.id} /> : null}
        </main>
      </div>
    </AppContext.Provider>
  );
}

/** The rail's foot: what the agent is doing, Scan now or Stop with its price, searches left, Chrome. */
function RailFoot() {
  const { state, online, refreshState } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state) {
    return online ? null : (
      <p className="rail-meta">
        <span>
          <strong>Not running</strong> · the agent stopped
        </span>
      </p>
    );
  }
  const { agent, budget, helper, keys } = state;
  const running = agent.status === 'scanning' || agent.status === 'asking' || agent.status === 'stopping';
  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'That did not work. Try again.'))
      .finally(() => {
        setBusy(false);
        refreshState();
      });
  };
  const blocked = !online ? 'The agent is not running.' : !keys.serpapi ? 'Add your SerpApi key in Settings first.' : budget.serpLeft !== null && budget.serpLeft <= budget.serpReserve ? 'Searches are at your reserve.' : null;
  return (
    <>
      <StatusLine agent={agent} compact />
      {running ? (
        <Button onClick={() => act(api.stop)} busy={busy || agent.status === 'stopping'} busyLabel="Stopping…">
          Stop
        </Button>
      ) : agent.status === 'paused' ? (
        <Button variant="primary" onClick={() => act(api.resume)} busy={busy} busyLabel="Resuming…" disabled={!online}>
          Resume
        </Button>
      ) : (
        <Button variant="primary" onClick={() => act(api.scan)} busy={busy} busyLabel="Starting…" disabled={Boolean(blocked)} title={blocked ?? undefined} cost={budget.serpPerScan > 0 ? plural(budget.serpPerScan, 'search', 'searches') : undefined}>
          Scan now
        </Button>
      )}
      {error ? (
        <p className="rail-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="rail-meta">
        {budget.serpLeft === null ? (
          <span>Searches not checked yet</span>
        ) : (
          <>
            <span>
              <span className="fig">{count(budget.serpLeft)}</span> searches left
            </span>
            {budget.serpMonthly ? <Meter value={budget.serpLeft} max={budget.serpMonthly} label="Searches left this month" /> : null}
          </>
        )}
      </div>
      <div className="rail-meta">
        <span>{helper.connected ? 'Chrome connected' : helper.paired ? 'Chrome closed' : 'Chrome not connected'}</span>
      </div>
    </>
  );
}
