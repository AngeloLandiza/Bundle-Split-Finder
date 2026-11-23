import { useCallback, useEffect, useState } from 'react';
import { api, useAction } from '../api/hooks';
import { ApiError, type AppState, type DealRow, type ReviewQuestion } from '../api/types';
import { Button } from '../components/Button';
import { Profit, Roi } from '../components/Figure';
import { ProgressBar, Spinner } from '../components/States';
import { count, percentOff } from '../lib/format';
import { modLabel } from '../lib/keys';
import { isMac as mac, words } from '../lib/platform';
import { bestDeal, isRunning, needsYou, popoverStatus, scanBlocked, scanCost } from '../lib/popover';
import { scanSpend } from '../lib/scanSpend';
import { popoverDo } from '../lib/popoverShell';
import { dealVerdict } from '../lib/today';
import { hashOf } from '../lib/route';
import { workingNote } from './reviewModel';
import './PopoverApp.css';

declare global {
  interface WindowEventMap {
    /** The shell shows or hides the popover and says so (src-tauri/src/popover.rs). */
    'split-finder:popover': CustomEvent<{ open: boolean }>;
  }
}


/** The popover shows while the window has focus; in a browser (mock mode) it is always on. */
function initiallyOpen(): boolean {
  if (import.meta.env.VITE_MOCK === '1') return true;
  return typeof document !== 'undefined' && document.hasFocus();
}

/**
 * Whether the popover is on screen. The shell says so when it shows and hides the window, and the window's own focus
 * agrees (the popover hides when it loses focus). While it is not, nothing here reads the agent.
 */
function useOpen(): boolean {
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => {
    const onShell = (e: CustomEvent<{ open: boolean }>) => setOpen(Boolean(e.detail?.open));
    const on = () => setOpen(true);
    const off = () => setOpen(false);
    window.addEventListener('split-finder:popover', onShell);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('split-finder:popover', onShell);
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);
  return open;
}

interface Data {
  state: AppState | null;
  online: boolean;
  questions: ReviewQuestion[] | null;
  deals: DealRow[] | null;
  refreshState: () => void;
}

/**
 * The agent's state, the open questions and the deals, read when the popover opens and then followed from the event
 * stream: a state event replaces the state; a review or deals event reloads that list once, after a short quiet. Closed,
 * the stream is closed and nothing is requested, so a hidden popover costs the agent nothing.
 */
function useAgent(open: boolean): Data {
  const [state, setState] = useState<AppState | null>(null);
  const [online, setOnline] = useState(true);
  const [questions, setQuestions] = useState<ReviewQuestion[] | null>(null);
  const [deals, setDeals] = useState<DealRow[] | null>(null);

  const loadState = useCallback(() => {
    api
      .state()
      .then((s) => {
        setState(s);
        setOnline(true);
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError) || e.kind === 'offline') setOnline(false);
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const loadReview = () =>
      api
        .review()
        .then((r) => alive && setQuestions(r.questions))
        .catch(() => undefined);
    const loadDeals = () =>
      api
        .deals()
        .then((d) => alive && setDeals(d.rows))
        .catch(() => undefined);
    loadState();
    void loadReview();
    void loadDeals();

    const timers: Partial<Record<'review' | 'deals', ReturnType<typeof setTimeout>>> = {};
    const soon = (kind: 'review' | 'deals', load: () => unknown) => {
      clearTimeout(timers[kind]);
      timers[kind] = setTimeout(load, 400);
    };
    let wasDown = false;
    const unsubscribe = api.subscribe(
      (e) => {
        if (e.type === 'state') {
          setState(e.state);
          setOnline(true);
        } else if (e.type === 'review') soon('review', loadReview);
        else if (e.type === 'deals') soon('deals', loadDeals);
      },
      (status) => {
        if (status === 'live') {
          setOnline(true);
          // Events were missed while the stream was down.
          if (wasDown) {
            loadState();
            void loadReview();
            void loadDeals();
          }
          wasDown = false;
        } else {
          wasDown = true;
          loadState();
        }
      },
    );
    return () => {
      alive = false;
      unsubscribe();
      clearTimeout(timers.review);
      clearTimeout(timers.deals);
    };
  }, [open, loadState]);

  return { state, online, questions, deals, refreshState: loadState };
}

