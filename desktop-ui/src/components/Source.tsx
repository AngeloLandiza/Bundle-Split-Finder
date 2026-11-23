import type { Quote as QuoteData, Source } from '../api/types';
import './Source.css';

/** A source's link, only when it is a web address (http or https). */
export function webUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Every price, match and question links to where it came from ("Home Depot page", "Amazon listing"). */
export function SourceLink({ source, children }: { source: Source; children?: React.ReactNode }) {
  const href = webUrl(source.url);
  if (!href) return <span className="source source-plain">{children ?? source.label}</span>;
  return (
    <a className="source" href={href} target="_blank" rel="noopener noreferrer">
      {children ?? source.label}
    </a>
  );
}

/** A short verbatim line in ink-2, its source at the end of the same line. */
export function Quote({ quote, clamp = false }: { quote: QuoteData; clamp?: boolean }) {
  return (
    <p className={`quote${clamp ? ' quote-clamp' : ''}`}>
      <q title={quote.text}>{quote.text}</q> <SourceLink source={quote.source} />
    </p>
  );
}
