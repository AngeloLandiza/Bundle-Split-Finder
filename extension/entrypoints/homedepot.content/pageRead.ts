// What the content script reads from the Home Depot page: which product it is, and the page's own
// embedded state. Nothing is fetched; the page is already in the document.

const STATE_MARK = 'window.__APOLLO_STATE__=';

/**
 * The item id in a product page's path: the last path segment of /p/<slug>/<itemId> (or /p/<itemId>),
 * digits only. Null for any other path.
 */
export function itemIdOf(pathname: string): string | null {
  const m = /^\/p\/(?:[^/]+\/)*(\d{6,12})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/** The text of the inline script that holds `window.__APOLLO_STATE__=`; null when the document has none. */
export function stateTextOf(doc: Document): string | null {
  for (const script of doc.scripts) {
    if (script.src !== '') continue;
    const text = script.textContent ?? '';
    if (text.includes(STATE_MARK)) return text;
  }
  return null;
}
