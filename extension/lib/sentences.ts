import { NETWORK_ERROR_PREFIX } from '@core/serpapi/client';

/** The client's text for a search SerpApi answered with an HTTP error it has no words for (core/src/serpapi/client.ts). */
const HTTP_ERROR = /^SerpApi returned HTTP (\d+)\.$/;
/** The same text inside a longer message (a lookup that failed, several sentences joined). */
const HTTP_ERROR_INSIDE = /SerpApi returned HTTP (\d+)\./g;
/**
 * The network-error text: the client's prefix, a colon, then the runtime's own words (`err.message`, unpunctuated and
 * possibly holding dots, such as a host name). It runs to the next sentence end (a period and a space) or the string's end.
 */
const NETWORK_BODY = `${NETWORK_ERROR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^.]|\\.(?!\\s))*\\.?`;
const NETWORK_INSIDE = new RegExp(NETWORK_BODY, 'g');
const NETWORK_WHOLE = new RegExp(`^${NETWORK_BODY}$`);

/**
 * Every SerpApi problem the extension shows goes through here, so a network failure always reads the same, and an
 * HTTP error is said in words. SerpApi's own sentences (a key it did not accept, a limit) pass as they are.
 * `closing` ends the offline sentence: "retry" beside a Retry button, "try again" where there is none.
 */
export function sentenceFor(raw: string | null | undefined, closing: 'retry' | 'try again' = 'retry'): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (NETWORK_WHOLE.test(raw)) return `SerpApi could not be reached. Check the connection, then ${closing}.`;
  const http = HTTP_ERROR.exec(raw);
  if (http) return `SerpApi answered with an error (HTTP ${http[1]}). Try again later.`;
  // Inside a longer message, only SerpApi's text is replaced; the sentences around it stay.
  return raw.replace(HTTP_ERROR_INSIDE, 'SerpApi answered with an error (HTTP $1).').replace(NETWORK_INSIDE, 'SerpApi could not be reached.');
}
