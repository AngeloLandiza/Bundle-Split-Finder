// Calls to the Split Finder app on this computer (core/src/api/contract.ts). Every call carries the pairing token; a 401 means the
// app no longer knows this browser, so the token is dropped at once and the link says why. A failure is a plain sentence, never a
// stack or the token. fetch is injected: the real one in the extension, a fake in the tests.

import type { ApiErrorBody } from '@core/api/contract';
import { AGENT_ORIGIN, NOTICE_REVOKED, NOTICE_UNREACHABLE, type LinkStore } from './agentLink';

export type AgentReply<T> =
  | { ok: true; status: number; data: T }
  /** unpaired: there is no token, or the app refused it (the link is unpaired now). unreachable: the app is not running. refused: any other answer. */
  | { ok: false; kind: 'unpaired' | 'unreachable' | 'refused'; status: number; message: string };

export interface AgentApi {
  get<T>(path: string, opts?: { signal?: AbortSignal }): Promise<AgentReply<T>>;
  post<T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<AgentReply<T>>;
}

export interface AgentApiDeps {
  fetchFn: typeof fetch;
  store: Pick<LinkStore, 'getToken' | 'unpair'>;
}

/** The sentence in an error body (ApiErrorBody), or the status in words. */
export async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    const m = body.error?.message;
    if (typeof m === 'string' && m !== '') return m;
  } catch {
    // Not JSON.
  }
  return `The Split Finder app answered ${res.status}.`;
}

export function createAgentApi(deps: AgentApiDeps): AgentApi {
  async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<AgentReply<T>> {
    const token = await deps.store.getToken();
    if (token === null) return { ok: false, kind: 'unpaired', status: 0, message: NOTICE_REVOKED };
    let res: Response;
    try {
      res = await deps.fetchFn(`${AGENT_ORIGIN}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch {
      return { ok: false, kind: 'unreachable', status: 0, message: NOTICE_UNREACHABLE };
    }
    if (res.status === 401) {
      await deps.store.unpair(NOTICE_REVOKED);
      return { ok: false, kind: 'unpaired', status: 401, message: NOTICE_REVOKED };
    }
    if (!res.ok) return { ok: false, kind: 'refused', status: res.status, message: await errorMessage(res) };
    if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
    try {
      return { ok: true, status: res.status, data: (await res.json()) as T };
    } catch {
      return { ok: false, kind: 'refused', status: res.status, message: 'The Split Finder app sent something this panel cannot read.' };
    }
  }
  return {
    get: (path, opts) => call('GET', path, undefined, opts?.signal),
    post: (path, body, opts) => call('POST', path, body ?? {}, opts?.signal),
  };
}
