// Small things a menu item does: copy text, open a page. Each says whether it worked, so the screen can tell him.

import { linkContextOf } from './linkContext';
import { readLinkPrefs } from './linkPrefs';
import { isMac } from './platform';
import { inShell, invokeShell } from './shell';
import { linkTarget, type ViewerContext } from './viewer';
import { webUrl } from './webUrl';

export { amazonSearchUrl, amazonUrl } from './viewer';

/** Copies text to the clipboard. False when the webview refuses (no permission, no focus). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Cmd-click on a Mac, Ctrl-click on Windows: the default browser, as in every Mac and Windows app. */
export const isBrowserClick = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => (isMac ? e.metaKey : e.ctrlKey);

/** The web link under an event's target, with its address, or null. */
function linkAt(target: EventTarget | null): { a: HTMLAnchorElement; href: string } | null {
  const a = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a) return null;
  const href = a.getAttribute('href') ?? '';
  if (!/^https?:\/\//i.test(href)) return null;
  return { a, href };
}

/**
 * Every web link in the page goes through openPage: a click on an <a href="http…"> (written by any screen) is taken
 * here, so no link can be a dead end inside the app window. Installed once per window (main.tsx). It listens in the
 * capture phase, so a link inside a row that stops the click's propagation still opens.
 */
export function routeLinkClicks(doc: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
    const link = linkAt(e.target);
    if (!link) return;
    e.preventDefault();
    openPage(link.href, { browser: e.button === 1 || isBrowserClick(e), context: linkContextOf(link.a) });
  };
  // A middle click on a link is "open elsewhere" in every browser: here, the default browser.
  const onAux = (e: MouseEvent) => {
    if (e.button === 1 && linkAt(e.target)) onClick(e);
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onAux, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onAux, true);
  };
}

/** The menu a right-click on a web link offers (components/ContextMenu.tsx `LinkMenu`). */
export function linkMenuAt(target: EventTarget | null): { href: string; context: ViewerContext | undefined } | null {
  const link = linkAt(target);
  return link ? { href: link.href, context: linkContextOf(link.a) } : null;
}

/** A click on a source page opens the app's viewer (inside the app, with "In Split Finder" chosen). Menus use it. */
export const linksOpenInViewer = (): boolean => inShell() && readLinkPrefs().openLinksIn === 'app';

/** A menu's page item: open the page (where a click would), open it in the browser, or copy its address. */
export async function pageAction(kind: 'open' | 'browser' | 'copy', url: string | null | undefined, context?: ViewerContext): Promise<boolean> {
  const href = webUrl(url);
  if (!href) return false;
  if (kind === 'copy') return copyText(href);
  return openPage(href, { browser: kind === 'browser', context });
}

/** Opens the default browser, whatever the setting. */
function openInBrowser(href: string): void {
  if (inShell()) void invokeShell('open_external', { url: href }).catch(() => undefined);
  else window.open(href, '_blank', 'noopener,noreferrer');
}

/**
 * Opens a web page: in the app's page viewer when it is one of the listed source pages and Settings say "In Split
 * Finder", else in the default browser (docs/design.md, Desktop app > Page viewer). `context` is the deal it belongs
 * to, whose other pages the viewer then offers. `browser`: the default browser whatever the setting (Cmd-click, the
 * menu's Open in browser). False when the address is not a web address.
 */
export function openPage(url: string | null | undefined, o: { browser?: boolean; context?: ViewerContext | undefined } = {}): boolean {
  const href = webUrl(url);
  if (!href) return false;
  const target = linkTarget(href, { prefer: readLinkPrefs().openLinksIn, browserKey: o.browser === true, inShell: inShell() });
  if (target === 'viewer') {
    const context = o.context && o.context.pages.length > 0 ? o.context : undefined;
    // The shell checks the address again; if it refuses, the browser still opens the page.
    void invokeShell('viewer_open', { url: href, context: context ?? null }).catch(() => openInBrowser(href));
  } else {
    openInBrowser(href);
  }
  return true;
}
