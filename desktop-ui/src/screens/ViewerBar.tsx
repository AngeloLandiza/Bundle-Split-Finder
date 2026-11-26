import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { Glyph } from '../components/Glyph';
import { Spinner } from '../components/States';
import { formatShortcut, isMac, isWindows } from '../lib/platform';
import { inShell, invokeShell } from '../lib/shell';
import { addressParts } from '../lib/viewer';
import { barKey, type BarState } from '../lib/viewerBar';
import './ViewerBar.css';

/**
 * The page viewer's toolbar (docs/design.md, Desktop app > Page viewer), in its own webview over the site's page
 * (src-tauri/src/viewer). It has no agent token and asks the agent nothing: the shell tells it the state, and it asks
 * the shell for its buttons. When the page did not load or asks him to sign in, the shell grows this webview over the
 * page area and it draws our own state there.
 */
export function ViewerBar() {
  const [s, setS] = useState<BarState | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const on = (e: Event) => setS((e as CustomEvent<BarState>).detail);
    window.addEventListener('split-finder:viewer', on);
    if (inShell()) void invokeShell<BarState>('viewer_state').then(setS).catch(() => undefined);
    return () => window.removeEventListener('split-finder:viewer', on);
  }, []);

  const act = useCallback((action: string) => {
    setProblem(null);
    return invokeShell('viewer_do', { action }).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  }, []);

  const copy = useCallback(() => {
    void act('copy').then(() => {
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [act]);

  // A Mac's keys are the View menu's (they work wherever the focus is); Windows has no menu bar, so the toolbar
  // takes them while it has the focus.
  useEffect(() => {
    if (isMac) return;
    const onKey = (e: KeyboardEvent) => {
      const action = barKey({ key: e.key, mod: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey });
      if (!action) return;
      e.preventDefault();
      if (action === 'copy') copy();
      else void act(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, copy]);

  if (!s) return <div className="vbar-root" />;
  const address = addressParts(s.url);
  const key = (k: string, shift = false) => formatShortcut(shift ? ['mod', 'shift', k] : ['mod', k], isMac);
  const pages = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void invokeShell('viewer_pages', { x: r.left, y: r.bottom + 4 }).catch(() => undefined);
  };

  return (
    <div className="vbar-root" data-screen={s.screen.kind}>
      <header className="vbar" data-tauri-drag-region="deep">
        <div className="vbar-nav">
          <Button variant="toolbar" glyph="chevron-left" aria-label="Back" title={`Back (${key('[')})`} disabled={!s.canBack} onClick={() => void act('back')} />
          <Button variant="toolbar" glyph="chevron-right" aria-label="Forward" title={`Forward (${key(']')})`} disabled={!s.canForward} onClick={() => void act('forward')} />
          {s.loading ? (
            <Button variant="toolbar" glyph="xmark" aria-label="Stop" title="Stop loading" onClick={() => void act('stop')} />
          ) : (
            <Button variant="toolbar" glyph="reload" aria-label="Reload" title={`Reload (${key('R')})`} onClick={() => void act('reload')} />
          )}
        </div>
        {s.pages > 0 ? (
          <button
            type="button"
            className="vbar-pages"
            aria-haspopup="menu"
            title={s.title ? `${s.title}: ${s.pages} pages` : undefined}
            onClick={pages}
          >
            <span className="vbar-pages-label">{s.label ?? 'Pages of this deal'}</span>
            <span className="vbar-pages-well" aria-hidden="true">
              <Glyph name="chevrons" size={12} />
            </span>
          </button>
        ) : null}
        <div className="vbar-address" role="textbox" aria-readonly="true" aria-label="Address" tabIndex={0} title={s.url ?? undefined}>
          <span className="vbar-address-text selectable">
            {address ? (
              <>
                <span className="vbar-host">{address.host}</span>
                <span className="vbar-rest">{address.rest}</span>
              </>
            ) : null}
          </span>
          {s.loading && s.progress === null ? <Spinner size={12} /> : null}
          {s.loading && s.progress !== null ? (
            <span className="vbar-progress" role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.progress * 100)}>
              <span style={{ width: `${Math.max(8, Math.round(s.progress * 100))}%` }} />
            </span>
          ) : null}
        </div>
        <div className="vbar-actions">
          <Button size="sm" onClick={copy} title={`Copy link (${key('C', true)})`} disabled={!s.url}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button size="sm" onClick={() => void act('browser')} disabled={!s.url}>
            Open in browser
          </Button>
        </div>
      </header>
      {problem ? <p className="vbar-problem" role="alert">{problem}</p> : null}
      {s.screen.kind === 'failed' ? (
        <section className="vbar-state" aria-live="polite">
          <h1>This page did not load</h1>
          <p>Check that this {isWindows ? 'PC' : 'Mac'} is online, then try again, or open the page in your browser.</p>
          <div className="vbar-state-actions">
            <Button onClick={() => void act('browser')}>Open in browser</Button>
            <Button variant="primary" onClick={() => void act('retry')}>
              Try again
            </Button>
          </div>
        </section>
      ) : null}
      {s.screen.kind === 'signIn' ? (
        <section className="vbar-state" aria-live="polite">
          <h1>Sign in only in your browser</h1>
          <p>This page asks you to sign in or pay. You are not signed in here, and a password belongs in your own browser.</p>
          <div className="vbar-state-actions">
            <Button onClick={() => void act('back')} disabled={!s.canBack}>
              Go back
            </Button>
            <Button variant="primary" onClick={() => void act('browser')}>
              Open in browser
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
