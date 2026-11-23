// Small things a menu item does: copy text, open a page. Each says whether it worked, so the screen can tell him.

/** Copies text to the clipboard. False when the webview refuses (no permission, no focus). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Opens a web page outside the app (the shell sends it to the default browser). Only http and https. */
export function openPage(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    window.open(u.href, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

/** The page that searches Amazon for a part, for a part with no listing chosen. */
export function amazonSearchUrl(brand: string, model: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(`${brand} ${model}`)}`;
}

export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}
