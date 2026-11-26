// Where a link opens (docs/design.md, Desktop app > Page viewer): in the app's own page viewer, or in the default
// browser. The viewer is for reading a deal's source pages; it is not his browser. He is not signed in there and a
// password should never be typed into it, so any page that may ask him to sign in or pay goes to the browser.
//
// Addresses come from stored data (Home Depot reads, Amazon and eBay listings, links he typed) and are untrusted: only
// `https`, only the exact hosts below, only the page kinds below, may open in the viewer as its first page. Anything
// else, including an address that does not parse, goes to the browser (which the shell checks again before opening).
//
// The same list is in the shell (src-tauri/src/viewer/policy.rs, VIEWER_SITES); core/test/viewer-policy.test.ts fails
// when the two differ.

export type LinkDestination = 'viewer' | 'browser';

export interface ViewerSite {
  /** The site's name as the viewer's toolbar says it ("Home Depot · PSK1212SB"). */
  name: string;
  /** Exact host names. No wildcard: `amazon.com.evil.example` and `smile.amazon.com` are not Amazon here. */
  hosts: readonly string[];
  // Path prefixes of the pages that may open in the viewer. A leading "/*" stands for one path segment, so
  // "/*" + "/dp/" matches Amazon's "/<title words>/dp/<ASIN>"; "/s" is Amazon's search page exactly.
  paths: readonly string[];
  /** Keepa's product pages live in the fragment ("#!product/1-B0C3YBY7CD"): a required fragment prefix, if any. */
  hash?: string;
}

// VIEWER_SITES begin (kept in step with src-tauri/src/viewer/policy.rs)
export const VIEWER_SITES: readonly ViewerSite[] = [
  { name: 'Home Depot', hosts: ['www.homedepot.com', 'homedepot.com'], paths: ['/p/', '/s/', '/b/', '/c/', '/collection/'] },
  { name: 'Amazon', hosts: ['www.amazon.com', 'amazon.com'], paths: ['/dp/', '/gp/product/', '/*/dp/', '/s'] },
  { name: 'Keepa', hosts: ['keepa.com', 'www.keepa.com'], paths: ['/'], hash: '#!product/' },
  { name: 'eBay', hosts: ['www.ebay.com', 'ebay.com'], paths: ['/itm/'] },
];
// VIEWER_SITES end

function pathMatches(path: string, prefix: string): boolean {
  if (prefix === '/s') return path === '/s' || path.startsWith('/s/');
  if (prefix === '/') return path === '/';
  if (prefix.startsWith('/*/')) {
    const rest = prefix.slice(2); // "/dp/"
    const second = path.indexOf('/', 1);
    return second > 1 && path.slice(second).startsWith(rest);
  }
  return path.startsWith(prefix);
}

/** The parsed address when it may be the viewer's first page, else null. */
export function viewerPage(url: string | null | undefined): { href: string; site: ViewerSite } | null {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  // A control character or a space anywhere: the parser would quietly drop or encode it; nothing stored needs one.
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\u0000- \u007f\\]/.test(text)) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  const host = u.hostname.toLowerCase();
  const site = VIEWER_SITES.find((s) => s.hosts.includes(host));
  if (!site) return null;
  if (!site.paths.some((p) => pathMatches(u.pathname, p))) return null;
  if (site.hash !== undefined && !u.hash.startsWith(site.hash)) return null;
  return { href: u.href, site };
}

/** Where a link opens: the app's viewer for a source page on the list, the default browser for anything else. */
export function linkDestination(url: string | null | undefined): LinkDestination {
  return viewerPage(url) ? 'viewer' : 'browser';
}

/** "Home Depot", "Amazon": the site of a viewer page, or null for any other address. */
export function siteName(url: string | null | undefined): string | null {
  return viewerPage(url)?.site.name ?? null;
}
