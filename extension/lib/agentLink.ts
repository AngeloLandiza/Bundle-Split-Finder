// The link between this browser and the Split Finder app (step 13, Decisions 1, 2 and 4): where the app is, what the pairing
// state is, and where the pairing token is kept. The token is a secret like the SerpApi key: chrome.storage.local only
// (restrictKeyAccess keeps content scripts out), never logged, never shown, sent only to the app on this computer.
// Nothing here touches chrome.* except browserKv; the rest takes a KeyValue so the tests use a Map.

import { browser } from 'wxt/browser';

/** Where the agent listens (core/src/api/contract.ts AGENT_PORT). The manifest's host permission is this address. */
export const AGENT_ORIGIN = 'http://127.0.0.1:8790';

/** What the owner sees. `pairing`: the code is shown in the panel and in the app, and the app has not answered yet. */
export type AgentLink =
  | { status: 'unpaired'; notice: string | null }
  | { status: 'pairing'; code: string; expiresAt: number }
  | { status: 'paired'; since: number; lastJobAt: number | null };

export const UNPAIRED: AgentLink = { status: 'unpaired', notice: null };

export const NOTICE_UNREACHABLE = 'Could not reach the Split Finder app. Open the app, then connect again.';
export const NOTICE_DENIED = 'The app did not allow this browser. Connect again to try once more.';
export const NOTICE_EXPIRED = 'The code ran out before it was approved. Connect again for a new one.';
export const NOTICE_REVOKED = 'The Split Finder app no longer recognises this browser. Connect again.';
export const NOTICE_DISCONNECTED = 'Disconnected. Scans, answers and keys are in this browser again.';

/** "482913" is said as "482 913". */
export function spokenCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** The two things a page may ask the background to do about the link. Everything else it reads from storage. */
export type AgentLinkRequest = { type: 'agentConnect' } | { type: 'agentDisconnect' };
const LINK_REQUESTS: readonly string[] = ['agentConnect', 'agentDisconnect'];
export const isAgentLinkRequest = (v: unknown): v is AgentLinkRequest =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' && LINK_REQUESTS.includes((v as { type: string }).type);

export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function browserKv(): KeyValue {
  const local = () => browser.storage.local;
  return {
    get: async (key) => (await local().get(key))[key],
    set: (key, value) => local().set({ [key]: value }),
    remove: (key) => local().remove(key),
  };
}

export const LINK_KEY = 'agentLink';
const TOKEN = 'agentToken';
const PENDING = 'agentPairing';

/** A pairing the app has not answered: what POST /api/pair/claim needs. The secret never leaves this store but for that call. */
export interface PendingPairing {
  requestId: string;
  claimSecret: string;
  code: string;
  expiresAt: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface LinkStore {
  readLink(): Promise<AgentLink>;
  writeLink(link: AgentLink): Promise<void>;
  getToken(): Promise<string | null>;
  getPending(): Promise<PendingPairing | null>;
  setPending(p: PendingPairing): Promise<void>;
  /** Paired: the token is kept and the link says so. Any pairing in progress ends. */
  pair(token: string, at: number): Promise<void>;
  /** Back to unpaired with a sentence (or none): the token and any pairing in progress are forgotten. */
  unpair(notice: string | null): Promise<void>;
  /** The time of the last job this browser finished for the app. No-op when unpaired. */
  markJob(at: number): Promise<void>;
}

export function createLinkStore(kv: KeyValue = browserKv()): LinkStore {
  const getToken = async (): Promise<string | null> => {
    const v = await kv.get(TOKEN);
    return typeof v === 'string' && v !== '' ? v : null;
  };
  const writeLink = (link: AgentLink): Promise<void> => kv.set(LINK_KEY, link);
  const readLink = async (): Promise<AgentLink> => {
    // A stored state is read as untrusted: only a whole, known shape counts, and "paired" needs the token it stands for.
    const v = await kv.get(LINK_KEY);
    if (!isRecord(v)) return UNPAIRED;
    if (v.status === 'paired') {
      if ((await getToken()) === null) return UNPAIRED;
      return { status: 'paired', since: typeof v.since === 'number' ? v.since : 0, lastJobAt: typeof v.lastJobAt === 'number' ? v.lastJobAt : null };
    }
    if (v.status === 'pairing' && typeof v.code === 'string' && typeof v.expiresAt === 'number') return { status: 'pairing', code: v.code, expiresAt: v.expiresAt };
    return { status: 'unpaired', notice: typeof v.notice === 'string' ? v.notice : null };
  };
  return {
    readLink,
    writeLink,
    getToken,
    async getPending() {
      const v = await kv.get(PENDING);
      if (!isRecord(v)) return null;
      const { requestId, claimSecret, code, expiresAt } = v;
      return typeof requestId === 'string' && typeof claimSecret === 'string' && typeof code === 'string' && typeof expiresAt === 'number' ? { requestId, claimSecret, code, expiresAt } : null;
    },
    async setPending(p) {
      await kv.set(PENDING, p);
      await writeLink({ status: 'pairing', code: p.code, expiresAt: p.expiresAt });
    },
    async pair(token, at) {
      await kv.set(TOKEN, token);
      await kv.remove(PENDING);
      await writeLink({ status: 'paired', since: at, lastJobAt: null });
    },
    async unpair(notice) {
      await kv.remove(TOKEN);
      await kv.remove(PENDING);
      await writeLink({ status: 'unpaired', notice });
    },
    async markJob(at) {
      const link = await readLink();
      if (link.status === 'paired') await writeLink({ ...link, lastJobAt: at });
    },
  };
}
