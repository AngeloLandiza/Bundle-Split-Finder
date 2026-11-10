// Which messages the service worker answers.

/**
 * True for a message sent by one of this extension's own pages (settings, side panel).
 * A content script's message carries the web page's URL, and another extension's carries
 * its own id, so both are refused.
 */
export function isOwnPage(sender: { id?: string; url?: string }, runtimeId: string): boolean {
  return sender.id === runtimeId && typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${runtimeId}/`);
}
