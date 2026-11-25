// The real client: the agent on the same origin (127.0.0.1:8790; in `npm run ui:dev`, Vite proxies /api to it), every
// request with the app's bearer token. The desktop shell sets `window.__SPLIT_FINDER_TOKEN__` before the page loads;
// a plain browser in development reads it once from `?token=` (see docs/decisions.md, step 13, W7). The agent accepts
// the token only in the Authorization header, so even the event stream is read with fetch. Nothing here reads a key.

import { isApiError, type KeyValues } from '@core/api/contract';
import type * as C from '@core/api/contract';
import type { ApiClient } from './client';
import { mapActivity, mapDeals, mapDetail, mapEvent, mapReview, mapState, csvSort } from './map';
import { openEventStream } from './sse';
import { ApiError, type CostsView, type KeyName, type LookupsRun } from './types';
import { words } from '../lib/platform';

declare global {
  interface Window {
    __SPLIT_FINDER_TOKEN__?: string;
  }
}

const OFFLINE = `The agent is not running. Open Split Finder from the ${words.trayPlace} to start it.`;
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
    downloadAudit: () => saveAs('/api/export/audit', 'split-finder-audit.json'),
    resetScanData: async () => {
      const r = await call<{ backup: string }>('POST', '/api/data/reset', { confirm: 'RESET' });
      return { backup: r.backup };
    },
    downloadDealsCsv: ({ sort }) => saveAs(`/api/deals/export.csv?sort=${id(csvSort(sort))}`, 'split-finder-deals.csv'),

    review: async () => mapReview(await call<C.ReviewResponse>('GET', '/api/review')),
    answer: async (qid, answer, o) => {
      const body: C.ReviewAnswerBody = {
        answer, ...(o.fromSuggestion ? { fromSuggestion: true } : {}), ...(o.seen ? { seen: o.seen } : {}), ...(o.remember?.length ? { remember: o.remember } : {}),
      };
      const r = await call<C.AnswerResponse>('POST', `/api/review/${id(qid)}/answer`, body);
      return { answerId: r.answerId ?? null, ...(r.remembered ? { remembered: r.remembered } : {}) };
    },
    markNotSold: async (brand, model) => void (await call<C.FactResponse>('POST', '/api/facts', { brand, model, notSoldSeparately: true } satisfies C.FactBody)),
    forgetFact: async (key, field) => void (await call<C.FactResponse>('DELETE', `/api/facts/${id(key)}${field ? `?field=${field}` : ''}`)),
    undoAnswer: async (aid) => {
      const r = await call<C.UndoAnswerResponse>('POST', `/api/review/${id(aid)}/undo`, {});
      return { questionId: r.questionId };
    },
    // The agent answers `{ queued, reason? }`; core's QueuedResponse still says `queued: true`, so the body is read as a wider type.
    askAi: async (qid, o) => {
      const r = await call<{ queued: boolean; reason?: string; canForce?: unknown; costUsd?: unknown }>('POST', `/api/review/${id(qid)}/ask`, o?.force ? { force: true } : {});
      return {
        queued: r.queued !== false,
        ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason } : {}),
        ...(typeof r.canForce === 'boolean' ? { canForce: r.canForce } : {}),
        ...(typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? { costUsd: r.costUsd } : {}),
      };
    },
    askAll: async () => void (await call<C.QueuedResponse>('POST', '/api/review/ask-all', {})),
    approve: (ids) => call<C.ApproveResponse>('POST', '/api/review/approve', { ids } satisfies C.ApproveBody).then((r) => ({ approved: r.approved.length, skipped: r.skipped })),

    outcomes: () => call<C.OutcomesResponse>('GET', '/api/outcomes'),
    recordPurchase: (body) => call<C.PurchaseResponse>('POST', '/api/outcomes', body satisfies C.RecordPurchaseBody),
    editPurchase: (pid, patch) => call<C.PurchaseResponse>('PATCH', `/api/outcomes/${id(pid)}`, patch satisfies C.PurchasePatch),
    recordPart: (pid, partId, body) => call<C.PurchaseResponse>('POST', `/api/outcomes/${id(pid)}/parts/${id(partId)}`, body satisfies C.PartOutcomeBody),
    removePurchase: async (pid) => ({ entryId: (await call<{ removed: true; entryId: string }>('DELETE', `/api/outcomes/${id(pid)}`)).entryId }),
    undoOutcome: async (entryId) => void (await call<C.OutcomeUndoResponse>('POST', `/api/outcomes/entries/${id(entryId)}/undo`, {})),
    downloadOutcomesCsv: () => saveAs('/api/outcomes/export.csv', 'split-finder-outcomes.csv'),

    activity: async () => {
      const [raw, titles] = await Promise.all([call<C.ActivityResponse>('GET', '/api/activity'), titlesOfDeals()]);
      return mapActivity(raw, titles);
    },
    undo: async (aid) => void (await call('POST', `/api/autopilot/${id(aid)}/undo`, {})),
    retry: async (eid) => void (await call('POST', `/api/activity/errors/${id(eid)}/retry`, {})),

    scan: async () => void (await call<C.ScanStartResponse>('POST', '/api/scan', {})),
    readPagesAgain: () => call<{ started: boolean; reason?: string }>('POST', '/api/scan/read-pages', {}),
    runLookups: (body) => call<LookupsRun>('POST', '/api/lookups/run', body ?? {}),
    reloadHelper: async () => void (await call('POST', '/api/helper/reload', {})),
    dismissUpdate: async (version) => void (await call('POST', '/api/update/dismiss', { version })),
    stop: async () => void (await call('POST', '/api/scan/stop', {})),
    pause: async () => void (await call<C.PauseResponse>('POST', '/api/agent/pause', {})),
    resume: async () => void (await call<C.PauseResponse>('POST', '/api/agent/resume', {})),
    lookupQuote: async (dealId) => (await call<C.PaidResponse>('GET', `/api/deals/${id(dealId)}/lookup`)).searches,
    lookUp: async (dealId) => void (await call<C.PaidResponse>('POST', `/api/deals/${id(dealId)}/lookup`, {})),
    settleNeedsLook: async (dealId, clearKey, verdict) =>
      void (await call<C.NeedsLookResponse>('POST', `/api/deals/${id(dealId)}/needs-look`, { clearKey, verdict } satisfies C.NeedsLookBody)),
    verify: async (dealId, model) => void (await call<C.PaidResponse>('POST', `/api/deals/${id(dealId)}/verify`, { model })),
    confirmPrice: async (dealId, model, body) => void (await call<C.ConfirmPriceResponse>('POST', `/api/deals/${id(dealId)}/parts/${id(model)}/price`, body satisfies C.ConfirmPriceBody)),
    watch: async (dealId, watch) => void (await call<C.WatchResponse>('POST', `/api/deals/${id(dealId)}/watch`, { watch } satisfies C.WatchBody)),
    setBogo: async (dealId, body) => (await call<C.BogoResponse>('POST', `/api/deals/${id(dealId)}/bogo`, body satisfies C.BogoBody)).bogo,
    removeBogo: async (dealId) => void (await call<C.BogoResponse>('DELETE', `/api/deals/${id(dealId)}/bogo`)),
    priceFromLink: (url) => call<C.PriceFromLinkResponse>('POST', '/api/price-from-link', { url }),
    removePrice: async (dealId, model) => void (await call<C.ConfirmPriceResponse>('DELETE', `/api/deals/${id(dealId)}/parts/${id(model)}/price`)),

    settings: async () => (await call<C.SettingsResponse>('GET', '/api/settings')).settings,
    patchSettings: async (patch) => (await call<C.SettingsResponse>('PATCH', '/api/settings', patch)).settings,
    putKey: async <N extends KeyName>(name: N, value: KeyValues[N]) => (await call<C.PutKeyResponse>('PUT', `/api/keys/${name}`, value)).check,
    checkKey: async (name) => (await call<C.CheckKeyResponse>('POST', `/api/keys/${name}/check`, {})).check,
    deleteKey: async (name) => void (await call<C.KeysPresence>('DELETE', `/api/keys/${name}`)),

    costs: () => call<CostsView>('GET', '/api/costs'),
    // The agent saves what changed and answers with the settings; the view is asked for again, since the states and the forecast moved.
    patchCosts: async (patch) => {
      await call('PATCH', '/api/settings', { costs: patch });
      return call<CostsView>('GET', '/api/costs');
    },

    testNotification: async () => void (await call('POST', '/api/notify/test', {})),
    testTelegram: () => call<C.TelegramTestResponse>('POST', '/api/notify/test-telegram', {}),

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
