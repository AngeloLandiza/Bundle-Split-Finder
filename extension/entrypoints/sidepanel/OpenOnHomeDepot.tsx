/** The link to a bundle's own Home Depot page: Detail's top bar and Review's parts question share it. */
export function OpenOnHomeDepot({ href, className = '' }: { href: string; className?: string }) {
  return (
    <a className={`detail-open ${className}`.trim()} href={href} target="_blank" rel="noopener noreferrer">
      Open on Home Depot
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4.5 2.5h5v5M9.5 2.5l-7 7" />
      </svg>
    </a>
  );
}
