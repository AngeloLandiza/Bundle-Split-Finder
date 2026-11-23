// Pairing this browser with the Split Finder app (step 13, Decision 2). The owner clicks Connect; the app is asked for a
// six-digit code (POST /api/pair/request, whose Origin is this extension's own), the code is shown here and in the app, the
// owner approves it there, and the claim (POST /api/pair/claim) hands back the token once. Both calls carry no token; the claim
// carries the secret only this browser holds. Polls back off from 1.5 s to 10 s and end on approval, refusal or expiry.

import type { PairClaimResponse, PairRequestResponse } from '@core/api/contract';
import {
  AGENT_ORIGIN,
  NOTICE_DENIED,
  NOTICE_DISCONNECTED,
  NOTICE_EXPIRED,
  NOTICE_UNREACHABLE,
  type AgentLink,
  type LinkStore,
} from './agentLink';
import { errorMessage } from './agentApi';

/** Waits between claims: quick at first, then every 10 s until the code runs out. */
const CLAIM_DELAYS_MS = [1500, 2000, 3000, 4000, 5000, 7000, 10_000];

export interface PairingDeps {
  fetchFn: typeof fetch;
  store: LinkStore;
  /** This extension's id (chrome.runtime.id); the agent checks it against the request's Origin. */
  extensionId: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The token was kept: start working. */
  onPaired: () => void;
}

export interface Pairing {
  /** Asks the app for a code and starts waiting for the owner's answer. Resolves at once with the new link; the wait goes on. */
  start(): Promise<AgentLink>;
  /** Picks a pairing left waiting (the worker slept or restarted) up again. Nothing waiting, or already waiting: nothing. */
  resume(): Promise<void>;
  /** Cancels a pairing in progress, or forgets the token. The app keeps listing this browser until the owner removes it there. */
  disconnect(): Promise<void>;
  /** Resolves when the wait that is running ends (tests). */
  idle(): Promise<void>;
}

async function post<T>(deps: PairingDeps, path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await deps.fetchFn(`${AGENT_ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, message: NOTICE_UNREACHABLE };
  }
  if (!res.ok) return { ok: false, status: res.status, message: await errorMessage(res) };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status, message: 'The Split Finder app sent something this browser cannot read.' };
  }
}

export function createPairing(deps: PairingDeps): Pairing {
  const { store } = deps;
  let waiting: Promise<void> | null = null;

  /** Claims until the app answers. Every pass reads the stored pairing again, so a Cancel in between ends it. */
  async function wait(): Promise<void> {
    for (let pass = 0; ; pass++) {
      await deps.sleep(CLAIM_DELAYS_MS[Math.min(pass, CLAIM_DELAYS_MS.length - 1)]!);
      const pending = await store.getPending();
      if (pending === null) return;
      if (deps.now() >= pending.expiresAt) return void (await store.unpair(NOTICE_EXPIRED));
      const reply = await post<PairClaimResponse>(deps, '/api/pair/claim', { requestId: pending.requestId, claimSecret: pending.claimSecret });
      if (!reply.ok) {
        // Not running right now: the code may still be good when the app comes back. Anything else the app said ends it.
        if (reply.status === 0) continue;
        return void (await store.unpair(reply.status === 404 ? NOTICE_EXPIRED : reply.message));
      }
      const claim = reply.data;
      if (claim.status === 'pending') continue;
      if (claim.status === 'denied') return void (await store.unpair(NOTICE_DENIED));
      if (claim.status === 'approved' && typeof claim.token === 'string' && claim.token !== '') {
        await store.pair(claim.token, deps.now());
        deps.onPaired();
        return;
      }
      return void (await store.unpair('The Split Finder app answered something this browser did not expect. Connect again.'));
    }
  }

  function keepWaiting(): void {
    if (waiting !== null) return;
    waiting = wait()
      .catch(() => store.unpair('Something went wrong while connecting. Connect again.'))
      .finally(() => {
        waiting = null;
      });
  }

  return {
    async start() {
      const link = await store.readLink();
      if (link.status === 'paired') return link;
      if (link.status === 'pairing' && link.expiresAt > deps.now() && (await store.getPending()) !== null) {
        keepWaiting();
        return link;
      }
      const reply = await post<PairRequestResponse>(deps, '/api/pair/request', { extensionId: deps.extensionId });
      if (!reply.ok) {
        await store.unpair(reply.message);
        return store.readLink();
      }
      const { requestId, code, claimSecret, expiresAt } = reply.data;
      const expires = Date.parse(expiresAt);
      if (typeof requestId !== 'string' || typeof code !== 'string' || typeof claimSecret !== 'string' || !Number.isFinite(expires)) {
        await store.unpair('The Split Finder app answered something this browser did not expect. Connect again.');
        return store.readLink();
      }
      await store.setPending({ requestId, claimSecret, code, expiresAt: expires });
      keepWaiting();
      return store.readLink();
    },
    async resume() {
      const link = await store.readLink();
      if (link.status !== 'pairing') return;
      if (link.expiresAt <= deps.now() || (await store.getPending()) === null) {
        await store.unpair(NOTICE_EXPIRED);
        return;
      }
      keepWaiting();
    },
    async disconnect() {
      const link = await store.readLink();
      await store.unpair(link.status === 'paired' ? NOTICE_DISCONNECTED : null);
    },
    idle: async () => {
      while (waiting !== null) await waiting;
    },
  };
}
