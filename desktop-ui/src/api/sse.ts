// A small server-sent-events reader. EventSource cannot send the bearer token, so the real
// client reads /api/events with fetch and feeds the text through this parser.

export interface SseMessage {
  event: string;
  data: string;
}

/** Feeds chunks in; calls `emit` for every complete message. Keeps a partial message between chunks. */
export function createSseParser(emit: (m: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) emit({ event, data: data.join('\n') });
      end = buffer.indexOf('\n\n');
    }
  };
}

/** How long to wait before reconnect number `attempt` (0 is the first): 1 s, 2 s, 4 s ... never more than 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

/** The agent pings every 20 s; a stream silent for this long is dead and is reopened. */
export const STREAM_SILENCE_MS = 60_000;

export interface StreamOptions {
  url: string;
  /** Called on every (re)connect, so a token that arrives late is picked up. */
  headers: () => HeadersInit;
  onMessage: (m: SseMessage) => void;
  /** 'live' once a connection is accepted; 'down' each time it ends or fails. */
  onStatus: (s: 'live' | 'down') => void;
  fetchFn?: typeof fetch;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One server-sent-events subscription that stays up: it reads `url` with fetch (EventSource cannot send the bearer
 * token, and the agent accepts it only in the Authorization header), reconnects with a growing wait, and reopens a
 * stream that has gone silent. Returns the unsubscribe.
 */
export function openEventStream(o: StreamOptions): () => void {
  const abort = new AbortController();
  const doFetch = o.fetchFn ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  void (async () => {
    let attempt = 0;
    while (!abort.signal.aborted) {
      const conn = new AbortController();
      const stop = () => conn.abort();
      abort.signal.addEventListener('abort', stop, { once: true });
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const arm = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(stop, STREAM_SILENCE_MS);
      };
      try {
        const res = await doFetch(o.url, { headers: o.headers(), signal: conn.signal });
        if (!res.ok || !res.body) throw new Error('no stream');
        o.onStatus('live');
        arm();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const feed = createSseParser(o.onMessage);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          attempt = 0;
          arm();
          feed(value);
        }
      } catch {
        // The wait below is the whole handling: a dropped or refused stream is retried.
      } finally {
        if (watchdog) clearTimeout(watchdog);
        abort.signal.removeEventListener('abort', stop);
      }
      if (abort.signal.aborted) return;
      o.onStatus('down');
      await sleep(backoffMs(attempt++));
    }
  })();
  return () => abort.abort();
}
