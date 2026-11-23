// Who may talk to the agent (step 13, Decision 2). Two kinds of caller hold a bearer token: the app
// (the desktop webview and the shell), whose token is <dataDir>/agent-token, and each paired Chrome
// extension, whose token it got from pairing. The agent keeps only a hash of an extension's token.
// Host must be the agent's own loopback address (no DNS rebinding); a browser Origin must be the
// app's own or the paired extension's.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  UI_TOKEN_FILE,
  type PairClaimResponse,
  type PairedExtension,
  type PairRequestResponse,
  type PendingPairRequest,
} from '../core/src/api/contract';
import { writeFileAtomic, type Store } from './store';

export type Principal = { kind: 'ui' } | { kind: 'extension'; extensionId: string };

export const PAIR_REQUEST_TTL_MS = 10 * 60_000;
export const MAX_PENDING_PAIR_REQUESTS = 5;
/** lastSeenAt is written to disk at most this often per extension. */
const SEEN_WRITE_MS = 60_000;

const EXTENSION_ID = /^[a-p]{32}$/;

export function isExtensionId(id: unknown): id is string {
  return typeof id === 'string' && EXTENSION_ID.test(id);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(x, y);
}

/** Reads the app's token, creating it (owner-only) on the first start. */
export function loadUiToken(dataDir: string): string {
  const path = join(dataDir, UI_TOKEN_FILE);
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) return token;
  }
  const token = newToken();
  writeFileAtomic(path, `${token}\n`, 0o600);
  return token;
}

export type PairError = { code: 'bad_request' | 'forbidden' | 'not_found' | 'conflict'; message: string };

export interface AuthOptions {
  dataDir: string;
  port: number;
  /** Extra origins allowed to act as the app, e.g. a Vite dev server (SPLIT_FINDER_UI_ORIGINS). */
  extraUiOrigins?: string[];
  now?: () => number;
}

export class Auth {
  readonly uiToken: string;
  private readonly hosts: ReadonlySet<string>;
  private readonly uiOrigins: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly seenWritten = new Map<string, number>();
  private readonly seenAt = new Map<string, number>();

  constructor(
    private readonly store: Store,
    opts: AuthOptions,
  ) {
    this.uiToken = loadUiToken(opts.dataDir);
    this.now = opts.now ?? Date.now;
    this.hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
    this.uiOrigins = new Set([
      `http://127.0.0.1:${opts.port}`,
      `http://localhost:${opts.port}`,
      ...(opts.extraUiOrigins ?? []),
    ]);
  }