export function PopoverApp() {
  const open = useOpen();
  const { state, online, questions, deals, refreshState } = useAgent(open);

  // Esc closes it, as it does a menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void popoverDo('hide');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const status = popoverStatus(state, online);
  const total = state?.counts.review ?? 0;
  const { shown, more } = needsYou(questions ?? [], total);
  const best = bestDeal(deals ?? []);
  const go = (route: string) => void popoverDo('open', route);

  return (
    <div className="pop" aria-label="Split Finder">
      <header className="pop-head">
        <h1 className="pop-name">Split Finder</h1>
        <span className={`pop-state${status.attention ? ' pop-state-attention' : ''}`} role="status" aria-live="polite">
          {isRunning(state) ? <Spinner size={12} /> : null}
          {status.state}
        </span>
      </header>
      {status.detail || status.progress ? (
        <div className="pop-status">
          {status.detail ? <p className="pop-detail">{status.detail}</p> : null}
          {status.progress ? <ProgressBar value={status.progress.fraction} label="Scan progress" valueText={`Step ${status.progress.step} of ${status.progress.of}`} /> : null}
        </div>
      ) : null}

      <div className="pop-body">
        {state ? (
          <>
            <section className="pop-section" aria-labelledby="pop-needs">
              <h2 className="pop-section-head" id="pop-needs">
                Needs you<span className="pop-count"> · <span className="fig">{count(total)}</span></span>
              </h2>
              {total === 0 ? <p className="pop-quiet">Nothing needs you.</p> : null}
              {state.counts.reviewWorking ? <p className="pop-quiet">{workingNote(state.counts.reviewWorking)}</p> : null}
              {shown.length > 0 ? (
                <ul className="pop-rows">
                  {shown.map((q) => (
                    <li key={q.id}>
                      <button type="button" className="pop-row" onClick={() => go(hashOf({ screen: 'review', id: q.id }).slice(1))}>
                        <span className="pop-row-main">
                          <span className="pop-row-title">{q.prompt}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {more > 0 ? (
                <button type="button" className="pop-more" onClick={() => go('/review')}>
                  {more === 1 ? '1 more question' : `${count(more)} more questions`} in Review
                </button>
              ) : null}
            </section>

            <section className="pop-section" aria-labelledby="pop-best">
              <h2 className="pop-section-head" id="pop-best">
                Best deal
              </h2>
              {best ? (
                <>
                  <button type="button" className="pop-row pop-deal" onClick={() => go(hashOf({ screen: 'deals', id: best.id }).slice(1))}>
                    <span className="pop-row-main">
                      <span className="pop-row-title" title={best.title}>
                        {best.title}
                      </span>
                      <span className="pop-row-sub">
                        {dealVerdict(best)?.text ?? (
                          <>
                            {best.brand} · <span className="code">{best.model}</span>
                            {percentOff(best.off) ? ` · ${percentOff(best.off)}` : ''}
                          </>
                        )}
                      </span>
                    </span>
                    <span className="pop-deal-figs">
                      <Profit value={best.profit ?? 0} />
                      {best.roi !== null ? <Roi value={best.roi} label /> : null}
                    </span>
                  </button>
                  <p className="pop-note">Profit and ROI are estimates from your fee settings.</p>
                </>
              ) : (
                <p className="pop-quiet">{deals && deals.length ? 'No deal above zero yet.' : deals ? 'No bundles found yet.' : 'Loading…'}</p>
              )}
            </section>
          </>
        ) : (
          // Never an empty body: say whether it is loading or the agent is not there, and what to do.
          <p className="pop-quiet" role="status">
            {online ? 'Loading…' : 'The agent is not running. Open Split Finder to start it.'}
          </p>
        )}
      </div>

      <Actions state={state} online={online} refreshState={refreshState} />

      <ul className="pop-menu" role="menu">
        <li role="none">
          <button type="button" role="menuitem" className="pop-menu-item" onClick={() => void popoverDo('open')}>
            <span>Open Split Finder</span>
          </button>
        </li>
        <li role="none">
          <button type="button" role="menuitem" className="pop-menu-item" onClick={() => void popoverDo('preferences')}>
            <span>{words.preferencesRow}</span>
            <span className="pop-key">{modLabel(',', mac)}</span>
          </button>
        </li>
        <li role="none">
          <button type="button" role="menuitem" className="pop-menu-item" onClick={() => void popoverDo('quit')}>
            <span>{words.quit}</span>
            {mac ? <span className="pop-key">{modLabel('Q', mac)}</span> : null}
          </button>
        </li>
      </ul>
    </div>
  );
}

/** Scan now with its price (Stop while one runs) and Pause (Resume while paused). */
function Actions({ state, online, refreshState }: { state: AppState | null; online: boolean; refreshState: () => void }) {
  const scan = useAction(api.scan);
  const stop = useAction(api.stop);
  const pause = useAction(api.pause);
  const resume = useAction(api.resume);
  const running = isRunning(state);
  const paused = state?.agent.status === 'paused';
  const blocked = scanBlocked(state, online);
  const error = scan.error ?? stop.error ?? pause.error ?? resume.error;
  const done = (p: Promise<boolean>) => void p.then(refreshState);
  return (
    <div className="pop-actions">
      <div className="pop-buttons">
        {running ? (
          <Button className="pop-btn" busy={stop.busy || state?.agent.status === 'stopping'} busyLabel="Stopping…" onClick={() => done(stop.run())} title="Stop the scan after the current step">
            Stop
          </Button>
        ) : (
          <Button className="pop-btn" busy={scan.busy} busyLabel="Starting…" disabled={Boolean(blocked)} title={blocked ?? `Scan now (${modLabel('R', mac)})`} cost={scanCost(state)} onClick={() => done(scan.run())}>
            Scan now
          </Button>
        )}
        {paused ? (
          <Button variant="primary" busy={resume.busy} busyLabel="Resuming…" disabled={!online} onClick={() => done(resume.run())}>
            Resume
          </Button>
        ) : (
          <Button busy={pause.busy} busyLabel="Pausing…" disabled={!online || !state} onClick={() => done(pause.run())}>
            Pause
          </Button>
        )}
      </div>
      {state && !running && !blocked ? <p className="pop-note">{scanSpend(state.budget).sentence}</p> : null}
      {error ? (
        <p className="pop-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
