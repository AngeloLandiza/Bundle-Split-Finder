// Which messages the service worker answers.

export interface Sender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

/**
 * True for a message sent by one of this extension's own pages (settings, side panel).
 * A content script's message carries the web page's URL, and another extension's carries
 * its own id, so both are refused.
 */
export function isOwnPage(sender: Sender, runtimeId: string): boolean {
  return sender.id === runtimeId && typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${runtimeId}/`);
}

/**
 * True for a message sent by this extension's own content script on a web page: it carries the tab it runs in
 * (a number), this extension's id, and the web page's URL, which is not an extension page's.
 */
export function isOwnContentScript(sender: Sender, runtimeId: string): boolean {
  return sender.id === runtimeId && typeof sender.tab?.id === 'number' && typeof sender.url === 'string' && !sender.url.startsWith('chrome-extension://');
}

/**
 * Whether the worker answers this sender's request. The extension's own pages may ask anything. Its content script may
 * send only the messages in `contentRequests` (the chip's), so a script on a web page cannot reach the key or a scan
 * even if it found a way to speak through the content script.
 */
export function mayAsk(sender: Sender, runtimeId: string, requestType: unknown, contentRequests: readonly string[]): boolean {
  if (isOwnPage(sender, runtimeId)) return true;
  return isOwnContentScript(sender, runtimeId) && typeof requestType === 'string' && contentRequests.includes(requestType);
}
