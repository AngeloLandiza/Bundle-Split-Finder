// The real client: the agent on the same origin (127.0.0.1:8790), every request with the
// pairing token the shell sets before load (`window.__SPLIT_FINDER_TOKEN__`). Paths follow the
// step 13 contract outline; W7 wires it once W1's router is in. Nothing here ever reads a key.

import type { ApiClient } from './client';
import { createSseParser } from './sse';
import { ApiError, type AgentEvent, type KeyName } from './types';

declare global {
  interface Window {
    __SPLIT_FINDER_TOKEN__?: string;
  }
}

const OFFLINE = 'The agent is not running. Open Split Finder from the menu bar to start it.';

function token(): string {
  return typeof window !== 'undefined' ? (window.__SPLIT_FINDER_TOKEN__ ?? '') : '';
}

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${token()}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('offline', OFFLINE);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('unauthorized', 'The app is not allowed to reach the agent. Restart Split Finder.');
  }
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (parsed as { message?: string } | undefined)?.message;
    throw new ApiError(res.status === 409 ? 'refused' : 'server', message ?? 'The agent could not do that. Try again.');
  }
  return parsed as T;
}

const id = (s: string) => encodeURIComponent(s);

export function createHttpClient(): ApiClient {
  return {
    state: () => call('GET', '/api/state'),
    deals: () => call('GET', '/api/deals'),
    deal: (dealId) => call('GET', `/api/deals/${id(dealId)}`),
    dealsCsvUrl: ({ section, sort }) => `/api/deals/export.csv?sort=${id(sort)}${section ? `&section=${id(section)}` : ''}`,

    review: () => call('GET', '/api/review'),
    answer: (qid, answer, fromAi) => call('POST', `/api/review/${id(qid)}/answer`, { answer, fromAi }),
    ask: (qid) => call('POST', `/api/review/${id(qid)}/ask`, {}),
    askAll: () => call('POST', '/api/review/ask-all', {}),
    approve: (ids) => call('POST', '/api/review/approve', { ids }),

    activity: () => call('GET', '/api/activity'),
    undo: (aid) => call('POST', `/api/autopilot/${id(aid)}/undo`, {}),
    retry: (eid) => call('POST', `/api/activity/errors/${id(eid)}/retry`, {}),

    scan: () => call('POST', '/api/scan', {}),
    stop: () => call('POST', '/api/scan/stop', {}),
    pause: () => call('POST', '/api/agent/pause', {}),
    resume: () => call('POST', '/api/agent/resume', {}),
    lookUp: (dealId) => call('POST', `/api/deals/${id(dealId)}/lookup`, {}),
    verify: (dealId, model) => call('POST', `/api/deals/${id(dealId)}/verify`, { model }),

    settings: () => call('GET', '/api/settings'),
    patchSettings: (patch) => call('PATCH', '/api/settings', patch),
    putKey: (name: KeyName, value: string) => call('PUT', `/api/keys/${name}`, { value }),
    deleteKey: (name: KeyName) => call('DELETE', `/api/keys/${name}`),

    approvePairing: () => call('POST', '/api/pair/approve', {}),
    revokePairing: () => call('POST', '/api/pair/revoke', {}),

    subscribe(onEvent, onDown) {
      const abort = new AbortController();
      void (async () => {
        try {
          const res = await fetch('/api/events', { headers: headers(false), signal: abort.signal });
          if (!res.ok || !res.body) throw new Error('no stream');
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          const feed = createSseParser((m) => {
            try {
              onEvent(JSON.parse(m.data) as AgentEvent);
            } catch {
              // A malformed message is dropped; the next one carries the full state again.
            }
          });
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            feed(value);
          }
          if (!abort.signal.aborted) onDown();
        } catch {
          if (!abort.signal.aborted) onDown();
        }
      })();
      return () => abort.abort();
    },
  };
}
