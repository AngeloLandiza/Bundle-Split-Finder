const MARK = (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
  </svg>
);

export function AppHeader({
  noKey,
  scanRunning,
  searchesPerScan,
  helperReady,
  onScan,
  onSettings,
}: {
  noKey: boolean;
  scanRunning: boolean;
  searchesPerScan: number;
  helperReady: boolean;
  onScan: () => void;
  onSettings: () => void;
}) {
  const blocked = noKey || !helperReady;
  const title = noKey
    ? 'Add your SerpApi key in Settings first.'
    : !helperReady
      ? 'Install and load the browser helper first.'
      : scanRunning
        ? 'Scan is running in the helper.'
        : `Uses up to ${searchesPerScan} searches.`;

  return (
    <header className="top">
      <div className="brand">
        {MARK}
        <span className="brand-name">Split Finder</span>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="btn"
          disabled={blocked || scanRunning}
          title={title}
          onClick={onScan}
        >
          {scanRunning ? 'Scanning…' : 'Scan now'}
        </button>
        <button type="button" className="icon-btn" aria-label="Settings" onClick={onSettings}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M3 5h12M3 9h12M3 13h12" />
            <circle cx="6.5" cy="5" r="1.6" fill="var(--surface)" />
            <circle cx="11.5" cy="9" r="1.6" fill="var(--surface)" />
            <circle cx="8" cy="13" r="1.6" fill="var(--surface)" />
          </svg>
        </button>
      </div>
    </header>
  );
}