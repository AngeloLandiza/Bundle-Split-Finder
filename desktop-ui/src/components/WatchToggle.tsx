import { Glyph } from './Glyph';
import './WatchToggle.css';

/**
 * The watched mark in a Deals row: a filled star while the bundle is on the watchlist, a hollow one while it is not.
 * It is a real toggle button (Tab reaches it, Space or Return presses it, `aria-pressed` says the state), so it is
 * allowed to be a glyph: it is a control, not decoration. Its cell passes clicks through to the row except this button.
 */
export function WatchToggle({ watched, label, busy = false, onToggle }: { watched: boolean; label: string; busy?: boolean; onToggle: () => void }) {
  return (
    <span className="row-control watch-cell">
      <button
        type="button"
        className={`watch-toggle${watched ? ' watch-on' : ''}`}
        aria-pressed={watched}
        aria-label={`Watch ${label}`}
        title={watched ? 'Watching. Press to stop watching.' : 'Watch this bundle: every scan judges it'}
        disabled={busy}
        onClick={onToggle}
      >
        <Glyph name={watched ? 'star-fill' : 'star'} size={14} />
      </button>
    </span>
  );
}
