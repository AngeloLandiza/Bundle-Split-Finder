export interface HeaderProps {
  scanRunning: boolean;
  /** No key yet: Scan now is disabled and settings are reached from the first-run body. */
  noKey: boolean;
  /** When set, Scan now is disabled and this is its title. */
  scanBlockedTitle?: string;
  onScan: () => void;
  onStop: () => void;
  onSettings: () => void;
}

export function Header({ scanRunning, noKey, scanBlockedTitle, onScan, onStop, onSettings }: HeaderProps) {
  return (
    <header className="header">
      <div className="brand">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
        </svg>
        <span className="brand-name">Split Finder</span>
      </div>
      <div className="header-actions">
        {scanRunning ? (
          <button type="button" id="scan-control" className="btn btn-secondary" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="button" id="scan-control" className="btn btn-primary" disabled={noKey || scanBlockedTitle !== undefined} title={scanBlockedTitle} onClick={onScan}>
            Scan now
          </button>
        )}
        {noKey ? null : (
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
