// A local stand-in for serpapi.com. /search.json is answered from the recorded responses,
// /account.json with the free-plan sample. It never forwards anything to the network.

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { SERPAPI_ACCOUNT_FREE } from '../core/test/fixtures';
import { replayRecorded } from '../scripts/replay';

export const GOOD_KEY = 'TEST';

const PAGES_DIR = new URL('../fixtures/homedepot-pages/', import.meta.url);
const recordedPages = new Map(
  (JSON.parse(readFileSync(new URL('pages-2026-11-10.json', PAGES_DIR), 'utf8')) as { pages: { itemId: string; text: string }[] }).pages.map((p) => [
    p.itemId,
    p.text,
  ]),
);
const refusedPage = readFileSync(new URL('refused-2026-11-10.html', PAGES_DIR), 'utf8');
// type="text/plain" so the tab does not run the recorded text: after the state object the fixtures replace every
// letter and digit with x, which is not valid JavaScript. The reader looks at the text, not at what ran.
const html = (script: string): string =>
  `<!doctype html><html><head><title>Product</title></head><body><script type="text/plain">${script}</script></body></html>`;

export interface ReplayServer {
  url: string;
  /** Requests received so far, by path. */
  counts: Record<string, number>;
  /** cacheKey of every search received, in order. */
  searches: string[];
  /** Searches that had no recording and got the 404. */
  misses: string[];
  /** Item ids of the /p/<id> pages requested so far, in order. */
  pageRequests: string[];
  /** These ids are answered 403 with the recorded refused page, until reset(). '*' refuses every id. */
  refuse(...itemIds: string[]): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startReplayServer(port: number): Promise<ReplayServer> {
  let replay = replayRecorded();
  const counts: Record<string, number> = {};
  let misses: string[] = [];
  let pageRequests: string[] = [];
  const refused = new Set<string>();
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      counts[url.pathname] = (counts[url.pathname] ?? 0) + 1;
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
      if (req.method !== 'GET') {
        res.writeHead(405, headers).end('{}');
      } else if (url.pathname === '/search.json') {
        const r = await replay.fetchFn(`http://localhost${req.url}`);
        if (r.status === 404) misses.push(url.search);
        res.writeHead(r.status, headers).end(await r.text());
      } else if (url.pathname === '/account.json') {
        if (url.searchParams.get('api_key') === GOOD_KEY) res.writeHead(200, headers).end(JSON.stringify(SERPAPI_ACCOUNT_FREE));
        else res.writeHead(401, headers).end(JSON.stringify({ error: 'Invalid API key.' }));
      } else if (url.pathname === '/favicon.ico') {
        // Chrome asks for it when the reader's tab loads.
        res.writeHead(204).end();
      } else if (url.pathname.startsWith('/p/')) {
        // Home Depot's product pages. A recorded id answers with its recorded script; a refused id with the
        // recorded refusal; any other id with a page whose state holds no product (the reader calls it unreadable).
        const id = url.pathname.slice(3);
        pageRequests.push(id);
        const page = { 'content-type': 'text/html; charset=utf-8' };
        if (refused.has('*') || refused.has(id)) res.writeHead(403, page).end(refusedPage);
        else res.writeHead(200, page).end(html(recordedPages.get(id) ?? 'window.__APOLLO_STATE__={}'));
      } else {
        res.writeHead(404, headers).end(JSON.stringify({ error: 'Not found' }));
      }
    })();
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  return {
    url: `http://localhost:${port}`,
    counts,
    get misses() {
      return misses;
    },
    get searches() {
      return replay.calls;
    },
    get pageRequests() {
      return pageRequests;
    },
    refuse(...ids) {
      for (const id of ids) refused.add(id);
    },
    reset() {
      pageRequests = [];
      refused.clear();
      for (const k of Object.keys(counts)) delete counts[k];
      replay = replayRecorded();
      misses = [];
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
