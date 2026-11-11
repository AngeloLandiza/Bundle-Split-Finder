import { NETWORK_ERROR_PREFIX } from '@core/serpapi/client';

/** The client's text for a search SerpApi answered with an HTTP error it has no words for (core/src/serpapi/client.ts). */
const HTTP_ERROR = /^SerpApi returned HTTP (\d+)\.$/;

/**
 * Every SerpApi problem the extension shows goes through here, so a network failure always reads the same, and an
 * HTTP error is said in words. SerpApi's own sentences (a key it did not accept, a limit) pass as they are.
 * `closing` ends the offline sentence: "retry" beside a Retry button, "try again" where there is none.
 */
export function sentenceFor(raw: string | null | undefined, closing: 'retry' | 'try again' = 'retry'): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw.startsWith(NETWORK_ERROR_PREFIX)) return `SerpApi could not be reached. Check the connection, then ${closing}.`;
  const http = HTTP_ERROR.exec(raw);
  return http ? `SerpApi answered with an error (HTTP ${http[1]}). Try again later.` : raw;
}
