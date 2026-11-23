// Small things a menu item does: copy text, open a page. Each says whether it worked, so the screen can tell him.

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

/** Opens a web page outside the app (the shell sends it to the default browser). Only a web address (lib/webUrl.ts). */
export function openPage(url: string | null | undefined): boolean {
  const href = webUrl(url);
  if (!href) return false;
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

/** The page that searches Amazon for a part, for a part with no listing chosen. */
export function amazonSearchUrl(brand: string, model: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(`${brand} ${model}`)}`;
}

export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}
