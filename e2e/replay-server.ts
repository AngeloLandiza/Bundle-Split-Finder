// A local stand-in for serpapi.com. /search.json is answered from the recorded responses,
// /account.json with the free-plan sample. It never forwards anything to the network.

import { createServer, type Server } from 'node:http';
import { SERPAPI_ACCOUNT_FREE } from '../core/test/fixtures';
import { replayRecorded } from '../scripts/replay';

export const GOOD_KEY = 'TEST';

export interface ReplayServer {
  url: string;
  /** Requests received so far, by path. */
  counts: Record<string, number>;
  /** cacheKey of every search received, in order. */
  searches: string[];
  /** Searches that had no recording and got the 404. */
  misses: string[];
  reset(): void;
  close(): Promise<void>;
}

export async function startReplayServer(port: number): Promise<ReplayServer> {
  let replay = replayRecorded();
  const counts: Record<string, number> = {};
  let misses: string[] = [];
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
    reset() {
      for (const k of Object.keys(counts)) delete counts[k];
      replay = replayRecorded();
      misses = [];
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
