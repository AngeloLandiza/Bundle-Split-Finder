declare const __SPLIT_FINDER_HELPER__: boolean;

export interface HeaderProps {
  scanRunning: boolean;
  /** Stop was pressed and the scan has not ended yet: the button says so and cannot be pressed again. */
  stopping?: boolean;
  /** No key yet: Scan now is disabled and settings are reached from the first-run body. */
  noKey: boolean;
  /** When set, Scan now is disabled and this is its title. */
  scanBlockedTitle?: string;
  /** When the app is primary, scan and settings live in the native app (P5). */
  appPrimary?: boolean;
  onScan: () => void;
  onStop: () => void;
  onSettings: () => void;
  onOpenApp?: () => void;
}

export function Header({
  scanRunning,
  stopping = false,
  noKey,
  scanBlockedTitle,
  appPrimary = false,
  onScan,
  onStop,
  onSettings,
  onOpenApp,
}: HeaderProps) {
  const brand =
    typeof __SPLIT_FINDER_HELPER__ !== 'undefined' && __SPLIT_FINDER_HELPER__ ? 'Split Finder Helper' : 'Split Finder';
  const openApp = onOpenApp ?? onSettings;

  return (
    <header className="header">
      <div className="brand">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
        </svg>
        <span className="brand-name">{brand}</span>
      </div>
      <div className="header-actions">
        {scanRunning ? (
          <button type="button" id="scan-control" className="btn btn-secondary" aria-disabled={stopping ? 'true' : undefined} onClick={onStop}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : appPrimary ? (
          <button type="button" id="scan-control" className="btn btn-primary" disabled={noKey} title={noKey ? 'Add your key in the app first.' : undefined} onClick={openApp}>
            Open app
          </button>
        ) : (
          <button type="button" id="scan-control" className="btn btn-primary" disabled={noKey || scanBlockedTitle !== undefined} title={noKey ? 'Add your SerpApi key first.' : scanBlockedTitle} onClick={onScan}>
            Scan now
          </button>
        )}
        {noKey || appPrimary ? null : (
          <button type="button" className="icon-btn" aria-label="Settings" onClick={onSettings}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M3 5h12M3 9h12M3 13h12" />
              <circle cx="6.5" cy="5" r="1.6" fill="var(--surface)" />
              <circle cx="11.5" cy="9" r="1.6" fill="var(--surface)" />
              <circle cx="8" cy="13" r="1.6" fill="var(--surface)" />
            </svg>
          </button>
        )}
      </div>
    </header>
  );
}