  /**
   * The shell's challenge before it trusts whatever listens on the port (GET /api/hello): proof that this process holds
   * the token file's secret, without giving the secret or anything that stands in for it. Domain-separated, so the
   * answer is no use anywhere else. Null for a nonce that is not 32 to 128 url-safe characters.
   */
  helloProof(nonce: unknown): string | null {
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) return null;
    return createHmac('sha256', this.uiToken).update(`split-finder-hello:${nonce}`).digest('hex');
  }

  // ------------------------------------------------------------ request checks

  hostAllowed(host: string | undefined): boolean {
    return typeof host === 'string' && this.hosts.has(host.toLowerCase());
  }

  /** The caller a bearer header names, or null. */
  authenticate(authorization: string | undefined): Principal | null {
    if (!authorization?.startsWith('Bearer ')) return null;
    const token = authorization.slice('Bearer '.length).trim();
    if (!token) return null;
    if (sameSecret(token, this.uiToken)) return { kind: 'ui' };
    const hash = sha256(token);
    const ext = this.store.get('pairing').extensions.find((e) => e.tokenHash === hash);
    return ext ? { kind: 'extension', extensionId: ext.extensionId } : null;
  }

  /**
   * A request with no Origin comes from outside a browser (the shell) or is a same-origin GET; its
   * token decides. With an Origin, the app's origins go with the app's token and an extension's
   * origin only with that extension's own token.
   */
  originAllowed(origin: string | undefined, principal: Principal): boolean {
    if (origin === undefined) return true;
    if (principal.kind === 'ui') return this.uiOrigins.has(origin);
    return origin === `chrome-extension://${principal.extensionId}`;
  }

  /** The Origin a CORS preflight may be answered for: the app's, or a paired extension's. */
  corsOrigin(origin: string | undefined, opts: { pairing?: boolean } = {}): string | null {
    if (!origin) return null;
    if (this.uiOrigins.has(origin)) return origin;
    const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
    if (!m) return null;
    if (opts.pairing) return origin;
    return this.store.get('pairing').extensions.some((e) => e.extensionId === m[1]) ? origin : null;
  }

  /** Notes that a paired extension was just heard from. */
  touch(extensionId: string): void {
    const now = this.now();
    this.seenAt.set(extensionId, now);
    if (now - (this.seenWritten.get(extensionId) ?? 0) < SEEN_WRITE_MS) return;
    this.seenWritten.set(extensionId, now);
    const at = new Date(now).toISOString();
    this.store.update('pairing', (p) => ({
      ...p,
      extensions: p.extensions.map((e) => (e.extensionId === extensionId ? { ...e, lastSeenAt: at } : e)),
    }));
  }

  /** When any paired extension was last heard from (this run, else as stored). */
  lastSeen(): number | null {
    let best: number | null = null;
    for (const t of this.seenAt.values()) best = best === null ? t : Math.max(best, t);
    if (best !== null) return best;
    for (const e of this.store.get('pairing').extensions) {
      const t = e.lastSeenAt ? Date.parse(e.lastSeenAt) : NaN;
      if (Number.isFinite(t)) best = best === null ? t : Math.max(best, t);
    }
    return best;
  }

  // ------------------------------------------------------------ pairing

  private liveRequests() {
    const now = this.now();
    return this.store.get('pairing').requests.filter((r) => Date.parse(r.expiresAt) > now);
  }

  /** An unpaired extension asks to pair. Its Origin must be its own id. */
  requestPairing(extensionId: unknown, origin: string | undefined): PairRequestResponse | PairError {
    if (!isExtensionId(extensionId)) return { code: 'bad_request', message: 'extensionId is not a Chrome extension id.' };
    if (origin !== `chrome-extension://${extensionId}`) {
      return { code: 'forbidden', message: 'Pairing is asked for from the extension itself.' };
    }
    const live = this.liveRequests().filter((r) => r.extensionId !== extensionId);
    if (live.filter((r) => r.status === 'pending').length >= MAX_PENDING_PAIR_REQUESTS) {
      return { code: 'conflict', message: 'Too many pairing requests are waiting. Answer them in the app first.' };
    }
    const now = this.now();
    const claimSecret = newToken();
    const request = {
      requestId: `pair-${randomBytes(8).toString('hex')}`,
      extensionId,
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      claimSecretHash: sha256(claimSecret),
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIR_REQUEST_TTL_MS).toISOString(),
      status: 'pending' as const,
    };
    this.store.update('pairing', (p) => ({ ...p, requests: [...live, request] }));
    return { requestId: request.requestId, code: request.code, claimSecret, expiresAt: request.expiresAt };
  }

  pendingRequests(): PendingPairRequest[] {
    return this.liveRequests()
      .filter((r) => r.status === 'pending')
      .map(({ requestId, extensionId, code, requestedAt, expiresAt }) => ({ requestId, extensionId, code, requestedAt, expiresAt }));
  }

  /** The owner allows or refuses a request (app only). False when there is no such pending request. */
  decide(requestId: string, allow: boolean): boolean {
    const live = this.liveRequests();
    const found = live.find((r) => r.requestId === requestId && r.status === 'pending');
    if (!found) return false;
    const status = allow ? ('approved' as const) : ('denied' as const);
    this.store.update('pairing', (p) => ({
      ...p,
      requests: live.map((r) => (r.requestId === requestId ? { ...r, status } : r)),
    }));
    return true;
  }

  /** The extension collects the answer. An approved claim returns its token once, and never again. */
  claim(requestId: unknown, claimSecret: unknown, origin: string | undefined): PairClaimResponse | PairError {
    if (typeof requestId !== 'string' || typeof claimSecret !== 'string') {
      return { code: 'bad_request', message: 'requestId and claimSecret are needed.' };
    }
    const live = this.liveRequests();
    const request = live.find((r) => r.requestId === requestId);
    if (!request) return { code: 'not_found', message: 'This pairing request has expired. Ask again from the extension.' };
    if (origin !== `chrome-extension://${request.extensionId}` || sha256(claimSecret) !== request.claimSecretHash) {
      return { code: 'forbidden', message: 'This claim does not come from the extension that asked.' };
    }
    if (request.status === 'pending') return { status: 'pending' };
    const rest = live.filter((r) => r.requestId !== requestId);
    if (request.status === 'denied') {
      this.store.update('pairing', (p) => ({ ...p, requests: rest }));
      return { status: 'denied' };
    }
    const token = newToken();
    const paired = {
      extensionId: request.extensionId,
      pairedAt: new Date(this.now()).toISOString(),
      lastSeenAt: null,
      tokenHash: sha256(token),
    };
    this.store.update('pairing', (p) => ({
      extensions: [...p.extensions.filter((e) => e.extensionId !== request.extensionId), paired],
      requests: rest,
    }));
    return { status: 'approved', token, extensionId: request.extensionId };
  }

  pairedExtensions(): PairedExtension[] {
    return this.store.get('pairing').extensions.map(({ extensionId, pairedAt, lastSeenAt }) => ({ extensionId, pairedAt, lastSeenAt }));
  }

  /** Revokes an extension's token. False when it was not paired. */
  revoke(extensionId: string): boolean {
    const before = this.store.get('pairing');
    if (!before.extensions.some((e) => e.extensionId === extensionId)) return false;
    this.store.update('pairing', (p) => ({ ...p, extensions: p.extensions.filter((e) => e.extensionId !== extensionId) }));
    this.seenAt.delete(extensionId);
    this.seenWritten.delete(extensionId);
    return true;
  }
}
