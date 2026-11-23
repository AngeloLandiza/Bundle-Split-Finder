// The real client: the agent on the same origin (127.0.0.1:8790; in `npm run ui:dev`, Vite proxies /api to it), every
// request with the app's bearer token. The desktop shell sets `window.__SPLIT_FINDER_TOKEN__` before the page loads;
// a plain browser in development reads it once from `?token=` (see docs/decisions.md, step 13, W7). The agent accepts
// the token only in the Authorization header, so even the event stream is read with fetch. Nothing here reads a key.

import { isApiError, type KeyValues } from '@core/api/contract';
import type * as C from '@core/api/contract';
import type { ApiClient } from './client';
import { mapActivity, mapDeals, mapDetail, mapEvent, mapReview, mapState, csvSort } from './map';
import { openEventStream } from './sse';
import { ApiError, type KeyName } from './types';

declare global {
  interface Window {
    __SPLIT_FINDER_TOKEN__?: string;
  }
}

const OFFLINE = 'The agent is not running. Open Split Finder from the menu bar to start it.';
const DENIED = 'The app is not allowed to reach the agent. Restart Split Finder.';
const DEV_TOKEN_KEY = 'splitFinder.devToken';

/**
 * The app's token: the shell's, else (development only) the one given as `?token=` once and kept for the tab.
 * It is taken off the address at once so it is never shown or copied with the link.
 */
export function readToken(): string {
  if (typeof window === 'undefined') return '';
  const shell = window.__SPLIT_FINDER_TOKEN__;
  if (shell) return shell;
  if (!import.meta.env.DEV) return '';
  try {
    const url = new URL(window.location.href);
    const given = url.searchParams.get('token');
    if (given) {
      sessionStorage.setItem(DEV_TOKEN_KEY, given);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    return sessionStorage.getItem(DEV_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${readToken()}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** The sentence a failed answer carries, in the agent's error shape or none. */
async function failure(res: Response): Promise<ApiError> {
  let message: string | null = null;
  try {
    const body: unknown = await res.json();
    if (isApiError(body)) message = body.error.message;
  } catch {
    // no body: the status says it
  }
  if (res.status === 401 || res.status === 403) return new ApiError('unauthorized', DENIED);
  return new ApiError(res.status === 409 ? 'refused' : 'server', message ?? 'The agent could not do that. Try again.');
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('offline', OFFLINE);
  }
  if (!res.ok) throw await failure(res);
  return res;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Saves a file the agent answers with (the token cannot ride a plain link). */
async function saveAs(path: string, fallbackName: string): Promise<void> {
  const res = await send('GET', path);
  const named = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = named ?? fallbackName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const id = (s: string) => encodeURIComponent(s);

/** The question open on this bundle, from the review list (the deal detail does not carry it). Never fails the detail. */
async function questionOn(dealId: string): Promise<string | null> {
  try {
    const r = await call<C.ReviewResponse>('GET', '/api/review');
    return r.questions.find((q) => q.bundleId === dealId)?.id ?? null;
  } catch {
    return null;
  }
}

/** Bundle titles for the activity's Autopilot rows. Never fails the activity. */
async function titlesOfDeals(): Promise<Map<string, { title: string; model: string }>> {
  try {
    const r = await call<C.DealsResponse>('GET', '/api/deals');
    return new Map(r.rows.map((x) => [x.id, { title: x.bundle.title, model: x.bundle.model }]));
  } catch {
    return new Map();
  }
}

export function createHttpClient(): ApiClient {
  return {
    state: async () => mapState(await call<C.AgentState>('GET', '/api/state')),
    deals: async () => mapDeals(await call<C.DealsResponse>('GET', '/api/deals')),
    deal: async (dealId) => {
      const [detail, questionId] = await Promise.all([call<C.DealDetail>('GET', `/api/deals/${id(dealId)}`), questionOn(dealId)]);
      return mapDetail(detail, questionId);
    },
    downloadDealsCsv: ({ sort }) => saveAs(`/api/deals/export.csv?sort=${id(csvSort(sort))}`, 'split-finder-deals.csv'),

    review: async () => mapReview(await call<C.ReviewResponse>('GET', '/api/review')),
    answer: async (qid, answer, o) => {
      const body: C.ReviewAnswerBody = { answer, ...(o.fromSuggestion ? { fromSuggestion: true } : {}), ...(o.seen ? { seen: o.seen } : {}) };
      await call<C.AnswerResponse>('POST', `/api/review/${id(qid)}/answer`, body);
    },
    ask: async (qid) => void (await call<C.QueuedResponse>('POST', `/api/review/${id(qid)}/ask`, {})),
    askAll: async () => void (await call<C.QueuedResponse>('POST', '/api/review/ask-all', {})),
    approve: (ids) => call<C.ApproveResponse>('POST', '/api/review/approve', { ids } satisfies C.ApproveBody).then((r) => ({ approved: r.approved.length, skipped: r.skipped })),

    activity: async () => {
      const [raw, titles] = await Promise.all([call<C.ActivityResponse>('GET', '/api/activity'), titlesOfDeals()]);
      return mapActivity(raw, titles);
    },
    undo: async (aid) => void (await call('POST', `/api/autopilot/${id(aid)}/undo`, {})),
    retry: async (eid) => void (await call('POST', `/api/activity/errors/${id(eid)}/retry`, {})),

    scan: async () => void (await call<C.ScanStartResponse>('POST', '/api/scan', {})),
    stop: async () => void (await call('POST', '/api/scan/stop', {})),
    pause: async () => void (await call<C.PauseResponse>('POST', '/api/agent/pause', {})),
    resume: async () => void (await call<C.PauseResponse>('POST', '/api/agent/resume', {})),
    lookupQuote: async (dealId) => (await call<C.PaidResponse>('GET', `/api/deals/${id(dealId)}/lookup`)).searches,
    lookUp: async (dealId) => void (await call<C.PaidResponse>('POST', `/api/deals/${id(dealId)}/lookup`, {})),
    verify: async (dealId, model) => void (await call<C.PaidResponse>('POST', `/api/deals/${id(dealId)}/verify`, { model })),

    settings: async () => (await call<C.SettingsResponse>('GET', '/api/settings')).settings,
    patchSettings: async (patch) => (await call<C.SettingsResponse>('PATCH', '/api/settings', patch)).settings,
    putKey: async <N extends KeyName>(name: N, value: KeyValues[N]) => void (await call<C.KeysPresence>('PUT', `/api/keys/${name}`, value)),
    deleteKey: async (name) => void (await call<C.KeysPresence>('DELETE', `/api/keys/${name}`)),

    pairRequests: () => call<C.PendingPairRequest[]>('GET', '/api/pair/requests'),
    decidePairing: async (requestId, allow) => void (await call('POST', allow ? '/api/pair/approve' : '/api/pair/deny', { requestId } satisfies C.PairDecisionBody)),
    pairedExtensions: () => call<C.PairedExtension[]>('GET', '/api/pair/extensions'),
    revokeExtension: async (extensionId) => void (await call('DELETE', `/api/pair/extensions/${id(extensionId)}`)),
    installExtension: () => call<C.InstallExtensionResponse>('POST', '/api/setup/install-extension', {}),

    subscribe(onEvent, onStatus) {
      return openEventStream({
        url: '/api/events',
        headers: () => headers(false),
        onStatus,
        onMessage: (m) => {
          try {
            const e = mapEvent(m.event, JSON.parse(m.data));
            if (e) onEvent(e);
          } catch {
            // A malformed message is dropped; the next state event carries everything again.
          }
        },
      });
    },
  };
}
