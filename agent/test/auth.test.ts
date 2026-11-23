import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Auth, PAIR_REQUEST_TTL_MS } from '../auth';
import { Store } from '../store';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT}`;

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

function setup(now = () => 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-auth-'));
  store = Store.open(dir);
  return { dir, auth: new Auth(store, { dataDir: dir, port: 8790, now }) };
}

function pairOnce(auth: Auth): string {
  const req = auth.requestPairing(EXT, ORIGIN);
  if ('code' in req && !('claimSecret' in req)) throw new Error(req.message);
  const ok = req as { requestId: string; claimSecret: string };
  expect(auth.decide(ok.requestId, true)).toBe(true);
  const claimed = auth.claim(ok.requestId, ok.claimSecret, ORIGIN);
  if (!('status' in claimed) || claimed.status !== 'approved') throw new Error('not approved');
  return claimed.token;
}

describe('agent auth', () => {
  it('writes the app token once, owner-only, and keeps it across restarts', () => {
    const { dir, auth } = setup();
    const file = join(dir, 'agent-token');
    expect(readFileSync(file, 'utf8').trim()).toBe(auth.uiToken);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new Auth(store!, { dataDir: dir, port: 8790 }).uiToken).toBe(auth.uiToken);
  });

  it('accepts only its own Host, so a rebinding DNS name is refused', () => {
    const { auth } = setup();
    expect(auth.hostAllowed('127.0.0.1:8790')).toBe(true);
    expect(auth.hostAllowed('localhost:8790')).toBe(true);
    expect(auth.hostAllowed('evil.example:8790')).toBe(false);
    expect(auth.hostAllowed('127.0.0.1:9999')).toBe(false);
    expect(auth.hostAllowed(undefined)).toBe(false);
  });

  it('knows the app token and nothing else', () => {
    const { auth } = setup();
    expect(auth.authenticate(`Bearer ${auth.uiToken}`)).toEqual({ kind: 'ui' });
    expect(auth.authenticate('Bearer nope')).toBeNull();
    expect(auth.authenticate(auth.uiToken)).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
  });

  it('ties an Origin to its token: the app origin to the app, an extension origin to that extension', () => {
    const { auth } = setup();
    const ui = { kind: 'ui' } as const;
    const ext = { kind: 'extension', extensionId: EXT } as const;
    expect(auth.originAllowed(undefined, ui)).toBe(true);
    expect(auth.originAllowed('http://127.0.0.1:8790', ui)).toBe(true);
    expect(auth.originAllowed('https://evil.example', ui)).toBe(false);
    expect(auth.originAllowed(ORIGIN, ui)).toBe(false);
    expect(auth.originAllowed(ORIGIN, ext)).toBe(true);
    expect(auth.originAllowed('chrome-extension://pppppppppppppppppppppppppppppppp', ext)).toBe(false);
    expect(auth.originAllowed('http://127.0.0.1:8790', ext)).toBe(false);
  });

  it('pairs: request, the owner allows, the claim returns a token once that then authenticates', () => {
    const { auth } = setup();
    const req = auth.requestPairing(EXT, ORIGIN) as { requestId: string; claimSecret: string; code: string };
    expect(req.code).toMatch(/^\d{6}$/);
    expect(auth.pendingRequests().map((r) => r.extensionId)).toEqual([EXT]);
    expect(auth.claim(req.requestId, req.claimSecret, ORIGIN)).toEqual({ status: 'pending' });
    auth.decide(req.requestId, true);
    const claimed = auth.claim(req.requestId, req.claimSecret, ORIGIN) as { status: string; token: string };
    expect(claimed.status).toBe('approved');
    expect(auth.authenticate(`Bearer ${claimed.token}`)).toEqual({ kind: 'extension', extensionId: EXT });
    // The token is not stored, only its hash, and the request is gone.
    expect(JSON.stringify(store!.get('pairing'))).not.toContain(claimed.token);
    expect(auth.claim(req.requestId, req.claimSecret, ORIGIN)).toMatchObject({ code: 'not_found' });
  });

  it('refuses pairing from a web page, a wrong id, or a claim without the secret', () => {
    const { auth } = setup();
    expect(auth.requestPairing(EXT, 'https://evil.example')).toMatchObject({ code: 'forbidden' });
    expect(auth.requestPairing(EXT, undefined)).toMatchObject({ code: 'forbidden' });
    expect(auth.requestPairing('not-an-id', ORIGIN)).toMatchObject({ code: 'bad_request' });
    const req = auth.requestPairing(EXT, ORIGIN) as { requestId: string };
    auth.decide(req.requestId, true);
    expect(auth.claim(req.requestId, 'guess', ORIGIN)).toMatchObject({ code: 'forbidden' });
  });

  it('a denied request says so once; an expired one is gone', () => {
    let now = 1_000_000;
    const { auth } = setup(() => now);
    const denied = auth.requestPairing(EXT, ORIGIN) as { requestId: string; claimSecret: string };
    auth.decide(denied.requestId, false);
    expect(auth.claim(denied.requestId, denied.claimSecret, ORIGIN)).toEqual({ status: 'denied' });
    const late = auth.requestPairing(EXT, ORIGIN) as { requestId: string; claimSecret: string };
    now += PAIR_REQUEST_TTL_MS + 1;
    expect(auth.decide(late.requestId, true)).toBe(false);
    expect(auth.claim(late.requestId, late.claimSecret, ORIGIN)).toMatchObject({ code: 'not_found' });
  });

  it('revoking an extension makes its token worthless; pairing again replaces the old token', () => {
    const { auth } = setup();
    const first = pairOnce(auth);
    const second = pairOnce(auth);
    expect(auth.authenticate(`Bearer ${first}`)).toBeNull();
    expect(auth.pairedExtensions()).toHaveLength(1);
    expect(auth.revoke(EXT)).toBe(true);
    expect(auth.authenticate(`Bearer ${second}`)).toBeNull();
    expect(auth.revoke(EXT)).toBe(false);
  });

  it('answers CORS only for the app and paired extensions (any extension while pairing)', () => {
    const { auth } = setup();
    expect(auth.corsOrigin('https://evil.example')).toBeNull();
    expect(auth.corsOrigin(ORIGIN)).toBeNull();
    expect(auth.corsOrigin(ORIGIN, { pairing: true })).toBe(ORIGIN);
    pairOnce(auth);
    expect(auth.corsOrigin(ORIGIN)).toBe(ORIGIN);
  });
});
