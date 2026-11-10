// A fetch function that answers SerpApi search requests from the nine responses
// recorded in fixtures/recorded/. It never opens a socket, so a pipeline driven through
// the real SerpApiClient over it spends nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cacheKey, type Params } from '../core/src/serpapi/client';
import { REQUESTS } from './fixture-requests';
import { ROOT } from './node-store';

export interface Replay {
  fetchFn: typeof fetch;
  /** cacheKey of every /search.json request received, in order. */
  calls: string[];
}

export function replayRecorded(): Replay {
  const calls: string[] = [];
  const byKey = new Map(REQUESTS.map((r) => [cacheKey(r.params), r.name]));

  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!url.pathname.endsWith('/search.json')) return json({ error: `No recording for ${url.pathname}` }, 404);

    const params: Params = {};
    for (const [k, v] of url.searchParams) if (k !== 'api_key') params[k] = v;
    const key = cacheKey(params);
    calls.push(key);

    const name = byKey.get(key);
    if (name === undefined) return json({ error: `No recording for ${key}` }, 404);
    return new Response(readFileSync(join(ROOT, 'fixtures', 'recorded', `${name}.json`), 'utf8'), { status: 200 });
  }) as typeof fetch;

  return { fetchFn, calls };
}
