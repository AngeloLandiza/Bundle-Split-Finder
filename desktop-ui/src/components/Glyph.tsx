// Functional glyphs in the manner of SF Symbols: 16px, monochrome (currentColor), drawn only where a
// macOS source list, toolbar or field carries one. Never decorative (design.md, Desktop app > Glyphs).

export type GlyphName =
  | 'today'
  | 'tray'
  | 'seal'
  | 'question'
  | 'clock'
  | 'trend-down'
  | 'trend-up'
  | 'star'
  | 'star-fill'
  | 'checklist'
  | 'activity'
  | 'gear'
  | 'search'
  | 'clear'
  | 'inspector'
  | 'options'
  | 'scan'
  | 'stop'
  | 'play'
  | 'download'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevrons'
  | 'check'
  | 'warning'
  | 'external'
  | 'setup'
  | 'key'
  | 'sparkle'
  | 'bell'
  | 'globe'
  | 'drive'
  | 'more';

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const PATHS: Record<GlyphName, React.ReactNode> = {
  today: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" {...S} />
      <path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5" {...S} />
      <rect x="5" y="8.5" width="2.5" height="2.5" rx="0.5" fill="currentColor" />
    </>
  ),
  tray: (
    <>
      <path d="M2.5 9.5l1.6-5.2A1.5 1.5 0 0 1 5.5 3.3h5a1.5 1.5 0 0 1 1.4 1L13.5 9.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12z" {...S} />
      <path d="M2.5 9.5h3l.8 1.5h3.4l.8-1.5h3" {...S} />
    </>
  ),
  seal: (
    <>
      <path d="M8 1.8l1.5 1.2 1.9-.2.6 1.8 1.6 1-.6 1.8.6 1.8-1.6 1-.6 1.8-1.9-.2L8 14.2l-1.5-1.2-1.9.2-.6-1.8-1.6-1 .6-1.8-.6-1.8 1.6-1 .6-1.8 1.9.2z" {...S} />
      <path d="M5.8 8.1l1.5 1.5 2.9-3" {...S} />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="6" {...S} />
      <path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4" {...S} />
      <circle cx="8" cy="11.3" r="0.8" fill="currentColor" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6" {...S} />
      <path d="M8 4.8V8l2.2 1.4" {...S} />
    </>
  ),
  'trend-down': (
    <>
      <path d="M2.5 4.5l4 4 2.2-2.2 4.8 4.8" {...S} />
      <path d="M13.5 7.5v3.6H9.9" {...S} />
    </>
  ),
  'trend-up': (
    <>
      <path d="M2.5 11.5l4-4 2.2 2.2 4.8-4.8" {...S} />
      <path d="M13.5 8.5V4.9H9.9" {...S} />
    </>
  ),
  star: <path d="M8.00 2.20L9.70 6.35L14.18 6.69L10.76 9.60L11.82 13.96L8.00 11.60L4.18 13.96L5.24 9.60L1.82 6.69L6.30 6.35z" {...S} />,
  'star-fill': <path d="M8.00 2.20L9.70 6.35L14.18 6.69L10.76 9.60L11.82 13.96L8.00 11.60L4.18 13.96L5.24 9.60L1.82 6.69L6.30 6.35z" {...S} fill="currentColor" />,
  checklist: (
    <>
      <path d="M2.5 4.2l1 1 1.8-2M2.5 9.2l1 1 1.8-2" {...S} />
      <path d="M7.5 4.5h6M7.5 9.5h6M7.5 13h6" {...S} />
    </>
  ),
  activity: <path d="M1.5 8h2.5l1.5-4 2.5 8 2-6 1.2 2h3.3" {...S} />,
  gear: (
    <>
      <circle cx="8" cy="8" r="2.1" {...S} />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" {...S} />
      <circle cx="8" cy="8" r="4.6" {...S} />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.3" {...S} />
      <path d="M10.2 10.2l3.3 3.3" {...S} />
    </>
  ),
  clear: (
    <>
      <circle cx="8" cy="8" r="6.5" fill="currentColor" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--content-bg)" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  inspector: (
    <>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" {...S} />
      <path d="M10 2.8v10.4" {...S} />
      <path d="M11.6 5.2h1M11.6 7.2h1" {...S} />
    </>
  ),
  options: (
    <>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" {...S} />
      <circle cx="10.5" cy="4.5" r="1.4" {...S} fill="var(--glyph-knock, var(--content-bg))" />
      <circle cx="5.5" cy="8" r="1.4" {...S} fill="var(--glyph-knock, var(--content-bg))" />
      <circle cx="9" cy="11.5" r="1.4" {...S} fill="var(--glyph-knock, var(--content-bg))" />
    </>
  ),
  scan: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" {...S} />
      <path d="M11.8 1.8v2.8H9" {...S} />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />,
  play: <path d="M5 3.5v9l7-4.5z" fill="currentColor" />,
  download: (
    <>
      <path d="M8 2v8M5 7l3 3 3-3" {...S} />
      <path d="M3 10.5V12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 12v-1.5" {...S} />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
    </>
  ),
  'chevron-down': <path d="M4.5 6.2L8 9.7l3.5-3.5" {...S} />,
  'chevron-right': <path d="M6.2 4.5L9.7 8l-3.5 3.5" {...S} />,
  chevrons: <path d="M5.5 6L8 3.5 10.5 6M5.5 10L8 12.5 10.5 10" {...S} />,
  check: <path d="M3.5 8.4l3 3 6-6.6" {...S} strokeWidth={1.7} />,
  warning: (
    <>
      <path d="M8 2.2l6 10.6H2z" {...S} />
      <path d="M8 6.5v2.8" {...S} />
      <circle cx="8" cy="11.1" r="0.75" fill="currentColor" />
    </>
  ),
  external: (
    <>
      <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" {...S} />
      <path d="M11.5 9.5v2.5a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5h2.5" {...S} />
    </>
  ),
  setup: (
    <>
      <circle cx="8" cy="8" r="6" {...S} />
      <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
    </>
  ),
  key: (
    <>
      <circle cx="5.2" cy="10.8" r="2.8" {...S} />
      <path d="M7.2 8.8L13 3M10.8 5.2l1.8 1.8M9 7l1.4 1.4" {...S} />
    </>
  ),
  sparkle: (
    <>
      <path d="M6.5 2.5l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3L2 7l3.3-1.2z" {...S} />
      <path d="M12 9.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" {...S} />
    </>
  ),
  bell: (
    <>
      <path d="M3.8 11.2h8.4c-.9-.9-1.3-2-1.3-3.2V6.6a2.9 2.9 0 0 0-5.8 0V8c0 1.2-.4 2.3-1.3 3.2z" {...S} />
      <path d="M6.6 13.2a1.5 1.5 0 0 0 2.8 0" {...S} />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" {...S} />
      <path d="M2 8h12M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14M8 2C6.2 3.7 5.3 5.7 5.3 8s.9 4.3 2.7 6" {...S} />
    </>
  ),
  drive: (
    <>
      <path d="M2.2 9.5l1.8-5.2a1.5 1.5 0 0 1 1.4-1h5.2a1.5 1.5 0 0 1 1.4 1l1.8 5.2v2.2a1.6 1.6 0 0 1-1.6 1.6H3.8a1.6 1.6 0 0 1-1.6-1.6z" {...S} />
      <path d="M2.2 9.5h11.6" {...S} />
      <circle cx="11.4" cy="11.4" r="0.7" fill="currentColor" />
    </>
  ),
};

export function Glyph({ name, size = 16, className }: { name: GlyphName; size?: number; className?: string }) {
  return (
    <svg className={`glyph${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
