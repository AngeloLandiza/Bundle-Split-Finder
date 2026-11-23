import { useState, type ReactNode } from 'react';
import { api, useApp } from '../api/hooks';
import { ApiError } from '../api/types';
import { ACCENTS, type Accent, type Appearance, type Density } from '../lib/appearance';
import { modLabel } from '../lib/keys';
import { plural } from '../lib/format';
import { Button } from './Button';
import { Segmented } from './Fields';
import { Glyph } from './Glyph';
import { Popover, PopoverSection } from './Popover';
import { Spinner } from './States';
import { agentWords } from './StatusLine';
import { useUi } from './ui';
import './Toolbar.css';

const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/**
 * The toolbar in the unified title bar (design.md, Desktop app > Toolbar): the screen's title and one
 * quiet line, then the screen's own items, Scan with its progress, the search field, View options and the
 * inspector toggle. The bar moves the window wherever there is no control.
 */
export function Toolbar({ title, sub, actions, search, viewOptions, inspector = false }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; search?: ReactNode; viewOptions?: ReactNode; inspector?: boolean }) {
  return (
    <header className="toolbar" data-tauri-drag-region="deep">
      <div className="toolbar-title">
        <h1 className="page-title" tabIndex={-1}>
          {title}
        </h1>
        {sub ? <p className="toolbar-sub">{sub}</p> : null}
      </div>
      <div className="toolbar-items">
        {actions}
        <ScanControl />
        {search}
        <ViewOptions>{viewOptions}</ViewOptions>
        {inspector ? <InspectorToggle /> : null}
      </div>
    </header>
  );
}

/** Scan now with its price; while a scan runs, its progress in place and Stop; Resume while paused. */
export function ScanControl() {
  const { state, online, refreshState, navigate } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state) return null;
  const { agent, budget, keys } = state;
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
  const running = agent.status === 'scanning' || agent.status === 'asking' || agent.status === 'stopping';
  if (running) {
    const p = agent.pipeline;
    const words = agentWords(agent);
    const pct = p ? Math.round(p.fraction * 100) : null;
    return (
      <span className="scan-progress" aria-live="polite">
        <button type="button" className="scan-progress-text" onClick={() => navigate({ screen: 'today', id: null })} title={[words.state, words.detail, p?.estimateText].filter(Boolean).join(' · ')}>
          {p ? <Ring value={p.fraction} /> : <Spinner size={14} />}
          <span className="scan-progress-words">
            <span className="scan-progress-state">{words.state}</span>
            {pct !== null ? <span className="fig"> {pct}%</span> : null}
          </span>
        </button>
        <Button variant="toolbar" glyph="stop" busy={busy || agent.status === 'stopping'} busyLabel="Stopping…" onClick={() => act(api.stop)} title="Stop the scan after the current step">
          Stop
        </Button>
        {error ? <span className="sr-only" role="alert">{error}</span> : null}
      </span>
    );
  }
  if (agent.status === 'paused') {
    return (
      <Button variant="toolbar" glyph="play" busy={busy} busyLabel="Resuming…" disabled={!online} onClick={() => act(api.resume)} title={error ?? 'Scheduled scans run again'}>
        Resume
      </Button>
    );
  }
  const blocked = !online ? 'The agent is not running.' : !keys.serpapi ? 'Add your SerpApi key first.' : budget.serpLeft !== null && budget.serpLeft <= budget.serpReserve ? 'Searches are at your reserve.' : null;
  return (
    <>
      <Button
        variant="toolbar"
        glyph="scan"
        busy={busy}
        busyLabel="Starting…"
        disabled={Boolean(blocked)}
        title={error ?? blocked ?? `Scan now (${modLabel('R', mac)})`}
        onClick={() => act(api.scan)}
        cost={budget.serpPerScan > 0 ? plural(budget.serpPerScan, 'search', 'searches') : undefined}
      >
        Scan now
      </Button>
      {error ? <span className="sr-only" role="alert">{error}</span> : null}
    </>
  );
}

/** A determinate ring the size of a toolbar glyph, for the scan's share done. */
function Ring({ value }: { value: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg className="ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--fill-2)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray={`${c * v} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
    </svg>
  );
}

function InspectorToggle() {
  const ui = useUi();
  return (
    <Button
      variant="toolbar"
      glyph="inspector"
      aria-pressed={ui.inspectorShown}
      aria-label={ui.inspectorShown ? 'Hide inspector' : 'Show inspector'}
      title={`${ui.inspectorShown ? 'Hide' : 'Show'} inspector (${mac ? '⌥⌘I' : 'Ctrl+Alt+I'})`}
      onClick={() => ui.setInspectorShown(!ui.inspectorShown)}
    />
  );
}

const ACCENT_NAME: Record<Accent, string> = {
  system: 'System',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  graphite: 'Graphite',
};

/** View options: the screen's own (a Deals section) above the window's look (appearance, accent, density). */
function ViewOptions({ children }: { children?: ReactNode }) {
  const ui = useUi();
  const { look, setLook } = ui;
  return (
    <Popover glyph="options" title="View options">
      {children}
      <PopoverSection title="Appearance">
        <Segmented<Appearance>
          legend="Appearance"
          value={look.appearance}
          onChange={(appearance) => setLook({ ...look, appearance })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </PopoverSection>
      <PopoverSection title="Accent colour">
        <fieldset className="swatches">
          <legend className="sr-only">Accent colour</legend>
          {ACCENTS.map((a) => (
            <label key={a} className={`swatch swatch-${a}`} title={ACCENT_NAME[a]}>
              <input type="radio" name="accent" value={a} checked={look.accent === a} onChange={() => setLook({ ...look, accent: a })} />
              <span className="sr-only">{ACCENT_NAME[a]}</span>
              {look.accent === a ? <Glyph name="check" size={10} className="swatch-check" /> : null}
            </label>
          ))}
        </fieldset>
      </PopoverSection>
      <PopoverSection title="Density">
        <Segmented<Density>
          legend="Density"
          value={look.density}
          onChange={(density) => setLook({ ...look, density })}
          options={[
            { value: 'regular', label: 'Regular' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </PopoverSection>
    </Popover>
  );
}
