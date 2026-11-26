// The page viewer, seen from the app's pages (docs/design.md, Desktop app > Page viewer): which pages of a deal its
// toolbar offers, how its address field splits an address, and where a click on a link goes.

import { linkDestination } from '@core/links/viewerPolicy';
import type { OpenLinksIn } from './linkPrefs';
import { webUrl } from './webUrl';

/** One of a deal's source pages, as the viewer's page pop-up lists it (src-tauri viewer/model.rs ContextPage). */
export interface ViewerPage {
  label: string;
  url: string;
}

/** What the viewer was opened from (src-tauri viewer/model.rs Context). */
export interface ViewerContext {
  title: string;
  pages: ViewerPage[];
}

export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}

/** The page that searches Amazon for a part, for a part with no listing chosen. */
export function amazonSearchUrl(brand: string, model: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(`${brand} ${model}`)}`;
}

interface DealLike {
  title: string;
  brand: string;
  model: string;
  link: string | null;
  parts: readonly { model: string; asin: string | null; unnamed: boolean }[];
}

/**
 * A deal's source pages, in the inspector's order: the bundle on Home Depot, then each part's Amazon listing, or
 * Amazon's search for a part with none. A charger with no model number has no page. Each model once.
 */
export function dealPages(d: DealLike): ViewerContext {
  const pages: ViewerPage[] = [];
  const hd = webUrl(d.link);
  if (hd && linkDestination(hd) === 'viewer') pages.push({ label: `Home Depot · ${d.model}`, url: hd });
  const seen = new Set<string>();
  for (const p of d.parts) {
    if (p.unnamed || seen.has(p.model.toUpperCase())) continue;
    seen.add(p.model.toUpperCase());
    pages.push(p.asin ? { label: `Amazon · ${p.model}`, url: amazonUrl(p.asin) } : { label: `Amazon search · ${p.model}`, url: amazonSearchUrl(d.brand, p.model) });
  }
  return { title: d.title, pages };
}

/** The address field: the real host, prominent, and the rest of the address, quieter. */
export function addressParts(url: string | null | undefined): { host: string; rest: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { host: '', rest: url };
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    return { host: u.host, rest };
  } catch {
    return { host: '', rest: url };
  }
}

export type LinkTarget = 'viewer' | 'browser' | 'none';

/**
 * Where a click on a link goes. Not a web address: nowhere. Cmd-click (Ctrl-click on Windows), "In my browser", a page
 * not on the viewer's list, or no app around the page (the browser dev mode): the default browser.
 */
export function linkTarget(url: string | null | undefined, o: { prefer: OpenLinksIn; browserKey: boolean; inShell: boolean }): LinkTarget {
  const href = webUrl(url);
  if (!href) return 'none';
  if (!o.inShell || o.browserKey || o.prefer === 'browser') return 'browser';
  return linkDestination(href);
}
