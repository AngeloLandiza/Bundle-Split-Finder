// Small things a menu item does: copy text, open a page. Each says whether it worked, so the screen can tell him.

import { inShell, invokeShell } from './shell';
import { webUrl } from './webUrl';

/** Copies text to the clipboard. False when the webview refuses (no permission, no focus). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every web link in the page goes through openPage: a click on an <a href="http…"> (written by any screen) is taken
 * here, so no link can be a dead end inside the app window. Installed once per window (main.tsx).
 */
export function routeLinkClicks(doc: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    openPage(href);
  };
  doc.addEventListener('click', onClick);
  return () => doc.removeEventListener('click', onClick);
}

/** Opens a web page outside the app (the shell sends it to the default browser). Only a web address (lib/webUrl.ts). */
export function openPage(url: string | null | undefined): boolean {
  const href = webUrl(url);
  if (!href) return false;
  // Inside the app a link does nothing by itself: the shell hands it to the default browser (open_external).
  if (inShell()) void invokeShell('open_external', { url: href }).catch(() => undefined);
  else window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

/** The page that searches Amazon for a part, for a part with no listing chosen. */
export function amazonSearchUrl(brand: string, model: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(`${brand} ${model}`)}`;
}

export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}
